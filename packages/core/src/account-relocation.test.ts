// A moved account store, read by this build. Nothing in production writes
// a forwarding pointer, a moved-store (`sourceKind: 'generation'`) journal or
// a management tombstone yet, so the moved store here is built by hand, the
// way the move will build it: a byte copy of the old generation's
// `config.json` and `state.json`, with only the generation settings key
// rewritten through the store. The stores are the genuine embedded
// common-auth store on a real disk.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  type AccountMigrationJournal,
  accountMigrationDurability,
  accountStorePointerPath,
  assertLegacyAccountStorageWritable,
  createAccountMigrationFactory,
  createAccountRollbackFactory,
  decodeAccountMigrationJournal,
  decodeAccountStoreGeneration,
  decodeAccountStorePointer,
  decodeAccountStorePointerRecord,
  initializeFreshAccountStore,
  readAccountStoreAdmission,
  readAccountStoreBinding,
  resolveAccountStoreAnchor,
  resolveAccountStorePaths,
} from './account-migration.ts'
import { createAccountRepositoryFactory } from './account-repository.ts'
import {
  isValidProviderState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from './account-repository-codecs.ts'
import {
  ACCOUNT_STORE_PROVIDER,
  type AccountStorePaths,
  type AccountTokenExchange,
  MANAGEMENT_SETTINGS_KEY,
} from './account-repository-types.ts'
import { loadCommonAuthStoreModules } from './common-auth-runtime.ts'

const GENERATION_KEY = 'antigravityGeneration'

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
/** Sorted-key JSON, the encoding the migration hashes its manifest with. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const EMPTY_MANIFEST = {
  sourceVersion: null,
  normalizationClock: 1,
  accounts: [],
  routing: { schemaVersion: 1 as const },
  effectiveActiveIndex: 0,
}
const EMPTY_MANIFEST_SHA256 = sha256(canonical(EMPTY_MANIFEST))

let modules: Awaited<ReturnType<typeof loadCommonAuthStoreModules>>
beforeAll(async () => {
  modules = await loadCommonAuthStoreModules()
})

/** The genuine store, opened for reads and settings writes only. */
function rawStore(paths: AccountStorePaths) {
  return modules.store.openPoolStore({
    provider: ACCOUNT_STORE_PROVIDER,
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: QUOTA_CODEC,
    providerState: {
      validate: isValidProviderState,
      credentialBound: providerStateCredentialBound,
      merge() {
        throw new Error('the fixture store writes no credentials')
      },
      onReplace() {
        throw new Error('the fixture store writes no credentials')
      },
    },
    requireCredentialStamps: true,
    now: () => Date.now(),
  })
}
async function rowsOf(paths: AccountStorePaths) {
  const read = await rawStore(paths).read()
  if (read.status !== 'ready') throw new Error(`store is ${read.status}`)
  return read.rows
}
async function settingsOf(paths: AccountStorePaths) {
  const read = await rawStore(paths).readSettings()
  if (read.status !== 'ready') throw new Error(`settings are ${read.status}`)
  return read.settings
}
function without(settings: Record<string, unknown>, ...keys: string[]) {
  const copy = { ...settings }
  for (const key of keys) delete copy[key]
  return copy
}
async function writePrivate(path: string, bytes: string | Uint8Array) {
  await writeFile(path, bytes, { mode: 0o600 })
}
async function privateDirectories(paths: AccountStorePaths) {
  for (const dir of [
    paths.storeDir,
    paths.backupsDir,
    paths.retiredDir,
    paths.transfersDir,
  ])
    await mkdir(dir, { mode: 0o700 })
}
function forwardJson(
  oldAnchor: string,
  oldId: string,
  newAnchor: string,
  newId: string,
) {
  return {
    schemaVersion: 2,
    id: oldId,
    directoryBasename: basename(
      resolveAccountStorePaths(oldAnchor, oldId).storeDir,
    ),
    relocatedTo: { legacyPath: newAnchor, id: newId },
  }
}
function pointerBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

interface MovedStore {
  root: string
  oldAnchor: string
  newAnchor: string
  oldPaths: AccountStorePaths
  newPaths: AccountStorePaths
  oldId: string
  newId: string
  /** Row refs the old store's repository read before the move. */
  refs: { id: string; credentialEpoch: number; identity?: string }[]
  /** Raw store rows and settings of the old generation before its tombstone. */
  before: {
    rows: unknown[]
    settings: Record<string, unknown>
    state: Buffer
  }
  forward: ReturnType<typeof forwardJson>
}

const ROTATED_REFRESH = 'synthetic-refresh-two-rotated'
const ROTATED_ACCESS = 'synthetic-access-two'

/**
 * An old generation with store-native state (a refresh with a rotated token
 * and access token, recorded identities and quota), then moved by hand the
 * way the move will: snapshot, byte clone, generation key rewritten through
 * the store, moved journal, management tombstone in the old generation,
 * schema-1 pointer at the new anchor and a forward at the old one.
 */
async function movedStore(): Promise<MovedStore> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agy-account-relocation-')),
  )
  await mkdir(join(root, 'config'), { mode: 0o700 })
  await mkdir(join(root, 'state'), { mode: 0o700 })
  const oldAnchor = join(root, 'config', 'antigravity-accounts.json')
  const newAnchor = join(root, 'state', 'antigravity-accounts.json')
  const initialized = await initializeFreshAccountStore(modules, {
    legacyPath: oldAnchor,
    now: () => Date.now(),
  })
  if (initialized.status !== 'completed')
    throw new Error(`fresh initialization is ${initialized.status}`)
  const oldBinding = await readAccountStoreBinding(oldAnchor, modules, () =>
    Date.now(),
  )
  if (oldBinding.status !== 'bound')
    throw new Error(`old store is ${oldBinding.status}`)
  const oldPaths = oldBinding.paths
  const oldId = oldBinding.receipt.id

  const exchange: AccountTokenExchange = async () => ({
    accessToken: ROTATED_ACCESS,
    refreshToken: ROTATED_REFRESH,
    expiresAt: Date.now() + 3_600_000,
    identity: 'acct-two',
  })
  const repository = createAccountRepositoryFactory(modules)({
    paths: oldPaths,
    now: () => Date.now(),
    exchange,
  })
  try {
    const one = await repository.login({
      id: randomUUID(),
      refreshToken: 'synthetic-refresh-one',
      identity: 'acct-one',
      metadata: { addedAt: 1_000, lastUsed: 0, email: 'one@example.test' },
    })
    const two = await repository.login({
      id: randomUUID(),
      refreshToken: 'synthetic-refresh-two',
      metadata: { addedAt: 2_000, lastUsed: 0 },
    })
    const identified = await repository.recordIdentity(two.ref, 'acct-two')
    const refreshed = await repository.refresh(identified.ref)
    if (refreshed.status !== 'rotated')
      throw new Error(`refresh is ${refreshed.status}`)
    await repository.recordQuota(one.ref, {
      schemaVersion: 1,
      cachedQuotaUpdatedAt: 5,
      cachedQuota: { claude: { remainingFraction: 0.25, modelCount: 1 } },
    })
    const read = await repository.read()
    if (read.status !== 'ready') throw new Error(`old pool is ${read.status}`)
    const refs = read.rows.map((row) => ({ ...row.ref }))
    const before = {
      rows: await rowsOf(oldPaths),
      settings: await settingsOf(oldPaths),
      state: await readFile(oldPaths.statePath),
    }

    // Snapshot of the old generation, as the move takes it.
    const config = await readFile(oldPaths.configPath)
    const state = await readFile(oldPaths.statePath)
    const oldJournal = await readFile(oldPaths.migrationPath)
    const snapshot = Buffer.from(
      JSON.stringify({
        config: config.toString('base64'),
        state: state.toString('base64'),
        journal: oldJournal.toString('base64'),
      }),
    )
    const sourceSha256 = sha256(snapshot)
    const newId = randomUUID()
    const newPaths = resolveAccountStorePaths(newAnchor, newId)
    await privateDirectories(newPaths)
    await writePrivate(
      join(newPaths.backupsDir, `${sourceSha256}.json`),
      snapshot,
    )
    const source = {
      legacyPath: oldAnchor,
      storeDir: oldPaths.storeDir,
      journalId: oldId,
      configSha256: sha256(config),
      stateSha256: sha256(state),
      statePresent: true,
    }
    const capture = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: newId,
        legacyPath: newAnchor,
        storeDir: newPaths.storeDir,
        sourceKind: 'generation',
        sourceSha256,
        manifest: EMPTY_MANIFEST,
        mapping: [],
        relocation: { source },
      }),
    )
    await writePrivate(
      join(newPaths.transfersDir, `${newId}.capture.json`),
      capture,
    )

    // Byte clone, then only the generation key is rewritten.
    await writePrivate(newPaths.statePath, state)
    await writePrivate(newPaths.configPath, config)
    await rawStore(newPaths).updateSettings((settings) => {
      settings[GENERATION_KEY] = {
        schemaVersion: 1,
        id: newId,
        legacyPath: newAnchor,
        storeDir: newPaths.storeDir,
        sourceKind: 'generation',
        initialManifestSha256: EMPTY_MANIFEST_SHA256,
      }
      return settings
    })
    const rows = refs.map((ref) => ref.id)
    const journal = {
      schemaVersion: 1,
      id: newId,
      legacyPath: newAnchor,
      storeDir: newPaths.storeDir,
      status: 'active',
      operation: 'migrate',
      phase: 'activate',
      sourceKind: 'generation',
      sourceSha256,
      captureSha256: sha256(capture),
      manifest: EMPTY_MANIFEST,
      mapping: [],
      completedRows: [],
      verification: {
        manifestSha256: EMPTY_MANIFEST_SHA256,
        configSha256: sha256(await readFile(newPaths.configPath)),
        stateSha256: sha256(await readFile(newPaths.statePath)),
        statePresent: true,
        durability: accountMigrationDurability(),
      },
      relocation: {
        source,
        rows,
        sourceTombstoned: true,
        sourceForwarded: true,
      },
    }
    decodeAccountMigrationJournal(journal)
    await writePrivate(newPaths.migrationPath, JSON.stringify(journal))

    // The tombstone in the old generation, then both pointers.
    await rawStore(oldPaths).updateSettings((settings) => {
      settings[MANAGEMENT_SETTINGS_KEY] = {
        id: newId,
        kind: 'migration',
        targets: rows,
        progress: { step: 'activate', completedTargets: [] },
      }
      return settings
    })
    await writePrivate(
      accountStorePointerPath(newAnchor),
      pointerBytes({
        schemaVersion: 1,
        id: newId,
        directoryBasename: basename(newPaths.storeDir),
      }),
    )
    const forward = forwardJson(oldAnchor, oldId, newAnchor, newId)
    await writeFile(accountStorePointerPath(oldAnchor), pointerBytes(forward))
    return {
      root,
      oldAnchor,
      newAnchor,
      oldPaths,
      newPaths,
      oldId,
      newId,
      refs,
      before,
      forward,
    }
  } finally {
    await repository.dispose()
  }
}

/** Every file the move's evidence and both stores consist of. */
async function storeBytes(store: MovedStore): Promise<Record<string, string>> {
  const files = [
    accountStorePointerPath(store.oldAnchor),
    accountStorePointerPath(store.newAnchor),
    store.oldPaths.configPath,
    store.oldPaths.statePath,
    store.oldPaths.migrationPath,
    store.newPaths.configPath,
    store.newPaths.statePath,
    store.newPaths.migrationPath,
  ]
  const bytes: Record<string, string> = {}
  for (const file of files) bytes[file] = sha256(await readFile(file))
  return bytes
}

describe('a moved account store, read by this build', () => {
  let store: MovedStore
  beforeAll(async () => {
    store = await movedStore()
  })
  afterAll(async () => {
    if (store) await rm(store.root, { recursive: true, force: true })
  })

  /** Runs `body` with the old anchor's pointer replaced, then restores the forward. */
  async function withOldPointer(
    value: unknown,
    body: () => Promise<void>,
  ): Promise<void> {
    const path = accountStorePointerPath(store.oldAnchor)
    if (value === undefined) await rm(path)
    else await writeFile(path, pointerBytes(value))
    try {
      await body()
    } finally {
      await writePrivate(path, pointerBytes(store.forward))
    }
  }

  it('a relocated generation reads back the same rows, epochs, identities, stamps and settings', async () => {
    const rows = await rowsOf(store.newPaths)
    expect(rows).toEqual(store.before.rows as typeof rows)
    // The copy carries what a pool-file re-import would lose: the rotated
    // refresh token, the access token, identities and quota.
    const encoded = JSON.stringify(rows)
    expect(encoded).toContain(ROTATED_REFRESH)
    expect(encoded).toContain(ROTATED_ACCESS)
    expect(encoded).toContain('acct-one')
    expect(encoded).toContain('acct-two')
    expect(encoded).toContain('0.25')
    expect(sha256(await readFile(store.newPaths.statePath))).toBe(
      sha256(store.before.state),
    )
    const settings = await settingsOf(store.newPaths)
    expect(without(settings, GENERATION_KEY)).toEqual(
      without(store.before.settings, GENERATION_KEY),
    )
    expect(decodeAccountStoreGeneration(settings[GENERATION_KEY])).toEqual({
      schemaVersion: 1,
      id: store.newId,
      legacyPath: store.newAnchor,
      storeDir: store.newPaths.storeDir,
      sourceKind: 'generation',
      initialManifestSha256: EMPTY_MANIFEST_SHA256,
    })

    // Both anchors bind the moved generation: the old one through its
    // forward, the new one directly.
    for (const anchor of [store.oldAnchor, store.newAnchor]) {
      const binding = await readAccountStoreBinding(anchor, modules, () =>
        Date.now(),
      )
      expect(binding).toEqual({
        status: 'bound',
        paths: store.newPaths,
        receipt: {
          id: store.newId,
          status: 'active',
          legacyPath: store.newAnchor,
          storeDir: store.newPaths.storeDir,
          sourceKind: 'generation',
          durability: accountMigrationDurability(),
          restartRequired: true,
        },
      })
    }
    const admission = await readAccountStoreAdmission(
      store.oldAnchor,
      modules,
      () => Date.now(),
      store.newId,
    )
    expect(admission.status).toBe('active')

    // The repository binds on its own (at the new anchor) and serves the
    // same rows with the same refs; a write is admitted.
    const repository = createAccountRepositoryFactory(modules)({
      paths: store.newPaths,
      now: () => Date.now(),
      exchange: async () => {
        throw new Error('no exchange in this test')
      },
    })
    try {
      const read = await repository.read()
      if (read.status !== 'ready') throw new Error(`pool is ${read.status}`)
      expect(read.rows.map((row) => ({ ...row.ref }))).toEqual(store.refs)
      const first = read.rows[0]
      if (!first) throw new Error('no first row')
      await repository.recordQuota(first.ref, {
        schemaVersion: 1,
        cachedQuotaUpdatedAt: 6,
      })
    } finally {
      await repository.dispose()
    }
  })

  it('binding a relocated generation refuses when the forward at the old anchor names another generation', async () => {
    const other = randomUUID()
    await withOldPointer(
      forwardJson(store.oldAnchor, store.oldId, store.newAnchor, other),
      async () => {
        const viaOld = await readAccountStoreBinding(
          store.oldAnchor,
          modules,
          () => Date.now(),
        )
        expect(viaOld).toEqual({
          status: 'error',
          reason: `the forwarding pointer ${accountStorePointerPath(store.oldAnchor)} names generation ${other}, which ${accountStorePointerPath(store.newAnchor)} does not publish`,
        })
        const atNew = await readAccountStoreBinding(
          store.newAnchor,
          modules,
          () => Date.now(),
        )
        expect(atNew).toEqual({
          status: 'error',
          reason: `the forwarding pointer ${accountStorePointerPath(store.oldAnchor)} names another store than the moved account store at ${store.newPaths.storeDir}`,
        })
      },
    )
  })

  it('binding a relocated generation refuses when the forward was restored to schema 1, naming both stores', async () => {
    await withOldPointer(
      {
        schemaVersion: 1,
        id: store.oldId,
        directoryBasename: basename(store.oldPaths.storeDir),
      },
      async () => {
        const atNew = await readAccountStoreBinding(
          store.newAnchor,
          modules,
          () => Date.now(),
        )
        expect(atNew.status).toBe('error')
        const reason = atNew.status === 'error' ? atNew.reason : ''
        expect(reason).toContain('was reactivated')
        expect(reason).toContain(dirname(store.oldAnchor))
        expect(reason).toContain(store.newPaths.storeDir)
        // The old anchor serves nothing either: its generation carries the
        // move's tombstone.
        const atOld = await readAccountStoreBinding(
          store.oldAnchor,
          modules,
          () => Date.now(),
        )
        expect(atOld.status).toBe('error')
        const oldReason = atOld.status === 'error' ? atOld.reason : ''
        expect(oldReason).toContain(store.oldPaths.storeDir)
        expect(oldReason).toContain(store.newId)
      },
    )
  })

  it('binding a relocated generation refuses when the forward is missing', async () => {
    await withOldPointer(undefined, async () => {
      expect(
        await readAccountStoreBinding(store.newAnchor, modules, () =>
          Date.now(),
        ),
      ).toEqual({
        status: 'error',
        reason: `the forwarding pointer ${accountStorePointerPath(store.oldAnchor)} to the moved account store at ${store.newPaths.storeDir} is missing; restore it`,
      })
    })
  })

  it('every other entry point at either anchor refuses and writes nothing', async () => {
    const before = await storeBytes(store)
    const options = (legacyPath: string) => ({
      legacyPath,
      offline: { processesStopped: true as const },
      now: () => Date.now(),
    })
    const moved = `the account store moved to ${store.newAnchor}; this operation does not follow a moved store`
    await expect(
      createAccountMigrationFactory(modules)(options(store.oldAnchor)),
    ).rejects.toMatchObject({ reason: moved })
    await expect(
      initializeFreshAccountStore(modules, {
        legacyPath: store.oldAnchor,
        now: () => Date.now(),
      }),
    ).rejects.toMatchObject({ reason: moved })
    await expect(
      assertLegacyAccountStorageWritable(store.oldAnchor),
    ).rejects.toMatchObject({ reason: moved })
    await expect(
      createAccountRollbackFactory(modules)(options(store.oldAnchor)),
    ).rejects.toMatchObject({
      reason: expect.stringContaining(
        'antigravity-auth store relocate --back --offline',
      ),
    })
    await expect(
      createAccountRollbackFactory(modules)(options(store.newAnchor)),
    ).rejects.toMatchObject({
      reason: expect.stringContaining(
        'antigravity-auth store relocate --back --offline',
      ),
    })
    await expect(
      createAccountMigrationFactory(modules)(options(store.newAnchor)),
    ).rejects.toMatchObject({
      reason: expect.stringContaining('antigravity-auth store relocate'),
    })
    await expect(
      assertLegacyAccountStorageWritable(store.newAnchor),
    ).rejects.toThrow()
    expect(await storeBytes(store)).toEqual(before)
  })

  it('the anchor resolver follows the forward and refuses ambiguity, naming both paths', async () => {
    expect(await resolveAccountStoreAnchor(store.oldAnchor)).toEqual({
      legacyPath: store.newAnchor,
      forwardedFrom: store.oldAnchor,
    })
    expect(await resolveAccountStoreAnchor(store.newAnchor)).toEqual({
      legacyPath: store.newAnchor,
    })
    const elsewhere = join(store.root, 'elsewhere', 'antigravity-accounts.json')
    await expect(
      resolveAccountStoreAnchor(store.oldAnchor, {
        relocatedAnchor: elsewhere,
      }),
    ).rejects.toMatchObject({
      reason: `the forwarding pointer ${accountStorePointerPath(store.oldAnchor)} names ${store.newAnchor}, but this process keeps the account store at ${elsewhere}`,
    })
    expect(
      await resolveAccountStoreAnchor(store.oldAnchor, {
        relocatedAnchor: store.newAnchor,
        alternatives: [elsewhere],
      }),
    ).toEqual({ legacyPath: store.newAnchor, forwardedFrom: store.oldAnchor })
    await expect(
      resolveAccountStoreAnchor(store.oldAnchor, {
        alternatives: [store.newAnchor],
      }),
    ).rejects.toMatchObject({
      reason: `account store pointers exist at both ${accountStorePointerPath(store.oldAnchor)} and ${accountStorePointerPath(store.newAnchor)}; refusing to choose between them`,
    })
  })
})

// Pure decoder fixtures: no file is read, so the anchors need not exist.
const OLD_ANCHOR = '/synthetic/config/antigravity-accounts.json'
const NEW_ANCHOR = '/synthetic/state/antigravity-accounts.json'
const OLD_ID = '00000000-0000-4000-8000-000000000001'
const NEW_ID = '00000000-0000-4000-8000-000000000002'
const ROW_ID = '00000000-0000-4000-8000-000000000003'
const HASH = 'a'.repeat(64)

function movedJournal(): AccountMigrationJournal {
  return {
    schemaVersion: 1,
    id: NEW_ID,
    legacyPath: NEW_ANCHOR,
    storeDir: resolveAccountStorePaths(NEW_ANCHOR, NEW_ID).storeDir,
    status: 'active',
    operation: 'migrate',
    phase: 'activate',
    sourceKind: 'generation',
    sourceSha256: HASH,
    captureSha256: 'b'.repeat(64),
    manifest: { ...EMPTY_MANIFEST },
    mapping: [],
    completedRows: [],
    verification: {
      manifestSha256: EMPTY_MANIFEST_SHA256,
      configSha256: 'c'.repeat(64),
      stateSha256: 'd'.repeat(64),
      statePresent: true,
      durability: 'posix-directory-synced',
    },
    relocation: {
      source: {
        legacyPath: OLD_ANCHOR,
        storeDir: resolveAccountStorePaths(OLD_ANCHOR, OLD_ID).storeDir,
        journalId: OLD_ID,
        configSha256: 'e'.repeat(64),
        stateSha256: 'f'.repeat(64),
        statePresent: true,
      },
      rows: [ROW_ID],
      sourceTombstoned: true,
      sourceForwarded: true,
    },
  }
}
type Mutable = Record<string, unknown> & {
  relocation: Record<string, unknown> & { source: Record<string, unknown> }
}
function variant(change: (journal: Mutable) => void): unknown {
  const journal = structuredClone(movedJournal()) as unknown as Mutable
  change(journal)
  return journal
}
function absentJournal(): Record<string, unknown> {
  const { sourceSha256, captureSha256, relocation, ...rest } = movedJournal()
  void sourceSha256
  void captureSha256
  void relocation
  return {
    ...rest,
    status: 'pending',
    phase: 'capture',
    sourceKind: 'absent',
    verification: undefined,
  }
}

describe('moved-store journal decoder', () => {
  it('accepts a complete moved-store journal unchanged', () => {
    expect(decodeAccountMigrationJournal(movedJournal())).toEqual(
      movedJournal(),
    )
  })

  const cases: [string, unknown, string][] = [
    [
      'a generation source without relocation evidence',
      variant((j) => {
        delete (j as Record<string, unknown>).relocation
      }),
      'moved source lacks its relocation evidence',
    ],
    [
      'relocation evidence on another source kind',
      {
        ...JSON.parse(JSON.stringify(absentJournal())),
        relocation: movedJournal().relocation,
      },
      'only a moved store records relocation evidence',
    ],
    [
      'a retired pool-file copy',
      variant((j) => {
        j.retiredSha256 = HASH
      }),
      'moved source cannot claim retired pool-file bytes',
    ],
    [
      'a checked pool-file absence',
      variant((j) => {
        j.sourceAbsenceVerified = true
      }),
      'source absence association is invalid',
    ],
    [
      'retirement without verification',
      variant((j) => {
        j.status = 'pending'
        j.phase = 'retire'
        delete j.verification
        j.relocation.sourceTombstoned = false
        j.relocation.sourceForwarded = false
      }),
      'retirement lacks durable full-row verification',
    ],
    [
      'activation without the forward',
      variant((j) => {
        j.status = 'pending'
        j.relocation.sourceForwarded = false
      }),
      'moved-store activation lacks its source forward',
    ],
    [
      'an active receipt without the forward',
      variant((j) => {
        j.relocation.sourceForwarded = false
      }),
      'active moved store lacks its source forward',
    ],
    [
      'a forward before the tombstone',
      variant((j) => {
        j.relocation.sourceTombstoned = false
      }),
      'source forward precedes its management tombstone',
    ],
    [
      'a tombstone before verification finished',
      variant((j) => {
        j.status = 'pending'
        j.phase = 'verify'
        j.relocation.sourceForwarded = false
      }),
      'source tombstone or forward precedes durable verification',
    ],
    [
      'a rollback of a moved store',
      variant((j) => {
        j.status = 'pending'
        j.operation = 'rollback'
        j.phase = 'build'
        delete j.verification
        j.relocation.sourceTombstoned = false
        j.relocation.sourceForwarded = false
      }),
      'a moved account store is not rolled back; move it back first with `antigravity-auth store relocate --back --offline`',
    ],
    [
      'rows in the manifest',
      variant((j) => {
        j.manifest = {
          ...EMPTY_MANIFEST,
          routing: { schemaVersion: 1, activeIndex: 0 },
        }
      }),
      'moved-store manifest must be explicitly empty',
    ],
    [
      'no capture hash',
      variant((j) => {
        delete j.captureSha256
      }),
      'journal.captureSha256 is invalid',
    ],
    [
      'a source folder not derived from its anchor',
      variant((j) => {
        j.relocation.source.storeDir = `${OLD_ANCHOR}.store.${NEW_ID}.generation`
      }),
      'relocation source association differs',
    ],
    [
      'a source at the target anchor',
      variant((j) => {
        j.relocation.source.legacyPath = NEW_ANCHOR
        j.relocation.source.storeDir = resolveAccountStorePaths(
          NEW_ANCHOR,
          OLD_ID,
        ).storeDir
      }),
      'relocation source and target share one anchor',
    ],
    [
      'a state hash for an absent source state',
      variant((j) => {
        j.relocation.source.statePresent = false
      }),
      'absent source state cannot claim a file hash',
    ],
    [
      'a cancellation',
      variant((j) => {
        j.cancelled = true
      }),
      'invalid pre-retirement cancellation',
    ],
    [
      'unknown relocation fields',
      variant((j) => {
        j.relocation.extra = true
      }),
      'relocation has unknown fields',
    ],
  ]
  it.each(
    cases,
  )('the journal decoder refuses a generation source without relocation evidence: %s', (_name, journal, reason) => {
    expect(() => decodeAccountMigrationJournal(journal)).toThrow(reason)
  })
})

describe('forwarding pointer decoder', () => {
  const forward = forwardJson(OLD_ANCHOR, OLD_ID, NEW_ANCHOR, NEW_ID)
  it('decodes a schema-2 forward and keeps schema 1 strict', () => {
    expect(decodeAccountStorePointerRecord(forward, OLD_ANCHOR)).toEqual(
      forward as ReturnType<typeof decodeAccountStorePointerRecord>,
    )
    const pointer = {
      schemaVersion: 1,
      id: OLD_ID,
      directoryBasename: forward.directoryBasename,
    }
    expect(decodeAccountStorePointerRecord(pointer, OLD_ANCHOR)).toEqual(
      pointer as ReturnType<typeof decodeAccountStorePointerRecord>,
    )
    // The schema-1 decoder is the one released builds have, and it refuses
    // a forward before reading its schema.
    expect(() => decodeAccountStorePointer(forward, OLD_ANCHOR)).toThrow(
      'pointer has unknown fields',
    )
  })
  it.each([
    [
      'its own anchor',
      { ...forward, relocatedTo: { legacyPath: OLD_ANCHOR, id: NEW_ID } },
      'forward names its own anchor',
    ],
    [
      'a relative target',
      {
        ...forward,
        relocatedTo: { legacyPath: 'antigravity-accounts.json', id: NEW_ID },
      },
      'legacy path must be absolute and normalized',
    ],
    [
      'a foreign directory',
      { ...forward, directoryBasename: 'elsewhere' },
      'forward directory basename differs from its derived generation',
    ],
    ['unknown fields', { ...forward, extra: 1 }, 'forward has unknown fields'],
    [
      'unknown target fields',
      { ...forward, relocatedTo: { ...forward.relocatedTo, extra: 1 } },
      'forward target has unknown fields',
    ],
  ])('refuses a forward naming %s', (_name, value, reason) => {
    expect(() => decodeAccountStorePointerRecord(value, OLD_ANCHOR)).toThrow(
      reason,
    )
  })
})

// Released 3.0.15 core against a forward. The released package is installed
// from npm at test time (as `windows-migration.yml` installs 3.0.0) and its
// lockfile integrity is pinned, so this runs the real old build. Without
// registry access the suite is skipped and says so; set
// ANTIGRAVITY_RELEASED_CORE_REQUIRED=1 to make a missing registry fail it.
const RELEASED_CORE = '@cortexkit/antigravity-auth-core'
const RELEASED_VERSION = '3.0.15'
const RELEASED_INTEGRITY =
  'sha512-/W7ODhE5G12CLtFt/+iNcHlKlGwL1csvkoVWHo748XE6oD+KIq08qVuDw6DjvgdD7pQGnN4kGHrgTtnnG2e41g=='
const NETWORK_FAILURE =
  /E(NOTFOUND|AI_AGAIN|CONNREFUSED|CONNRESET|NETUNREACH|HOSTUNREACH|TIMEDOUT)|ETIMEDOUT|network request|fetch failed|ENOENT: spawn/

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      stderr += `${error.message}\n`
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The installed released package's folder, or why it is unavailable. */
async function installReleasedCore(): Promise<
  { dir: string; root: string } | { unavailable: string }
> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agy-released-core-')),
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'released-core-baseline', private: true }),
  )
  const installed = await run(
    'npm',
    [
      'install',
      `${RELEASED_CORE}@${RELEASED_VERSION}`,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--fetch-retries=0',
      '--fetch-timeout=20000',
      '--cache',
      join(root, 'npm-cache'),
    ],
    root,
    120_000,
  )
  if (installed.code !== 0) {
    const output = `${installed.stdout}\n${installed.stderr}`
    if (NETWORK_FAILURE.test(output) || installed.code === null)
      return {
        unavailable: `npm could not reach the registry: ${output.trim().split('\n').slice(-3).join(' | ')}`,
      }
    throw new Error(`npm install of the released core failed:\n${output}`)
  }
  const lock = JSON.parse(
    await readFile(join(root, 'package-lock.json'), 'utf8'),
  )
  const entry = lock.packages?.[`node_modules/${RELEASED_CORE}`]
  if (
    entry?.version !== RELEASED_VERSION ||
    entry?.integrity !== RELEASED_INTEGRITY
  )
    throw new Error(
      `released core identity differs: ${JSON.stringify(entry ?? null)}`,
    )
  return { root, dir: join(root, 'node_modules', RELEASED_CORE) }
}

const released = await installReleasedCore()
if ('unavailable' in released) {
  if (process.env.ANTIGRAVITY_RELEASED_CORE_REQUIRED === '1')
    throw new Error(released.unavailable)
  console.warn(
    `account-relocation: skipping the released ${RELEASED_VERSION} checks; ${released.unavailable}`,
  )
}

/**
 * Runs every 3.0.15 entry point that reads the pointer, in `node`, against
 * one anchor; `bind-only` runs only the binding (the control).
 */
const CHILD = `
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const [dir, legacyPath, mode] = process.argv.slice(2)
const load = (path) => import(pathToFileURL(join(dir, 'dist', path)).href)
const core = await load('account-migration.js')
const store = await load('common-auth-embedded/store/index.js')
const fs = await load('common-auth-embedded/fs/index.js')
const modules = { store, fs }
const refusal = async (operation) => {
  try {
    await operation()
    return 'no refusal'
  } catch (error) {
    return typeof error?.reason === 'string' ? error.reason : String(error)
  }
}
const now = () => Date.now()
const offline = { legacyPath, offline: { processesStopped: true }, now }
const result = { bind: await core.readAccountStoreBinding(legacyPath, { store }, now) }
if (mode !== 'bind-only') {
  result.freshInit = await refusal(() => core.initializeFreshAccountStore(modules, { legacyPath, now }))
  result.migrate = await refusal(() => core.createAccountMigrationFactory(modules)(offline))
  result.rollback = await refusal(() => core.createAccountRollbackFactory(modules)(offline))
  result.legacyWriteGuard = await refusal(() => core.assertLegacyAccountStorageWritable(legacyPath))
}
console.log(JSON.stringify(result))
`

describe.skipIf('unavailable' in released)(
  `released ${RELEASED_VERSION} core`,
  () => {
    let store: MovedStore
    let child: string
    beforeAll(async () => {
      store = await movedStore()
      child = join(store.root, 'released-child.mjs')
      await writeFile(child, CHILD)
    })
    afterAll(async () => {
      if (store) await rm(store.root, { recursive: true, force: true })
      if ('root' in released)
        await rm(released.root, { recursive: true, force: true })
    })

    async function runReleased(legacyPath: string, mode = 'all') {
      if (!('dir' in released)) throw new Error('released core missing')
      const result = await run(
        'node',
        [child, released.dir, legacyPath, mode],
        store.root,
        60_000,
      )
      if (result.code !== 0)
        throw new Error(`released child failed:\n${result.stderr}`)
      return JSON.parse(result.stdout)
    }

    it('the old anchor refuses schema-2 forwards in every 3.0.15 entry point', async () => {
      const before = await storeBytes(store)
      expect(await runReleased(store.oldAnchor)).toEqual({
        bind: { status: 'error', reason: 'pointer has unknown fields' },
        freshInit: 'pointer has unknown fields',
        migrate: 'pointer has unknown fields',
        rollback: 'pointer has unknown fields',
        legacyWriteGuard: 'pointer has unknown fields',
      })
      expect(await storeBytes(store)).toEqual(before)
    })

    it('binds a schema-1 store, so its refusals above are the forward', async () => {
      const control = join(store.root, 'control')
      await mkdir(control, { mode: 0o700 })
      const legacyPath = join(control, 'antigravity-accounts.json')
      const initialized = await initializeFreshAccountStore(modules, {
        legacyPath,
        now: () => Date.now(),
      })
      expect(initialized.status).toBe('completed')
      const result = await runReleased(legacyPath, 'bind-only')
      expect(result.bind.status).toBe('bound')
    })
  },
)
