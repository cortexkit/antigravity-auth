import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  admitPublicConsumer,
  PUBLIC_CONSUMER_ENV,
  PUBLIC_CONSUMER_PROJECT_ROOT,
  provisionPublicConsumer,
  publicFixtureBytes,
  requirePublicConsumerRoot,
} from './__fixtures__/common-auth-public-consumer.test.ts'
import { AccountManager } from './account-manager.ts'
import {
  ACCOUNT_MIGRATION_MANAGEMENT_STEPS,
  type AccountMigrationModules,
  initializeFreshAccountStore,
  readAccountStoreBinding,
  resolveAccountStorePaths,
} from './account-migration.ts'
import {
  ACCOUNT_STATE_POLICY,
  type AccountLease,
  type AccountLockModule,
  AccountRepositoryError,
  type AccountRepositoryFactoryOptions,
  type AccountStoreModule,
  type AccountStoreModules,
  applyAccessVerdict,
  applyTierObservation,
  applyUsage,
  createAccountRepositoryFactory,
  decodeManagementRecord,
  decodeTransferFile,
  mergeRateLimitResets,
  replacementInputDigest,
  utcDay,
} from './account-repository.ts'
import {
  createProviderStateCodec,
  decodeProviderState,
  encodeProviderMetadata,
  encodeProviderState,
  QUOTA_CODEC,
} from './account-repository-codecs.ts'
import {
  ACCOUNT_STORE_PROVIDER,
  type AccountLoginInput,
  type AccountRepository,
  type AccountRepositoryRead,
  type AccountRow,
  type AccountStorePaths,
  type AccountTokenExchange,
  MANAGEMENT_LOCK_NAME,
  MANAGEMENT_SETTINGS_KEY,
  type ManagementReceipt,
  type ProviderMetadata,
  type ProviderStateEnvelope,
  type RowRef,
  refreshProviderLock,
  type StoredFingerprint,
} from './account-repository-types.ts'

// Every value below is synthetic. Nothing here reads a user's account files,
// talks to a provider or uses the network.

function fingerprint(seed: string): StoredFingerprint {
  return {
    deviceId: `device-${seed}`,
    sessionToken: `session-${seed}`,
    userAgent: `antigravity-cli/test ${seed}`,
    apiClient: 'antigravity-cli',
    clientMetadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'darwin',
      pluginType: 'GEMINI',
    },
    createdAt: 1_700_000_000_000,
  }
}

function envelope(metadata: ProviderMetadata): ProviderStateEnvelope {
  return { schemaVersion: 1, metadata }
}

const accountMetadata: ProviderMetadata = {
  email: 'synthetic@example.test',
  projectId: 'proj-1',
  managedProjectId: 'managed-1',
  addedAt: 1_000,
  lastUsed: 5_000,
  label: 'Work',
  enabled: true,
  lastSwitchReason: 'rotation',
  rateLimitResetTimes: { claude: 9_000, 'gemini-cli': null },
  coolingDownUntil: 8_000,
  cooldownReason: 'network-error',
  fingerprint: fingerprint('a'),
  fingerprintHistory: [
    { fingerprint: fingerprint('h1'), timestamp: 10, reason: 'regenerated' },
    { fingerprint: fingerprint('h0'), timestamp: 5, reason: 'initial' },
  ],
  verificationRequired: true,
  verificationRequiredAt: 4_000,
  verificationRequiredReason: 'verify',
  verificationUrl: 'https://accounts.example.test/verify',
  capturedTierId: 'free-tier',
  capturedPaidTierId: null,
  capturedTierAt: 3_000,
  capturedTierSchemaVersion: 2,
  dailyRequestCounts: { date: '2026-10-07', claude: 3, gemini: 1 },
  extensions: { futureField: { kept: true } },
}

// ---------------------------------------------------------------------------
// Metadata rules (pure; no store involved)
// ---------------------------------------------------------------------------

describe('ACCOUNT_STATE_POLICY.onReplace', () => {
  const replace = (
    replacement: Partial<Parameters<typeof ACCOUNT_STATE_POLICY.onReplace>[1]>,
  ) =>
    ACCOUNT_STATE_POLICY.onReplace(envelope(accountMetadata), {
      id: 'row',
      credentialEpoch: 2,
      ...replacement,
    })?.metadata

  it('keeps account-describing fields when the locked prior identity equals the new one', () => {
    const next = replace({ previousIdentity: 'acct-1', identity: 'acct-1' })
    expect(next?.email).toBe('synthetic@example.test')
    expect(next?.projectId).toBe('proj-1')
    expect(next?.managedProjectId).toBe('managed-1')
    expect(next?.fingerprint).toEqual(fingerprint('a'))
    expect(next?.fingerprintHistory).toEqual(accountMetadata.fingerprintHistory)
    expect(next?.capturedTierId).toBe('free-tier')
    expect(next?.capturedPaidTierId).toBeNull()
  })

  it('drops them for another account, and when the prior identity is absent', () => {
    for (const replacement of [
      { previousIdentity: 'acct-1', identity: 'acct-2' },
      // An incoming identity alone proves nothing about the old credential.
      { identity: 'acct-1' },
      // Neither side known is not "the same account" either.
      {},
      { previousIdentity: 'acct-1' },
    ]) {
      const next = replace(replacement)
      expect(next).toBeDefined()
      for (const field of [
        'email',
        'projectId',
        'managedProjectId',
        'fingerprint',
        'fingerprintHistory',
        'capturedTierId',
        'capturedPaidTierId',
        'capturedTierAt',
        'capturedTierSchemaVersion',
      ] as const) {
        expect(next !== undefined && field in next).toBe(false)
      }
    }
  })

  it("keeps the row's own fields and clears the old credential's limits and verdicts", () => {
    for (const replacement of [
      { previousIdentity: 'acct-1', identity: 'acct-1' },
      { previousIdentity: 'acct-1', identity: 'acct-2' },
    ]) {
      const next = replace(replacement)
      expect(next?.addedAt).toBe(1_000)
      expect(next?.lastUsed).toBe(5_000)
      expect(next?.label).toBe('Work')
      expect(next?.enabled).toBe(true)
      expect(next?.lastSwitchReason).toBe('rotation')
      expect(next?.dailyRequestCounts).toEqual(
        accountMetadata.dailyRequestCounts,
      )
      expect(next?.extensions).toEqual({ futureField: { kept: true } })
      for (const field of [
        'rateLimitResetTimes',
        'coolingDownUntil',
        'cooldownReason',
        'verificationRequired',
        'verificationRequiredAt',
        'verificationRequiredReason',
        'verificationUrl',
        'accountIneligible',
        'eligibilityStateUpdatedAt',
      ] as const) {
        expect(next !== undefined && field in next).toBe(false)
      }
    }
  })

  it('lets incoming fields win except the accumulated ones', () => {
    const next = replace({
      previousIdentity: 'acct-1',
      identity: 'acct-2',
      incoming: envelope({
        email: 'other@example.test',
        projectId: 'proj-2',
        addedAt: 99_999,
        lastUsed: 1,
        dailyRequestCounts: { date: '2026-10-07', claude: 0, gemini: 0 },
      }),
    })
    expect(next?.email).toBe('other@example.test')
    expect(next?.projectId).toBe('proj-2')
    expect(next?.addedAt).toBe(1_000)
    expect(next?.lastUsed).toBe(5_000)
    expect(next?.dailyRequestCounts).toEqual(accountMetadata.dailyRequestCounts)
  })

  it('stores the incoming metadata as is for a row that showed none, and clears without either', () => {
    const incoming = envelope({
      addedAt: 7,
      lastUsed: 0,
      email: 'n@example.test',
    })
    expect(
      ACCOUNT_STATE_POLICY.onReplace(undefined, {
        id: 'row',
        credentialEpoch: 2,
        incoming,
      })?.metadata,
    ).toEqual(incoming.metadata)
    expect(
      ACCOUNT_STATE_POLICY.onReplace(undefined, {
        id: 'row',
        credentialEpoch: 2,
      }),
    ).toBeUndefined()
  })

  it('runs through the store codec with the locked previousIdentity it is handed', () => {
    const codec = createProviderStateCodec(ACCOUNT_STATE_POLICY)
    const stored = JSON.parse(JSON.stringify(envelope(accountMetadata)))
    const same = decodeProviderState(
      codec.onReplace(stored, {
        id: 'row',
        credentialEpoch: 3,
        previousIdentity: 'acct-1',
        identity: 'acct-1',
      }),
    )
    const other = decodeProviderState(
      codec.onReplace(stored, {
        id: 'row',
        credentialEpoch: 3,
        identity: 'acct-1',
      }),
    )
    expect(same.metadata.projectId).toBe('proj-1')
    expect('projectId' in other.metadata).toBe(false)
  })
})

describe('ACCOUNT_STATE_POLICY.merge', () => {
  it('lets present incoming fields win while accumulated fields keep their rules', () => {
    const merged = ACCOUNT_STATE_POLICY.merge(
      envelope(accountMetadata),
      envelope({
        addedAt: 50_000,
        lastUsed: 2_000,
        projectId: 'proj-new',
        verificationRequired: false,
        rateLimitResetTimes: { claude: 7_000, 'gemini-antigravity': 12_000 },
        dailyRequestCounts: { date: '2026-10-07', claude: 0, gemini: 0 },
        extensions: { other: 1 },
      }),
    ).metadata
    expect(merged.projectId).toBe('proj-new')
    expect(merged.verificationRequired).toBe(false)
    // Omitted fields are kept.
    expect(merged.managedProjectId).toBe('managed-1')
    expect(merged.fingerprint).toEqual(fingerprint('a'))
    expect(merged.addedAt).toBe(1_000)
    expect(merged.lastUsed).toBe(5_000)
    expect(merged.dailyRequestCounts).toEqual(
      accountMetadata.dailyRequestCounts,
    )
    expect(merged.rateLimitResetTimes).toEqual({
      claude: 9_000,
      'gemini-cli': null,
      'gemini-antigravity': 12_000,
    })
    expect(merged.extensions).toEqual({ futureField: { kept: true }, other: 1 })
  })
})

describe('observations', () => {
  it('merges rate limits key by key, keeping the later time', () => {
    expect(
      mergeRateLimitResets(
        { claude: 10, 'gemini-cli': null, 'gemini-antigravity:model': 30 },
        { claude: 5, 'gemini-cli': 20, 'gemini-antigravity:model': null },
      ),
    ).toEqual({ claude: 10, 'gemini-cli': 20, 'gemini-antigravity:model': 30 })
  })

  it('counts usage on the UTC day of the clock and restarts on a new day', () => {
    const noon = Date.UTC(2026, 9, 7, 12)
    const same = applyUsage(
      accountMetadata,
      { family: 'claude', at: 4_000 },
      noon,
    )
    expect(same.dailyRequestCounts).toEqual({
      date: '2026-10-07',
      claude: 4,
      gemini: 1,
    })
    // `lastUsed` keeps the later time.
    expect(same.lastUsed).toBe(5_000)
    const next = applyUsage(
      accountMetadata,
      { family: 'gemini', at: 6_000 },
      Date.UTC(2026, 9, 8, 0, 0, 1),
    )
    expect(next.dailyRequestCounts).toEqual({
      date: '2026-10-08',
      claude: 0,
      gemini: 1,
    })
    expect(next.lastUsed).toBe(6_000)
    expect(utcDay(noon)).toBe('2026-10-07')
  })

  it('ignores a tier reading older than the stored one', () => {
    const stale = applyTierObservation(accountMetadata, {
      observedAt: 2_000,
      tierId: 'paid',
      paidTierId: 'paid',
      schemaVersion: 3,
    })
    expect(stale).toBe(accountMetadata)
    const fresh = applyTierObservation(accountMetadata, {
      observedAt: 3_500,
      tierId: 'paid',
      paidTierId: null,
      schemaVersion: 3,
    })
    expect(fresh.capturedTierId).toBe('paid')
    expect(fresh.capturedPaidTierId).toBeNull()
    expect(fresh.capturedTierAt).toBe(3_500)
  })

  it('declines access evidence older than the stored evidence', () => {
    const ineligible = applyAccessVerdict(accountMetadata, {
      kind: 'ineligible',
      observedAt: 6_000,
      reason: 'blocked',
    })
    expect(ineligible?.transition).toBe('disable')
    const metadata = ineligible?.metadata
    expect(metadata?.accountIneligible).toBe(true)
    expect(metadata?.verificationRequired).toBe(false)
    expect(metadata !== undefined && 'verificationUrl' in metadata).toBe(false)
    if (metadata === undefined) throw new Error('verdict was declined')
    expect(
      applyAccessVerdict(metadata, {
        kind: 'verification-required',
        observedAt: 5_000,
      }),
    ).toBeUndefined()
    expect(
      applyAccessVerdict(metadata, {
        kind: 'cleared',
        observedAt: 5_999,
        enable: true,
      }),
    ).toBeUndefined()
    const cleared = applyAccessVerdict(metadata, {
      kind: 'cleared',
      observedAt: 7_000,
      enable: true,
    })
    expect(cleared?.transition).toBe('enable')
    expect(cleared?.metadata.accountIneligible).toBe(false)
    expect(cleared?.metadata.eligibilityStateUpdatedAt).toBe(7_000)
  })
})

// ---------------------------------------------------------------------------
// Real-store tests
//
// These run the repository against common-auth's genuine public store, in
// disposable directories, loaded the way a consumer of the package loads
// it: through the bare specifiers `@cortexkit/common-auth/store` and
// `@cortexkit/common-auth/fs`, resolved by the package's own `exports`.
//
// The consumer directory is the shared public-consumer fixture
// (`__fixtures__/common-auth-public-consumer.test.ts`), which
// `scripts/prepare-common-auth-public-consumer.ts` provisions offline from
// the repository's verified 0.11.6 archive and names in
// AGY_COMMON_AUTH_STORE_CONSUMER. Before anything is imported, the fixture's
// own `admitPublicConsumer` checks it: an owned, worktree-local directory,
// every package member byte-identical to the archive (name and version
// included), and the two one-line bridges `store-bridge.mjs` and
// `fs-bridge.mjs`. A missing or different consumer fails every test here
// instead of skipping it or substituting a stand-in.
// ---------------------------------------------------------------------------

const STORE_PACKAGE_NAME = '@cortexkit/common-auth'
const STORE_SPECIFIER = `${STORE_PACKAGE_NAME}/store`
const STORE_BRIDGE_FILE = 'store-bridge.mjs'
const FS_SPECIFIER = `${STORE_PACKAGE_NAME}/fs`
const FS_BRIDGE_FILE = 'fs-bridge.mjs'
/** Bound on the child process of the cross-process test. */
const CHILD_BOUND_MS = 30_000
/** Grace between SIGTERM and SIGKILL for that child. */
const CHILD_TERM_GRACE_MS = 5_000
/**
 * The work a real-store test may take before its cleanup: the store's own
 * default bounded wait for a lock (15 s).
 */
const STORE_TEST_WORK_MS = 15_000

/** The `import` target `exports[subpath]` names, when it names one. */
function exportOf(manifest: unknown, subpath: string): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  if (!('exports' in manifest)) return undefined
  const exports = manifest.exports
  if (typeof exports !== 'object' || exports === null) return undefined
  if (!(subpath in exports)) return undefined
  const entry: unknown = Reflect.get(exports, subpath)
  if (typeof entry !== 'object' || entry === null || !('import' in entry)) {
    return undefined
  }
  return typeof entry.import === 'string' ? entry.import : undefined
}

/**
 * Admits a consumer directory without importing anything from it. The
 * shared fixture's `admitPublicConsumer` is the only check of the package
 * itself; this adds that each bare specifier, resolved from its bridge,
 * lands on the file the admitted package's own `exports` names, so the
 * imports below load exactly the admitted package. Returns the bridges.
 */
async function admitStoreConsumer(
  consumer: string | undefined,
): Promise<{ bridge: string; fsBridge: string }> {
  const root = requirePublicConsumerRoot(consumer)
  const { packageRoot } = await admitPublicConsumer(root)
  const manifest: unknown = JSON.parse(
    (await publicFixtureBytes(join(packageRoot, 'package.json'))).toString(),
  )
  const bridge = join(root, STORE_BRIDGE_FILE)
  const fsBridge = join(root, FS_BRIDGE_FILE)
  for (const [specifier, from, subpath] of [
    [STORE_SPECIFIER, bridge, './store'],
    [FS_SPECIFIER, fsBridge, './fs'],
  ] as const) {
    const target = exportOf(manifest, subpath)
    if (target === undefined) {
      throw new Error(`${packageRoot} exports no ${subpath} import entry`)
    }
    const resolved = await realpath(Bun.resolveSync(specifier, from))
    const exported = await realpath(join(packageRoot, target))
    if (resolved !== exported) {
      throw new Error(
        `${specifier} resolves to ${resolved} from its bridge, not to the package's export ${exported}`,
      )
    }
  }
  return { bridge, fsBridge }
}

function isAccountStoreModule(value: unknown): value is AccountStoreModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'openPoolStore' in value &&
    typeof value.openPoolStore === 'function' &&
    'DECLINE_TRANSITION' in value &&
    typeof value.DECLINE_TRANSITION === 'symbol' &&
    'PoolOperationError' in value &&
    typeof value.PoolOperationError === 'function'
  )
}

function isAccountLockModule(value: unknown): value is AccountLockModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'withLock' in value &&
    typeof value.withLock === 'function' &&
    'LockContentionError' in value &&
    typeof value.LockContentionError === 'function' &&
    'LockOwnershipError' in value &&
    typeof value.LockOwnershipError === 'function'
  )
}

/** The migration's view of the same store module (its own public subset). */
function isMigrationStore(
  value: unknown,
): value is AccountMigrationModules['store'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'openPoolStore' in value &&
    typeof value.openPoolStore === 'function' &&
    'PoolOperationError' in value &&
    typeof value.PoolOperationError === 'function'
  )
}

/** The migration's view of the same fs module: the lease helper and writer. */
function isMigrationFs(value: unknown): value is AccountMigrationModules['fs'] {
  return (
    isAccountLockModule(value) &&
    'lockPathFor' in value &&
    typeof value.lockPathFor === 'function' &&
    'writeJsonAtomic' in value &&
    typeof value.writeJsonAtomic === 'function'
  )
}

interface AdmittedStore {
  module: AccountStoreModule
  fs: AccountLockModule
  /** The same two modules, as the migration's initializer takes them. */
  migration: AccountMigrationModules
  bridge: string
  fsBridge: string
}

let admitted: Promise<AdmittedStore> | undefined

/** Loads the admitted public modules through their consumer, or fails the test. */
function admittedStore(): Promise<AdmittedStore> {
  admitted ??= (async () => {
    const { bridge, fsBridge } = await admitStoreConsumer(
      process.env[PUBLIC_CONSUMER_ENV],
    )
    const module: unknown = await import(pathToFileURL(bridge).href)
    if (!isAccountStoreModule(module) || !isMigrationStore(module)) {
      throw new Error(
        `${STORE_SPECIFIER} does not export the store entry points`,
      )
    }
    const fs: unknown = await import(pathToFileURL(fsBridge).href)
    if (!isAccountLockModule(fs) || !isMigrationFs(fs)) {
      throw new Error(
        `${FS_SPECIFIER} does not export withLock, its errors and the writer`,
      )
    }
    return {
      module,
      fs,
      migration: { store: module, fs },
      bridge,
      fsBridge,
    }
  })()
  return admitted
}

/** The repository's files inside a disposable directory (`AccountStorePaths`). */
function pathsIn(dir: string): AccountStorePaths {
  const legacyPath = join(dir, 'antigravity-accounts.json')
  const storeDir = `${legacyPath}.store`
  return {
    legacyPath,
    storeDir,
    configPath: join(storeDir, 'config.json'),
    statePath: join(storeDir, 'state.json'),
    migrationPath: join(storeDir, 'migration.json'),
    backupsDir: join(storeDir, 'backups'),
    retiredDir: join(storeDir, 'retired'),
    transfersDir: join(storeDir, 'transfers'),
  }
}

const unusedExchange: AccountTokenExchange = async () => {
  throw new Error('this test performs no token exchange')
}

interface Pool {
  dir: string
  paths: AccountStorePaths
  /** The consumer's store bridge, for a child process to import. */
  bridge: string
  /** The consumer's fs bridge, likewise. */
  fsBridge: string
  /** The admitted public store module, for tests that drive it directly. */
  module: AccountStoreModule
  /** The same package's public lease helper. */
  fs: AccountLockModule
  /**
   * A repository over the pool, with its own store instance; `modules`
   * replaces the admitted ones, for a test that observes them.
   */
  open(
    exchange?: AccountTokenExchange,
    options?: AccountRepositoryFactoryOptions,
    modules?: AccountStoreModules,
  ): AccountRepository
}

/** Bound on disposing a test's repositories and removing its directory. */
const POOL_CLEANUP_BOUND_MS = 20_000

/**
 * A disposable pool; `body` runs against the genuine store. Cleanup always
 * runs and is bounded: a body failure is rethrown, joined by any cleanup
 * failure, and a cleanup that does not finish reports how far it got.
 */
/**
 * A disposable directory, by its real path: the migration refuses a path
 * reached through a symbolic link (the system temporary directory often is).
 */
async function realTempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'agy-account-repository-')))
}

/**
 * A fresh account-store generation for a legacy file that never existed,
 * created by the migration's own initializer, and its bound paths.
 */
async function freshGeneration(
  admitted: AdmittedStore,
  dir: string,
): Promise<AccountStorePaths> {
  const legacyPath = join(dir, 'antigravity-accounts.json')
  const outcome = await initializeFreshAccountStore(admitted.migration, {
    legacyPath,
    now: () => Date.now(),
  })
  if (outcome.status !== 'completed') {
    throw new Error(`fresh initialization is ${outcome.status}`)
  }
  const binding = await readAccountStoreBinding(
    legacyPath,
    { store: admitted.module },
    () => Date.now(),
  )
  if (binding.status !== 'bound') {
    throw new Error(`the fresh generation did not bind: ${binding.status}`)
  }
  return binding.paths
}

async function withPool(body: (pool: Pool) => Promise<void>): Promise<void> {
  const admitted = await admittedStore()
  const { module, fs, bridge, fsBridge } = admitted
  const dir = await realTempDir()
  const paths = await freshGeneration(admitted, dir)
  const opened: AccountRepository[] = []
  let failure: { error: unknown } | undefined
  try {
    await body({
      dir,
      paths,
      bridge,
      fsBridge,
      module,
      fs,
      open(
        exchange = unusedExchange,
        options = {},
        modules = { store: module, fs },
      ) {
        const repository = createAccountRepositoryFactory(
          modules,
          options,
        )({
          paths,
          now: () => Date.now(),
          exchange,
        })
        opened.push(repository)
        return repository
      },
    })
  } catch (error) {
    failure = { error }
  }
  const progress = { disposed: 0, removed: false }
  const cleanup = (async () => {
    const errors: unknown[] = []
    for (const repository of opened) {
      try {
        await repository.dispose()
        progress.disposed += 1
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await rm(dir, { recursive: true, force: true })
      progress.removed = true
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
  })()
  let cleanupError: Error | undefined
  try {
    await bounded(cleanup, POOL_CLEANUP_BOUND_MS, `cleanup of ${dir}`)
  } catch (error) {
    cleanupError = new Error(
      `cleanup of ${dir} did not complete: disposed ${progress.disposed} of ${opened.length} repositories, directory removed: ${progress.removed}`,
      { cause: error },
    )
  }
  if (failure !== undefined) {
    if (cleanupError === undefined) throw failure.error
    throw new AggregateError(
      [failure.error, cleanupError],
      'the test failed and its cleanup failed',
    )
  }
  if (cleanupError !== undefined) throw cleanupError
}

/** A login input with the metadata every row needs, plus a test's fields. */
function login(
  id: string,
  refreshToken: string,
  metadata: Partial<ProviderMetadata> = {},
  identity?: string,
): AccountLoginInput {
  return {
    id,
    refreshToken,
    ...(identity !== undefined ? { identity } : {}),
    metadata: { addedAt: 1_000, lastUsed: 0, ...metadata },
  }
}

function ready(read: AccountRepositoryRead) {
  if (read.status !== 'ready') throw new Error(`pool is ${read.status}`)
  return read
}

async function rowOf(
  repository: AccountRepository,
  id: string,
): Promise<AccountRow> {
  const row = ready(await repository.read()).rows.find((r) => r.ref.id === id)
  if (row === undefined) throw new Error(`no row ${id}`)
  return row
}

async function metadataOf(
  repository: AccountRepository,
  id: string,
): Promise<ProviderMetadata> {
  const row = await rowOf(repository, id)
  if (row.metadata.status !== 'present') {
    throw new Error(`row ${id} metadata is ${row.metadata.status}`)
  }
  return row.metadata.metadata
}

/** Awaits an operation that must fail and returns its repository failure. */
async function failureOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof AccountRepositoryError) return error.failure
    throw error
  }
  throw new Error('the operation was expected to fail')
}

/** Waits for `promise`, failing once `ms` pass without it settling. */
async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)),
      ms,
    )
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Polls `predicate` until it holds, failing after five seconds. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Gates that hold fake exchanges open. Every gate a test creates is opened
 * when the test's body ends, whether it passed or failed, so no held
 * exchange (and no store lock it holds) outlives the test.
 */
class Gates {
  private readonly openers: Array<() => void> = []

  hold(): { opened: Promise<void>; open: () => void } {
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    this.openers.push(open)
    return { opened, open }
  }

  openAll(): void {
    for (const open of this.openers) open()
  }
}

async function withGates<T>(body: (gates: Gates) => Promise<T>): Promise<T> {
  const gates = new Gates()
  try {
    return await body(gates)
  } finally {
    gates.openAll()
  }
}

/**
 * Counted acknowledgments: code under test raises a name each time it
 * reaches a point, and a test waits until a name has been raised `count`
 * times, instead of sleeping and assuming the point was reached.
 */
class Signals {
  private readonly counts = new Map<string, number>()
  private readonly waiters: Array<{
    name: string
    count: number
    resolve: () => void
  }> = []

  raise(name: string): void {
    const count = (this.counts.get(name) ?? 0) + 1
    this.counts.set(name, count)
    for (const waiter of [...this.waiters]) {
      if (waiter.name === name && waiter.count <= count) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }

  count(name: string): number {
    return this.counts.get(name) ?? 0
  }

  wait(name: string, count: number): Promise<void> {
    if (this.count(name) >= count) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push({ name, count, resolve })
    })
  }
}

interface OwnedChildResult {
  /** The child's process id, as spawned (it shares this process's group). */
  pid: number
  exitCode: number | null
  signalCode: string | null
  /** The child outlived `boundMs` and was signalled through its own handle. */
  timedOut: boolean
  /** Signals delivered to the child, in order. */
  signalsSent: string[]
  /** Signals whose delivery threw, each with the error message. */
  killFailures: string[]
  /** The child's exit was observed within the bounds. */
  reaped: boolean
  /**
   * `process.kill(pid, 0)` after the waits: `ESRCH` when no process has the
   * pid any more, `alive` when one does, otherwise the error code.
   */
  probe: string
  /** Failures of the waits themselves, in order; empty when none threw. */
  waitFailures: string[]
  stdout: CapturedOutput
  stderr: CapturedOutput
}

/** Bound on observing a child's exit after SIGKILL, and on its output pipes. */
const CHILD_REAP_BOUND_MS = 5_000
/** Output kept per pipe; a child writing more is stopped. */
const CHILD_OUTPUT_CAP_BYTES = 128 * 1024

/**
 * What was read from one output pipe. `text` is usable only when the pipe
 * was read to its end: neither `truncated` nor `readError` is set.
 */
interface CapturedOutput {
  text: string
  /** The pipe carried more than `CHILD_OUTPUT_CAP_BYTES`; the rest was dropped. */
  truncated: boolean
  /** Reading failed, or the pipe was still open after `CHILD_REAP_BOUND_MS`. */
  readError?: string
}

/**
 * Reads a pipe, keeping at most `CHILD_OUTPUT_CAP_BYTES`. On overflow it
 * calls `onOverflow` (which stops the child) and cancels the read without
 * waiting for the cancellation. `finish` waits at most `CHILD_REAP_BOUND_MS`
 * for the end of the pipe and never throws.
 */
function captureOutput(
  stream: ReadableStream<Uint8Array>,
  onOverflow: () => void,
): { finish(): Promise<CapturedOutput> } {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let kept = 0
  let truncated = false
  let readError: string | undefined
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        const room = CHILD_OUTPUT_CAP_BYTES - kept
        chunks.push(value.subarray(0, Math.max(0, room)))
        kept += Math.min(value.byteLength, Math.max(0, room))
        if (value.byteLength > room) {
          truncated = true
          onOverflow()
          reader.cancel().catch(() => {})
          return
        }
      }
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error)
    }
  })()
  return {
    async finish() {
      if ((await settledWithin(reading, CHILD_REAP_BOUND_MS)) === 'bound') {
        readError ??= `still open after ${CHILD_REAP_BOUND_MS} ms`
        reader.cancel().catch(() => {})
      }
      const bytes = new Uint8Array(kept)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return {
        text: new TextDecoder().decode(bytes),
        truncated,
        ...(readError !== undefined ? { readError } : {}),
      }
    },
  }
}

/** The text of a pipe read to its end, or an error saying why it was not. */
function completeOutput(output: CapturedOutput, name: string): string {
  if (output.truncated || output.readError !== undefined) {
    throw new Error(
      `the child's ${name} was not read completely (truncated ${output.truncated}, error ${output.readError ?? 'none'})`,
    )
  }
  return output.text
}

/**
 * `settled` once `promise` resolves or rejects, or `bound` after `ms`,
 * whichever comes first; the timer is cleared either way.
 */
async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<'settled' | 'bound'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), ms)
  })
  try {
    const settled = () => 'settled' as const
    // A rejection settles the wait too; the caller reads the outcome itself.
    return await Promise.race([promise.then(settled, settled), bound])
  } finally {
    clearTimeout(timer)
  }
}

function probeProcess(pid: number): string {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
      ? error.code
      : 'error'
  }
}

/**
 * Runs a child process this test owns, within bounds. A child that outlives
 * `boundMs` is sent SIGTERM through its own handle, then SIGKILL if it is
 * still running `termGraceMs` later; its exit is then awaited for at most
 * `CHILD_REAP_BOUND_MS`. A child writing more than `CHILD_OUTPUT_CAP_BYTES`
 * to a pipe is sent SIGTERM the same way. Every wait is finite and nothing
 * here throws: the result says whether the exit was actually observed
 * (`reaped`), which signals were sent or failed, what the waits and reads
 * hit, and what probing the pid found. Callers refuse any result that is not
 * a clean, observed exit. The child is never detached and no other process
 * is signalled.
 */
async function runOwnedChild(
  argv: string[],
  options: {
    cwd: string
    env: Record<string, string>
    boundMs: number
    termGraceMs?: number
  },
): Promise<OwnedChildResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const signalsSent: string[] = []
  const killFailures: string[] = []
  const waitFailures: string[] = []
  const send = (signal: 'SIGTERM' | 'SIGKILL') => {
    try {
      child.kill(signal)
      signalsSent.push(signal)
    } catch (error) {
      killFailures.push(
        `${signal}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const stopOnOverflow = () => {
    if (!signalsSent.includes('SIGTERM')) send('SIGTERM')
  }
  const stdout = captureOutput(child.stdout, stopOnOverflow)
  const stderr = captureOutput(child.stderr, stopOnOverflow)
  // An exit counts as observed only when the handle reports a status; a
  // signal having been sent proves nothing.
  const exitObserved = async (ms: number) =>
    (await settledWithin(child.exited, ms)) === 'settled' &&
    (child.exitCode !== null || child.signalCode !== null)
  let timedOut = false
  let reaped = false
  try {
    if (await exitObserved(options.boundMs)) {
      reaped = true
    } else {
      timedOut = true
      send('SIGTERM')
      if (await exitObserved(options.termGraceMs ?? 5_000)) {
        reaped = true
      } else {
        send('SIGKILL')
        reaped = await exitObserved(CHILD_REAP_BOUND_MS)
      }
    }
  } catch (error) {
    waitFailures.push(
      `wait: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!reaped) {
    // A last, bounded observation whatever was sent before; SIGKILL only if
    // the handle still reports the child running and none was sent yet.
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      !signalsSent.includes('SIGKILL')
    ) {
      send('SIGKILL')
    }
    try {
      reaped = await exitObserved(CHILD_REAP_BOUND_MS)
    } catch (error) {
      waitFailures.push(
        `final wait: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return {
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    timedOut,
    signalsSent,
    killFailures,
    reaped,
    probe: probeProcess(child.pid),
    waitFailures,
    stdout: await stdout.finish(),
    stderr: await stderr.finish(),
  }
}

describe('management records and transfer files', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const inputDigest = 'a'.repeat(64)
  const record = (overrides: Record<string, unknown>) => ({
    id,
    kind: 'replace-pool',
    targets: ['old-1', 'old-2'],
    progress: { step: 'remove', completedTargets: ['old-1'] },
    inputDigest,
    ...overrides,
  })

  it('reads the records clear and replacePool write', () => {
    expect(decodeManagementRecord(record({}))).toEqual({
      id,
      kind: 'replace-pool',
      targets: ['old-1', 'old-2'],
      progress: { step: 'remove', completedTargets: ['old-1'] },
      inputDigest,
    })
    // While inputs are added, the completed ids are new rows, not targets.
    expect(
      decodeManagementRecord(
        record({ progress: { step: 'add', completedTargets: ['new-1'] } }),
      ).progress.completedTargets,
    ).toEqual(['new-1'])
    expect(
      decodeManagementRecord(
        record({ progress: { step: 'verified', completedTargets: ['new-1'] } }),
      ).progress.step,
    ).toBe('verified')
    expect(
      decodeManagementRecord(
        record({
          kind: 'clear',
          progress: { step: 'remove', completedTargets: [] },
          inputDigest: undefined,
        }),
      ).kind,
    ).toBe('clear')
  })

  it("accepts a migration record only at the migration's published phases", () => {
    const migration = (step: string) =>
      record({
        kind: 'migration',
        targets: [],
        progress: { step, completedTargets: [] },
        inputDigest: undefined,
      })
    for (const step of ACCOUNT_MIGRATION_MANAGEMENT_STEPS) {
      expect(decodeManagementRecord(migration(step)).progress.step).toBe(step)
    }
    expect(() => decodeManagementRecord(migration('anything'))).toThrow(
      '$.progress.step',
    )
  })

  it('identifies replacement inputs by every field, in order', () => {
    const one = login('new-1', 'tok-1', { email: 'one@example.test' })
    const two = login('new-2', 'tok-2')
    const digest = replacementInputDigest([one, two])
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(replacementInputDigest([one, two])).toBe(digest)
    for (const other of [
      [two, one],
      [{ ...one, id: 'new-3' }, two],
      [{ ...one, refreshToken: 'tok-3' }, two],
      [{ ...one, identity: 'acct-1' }, two],
      [{ ...one, metadata: { ...one.metadata, label: 'Work' } }, two],
      [one],
    ]) {
      expect(replacementInputDigest(other)).not.toBe(digest)
    }
  })

  it('refuses ids that could select a path, unknown steps and repeated ids', () => {
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ id: '../../config' }, '$.id'],
      [{ id: id.toUpperCase() }, '$.id'],
      [
        { kind: 'clear', progress: { step: 'add', completedTargets: [] } },
        '$.progress.step',
      ],
      [
        { progress: { step: 'verify', completedTargets: [] } },
        '$.progress.step',
      ],
      [{ inputDigest: undefined }, '$.inputDigest'],
      [{ inputDigest: 'A'.repeat(64) }, '$.inputDigest'],
      [
        {
          kind: 'clear',
          progress: { step: 'remove', completedTargets: [] },
        },
        '$.inputDigest',
      ],
      [{ targets: ['old-1', 'old-1'] }, '$.targets'],
      [{ targets: ['old-1', ''] }, '$.targets'],
      [
        { progress: { step: 'add', completedTargets: ['new-1', 'new-1'] } },
        '$.progress.completedTargets',
      ],
      [
        { progress: { step: 'remove', completedTargets: ['other'] } },
        '$.progress.completedTargets',
      ],
    ]
    for (const [overrides, path] of refused) {
      expect(() => decodeManagementRecord(record(overrides))).toThrow(path)
    }
  })

  it('reads only a transfer file of this record with inputs replacePool accepts', () => {
    const input = {
      id: 'new-1',
      refreshToken: 'tok-1',
      metadata: encodeProviderMetadata({ addedAt: 1, lastUsed: 0 }),
    }
    const file = (inputs: unknown[], managementId = id) => ({
      schemaVersion: 1,
      managementId,
      inputs,
    })
    expect(decodeTransferFile(file([input]), id).map((i) => i.id)).toEqual([
      'new-1',
    ])
    expect(() => decodeTransferFile(file([input], 'another'), id)).toThrow(
      'does not belong',
    )
    expect(() =>
      decodeTransferFile({ ...file([input]), schemaVersion: 2 }, id),
    ).toThrow('does not belong')
    expect(() => decodeTransferFile(file([input, input]), id)).toThrow(
      'must not repeat an id',
    )
    expect(() =>
      decodeTransferFile(file([{ ...input, refreshToken: ' ' }]), id),
    ).toThrow('must not be empty')
  })
})

describe('real-store harness', () => {
  it('refuses a missing consumer, bridge, package or payload before importing anything', async () => {
    // No consumer, or a directory the shared fixture did not provision.
    const stray = await mkdtemp(join(tmpdir(), 'agy-store-consumer-'))
    try {
      for (const consumer of [undefined, '', stray]) {
        await expect(admitStoreConsumer(consumer)).rejects.toThrow(
          'explicit worktree-local public package fixture required',
        )
      }
    } finally {
      await rm(stray, { recursive: true, force: true })
    }
    // A well-formed fixture name that was never provisioned.
    await expect(
      admitStoreConsumer(
        join(
          PUBLIC_CONSUMER_PROJECT_ROOT,
          'node_modules',
          '.common-auth-public-consumer-missing',
        ),
      ),
    ).rejects.toThrow('ENOENT')

    const fixture = await provisionPublicConsumer()
    try {
      expect(await admitStoreConsumer(fixture.root)).toEqual({
        bridge: join(fixture.root, STORE_BRIDGE_FILE),
        fsBridge: join(fixture.root, FS_BRIDGE_FILE),
      })
      const changes: Array<[string, string, string]> = [
        // A bridge to a file inside the package is not the public entry.
        [
          STORE_BRIDGE_FILE,
          `export * from './node_modules/${STORE_PACKAGE_NAME}/dist/store/index.js'\n`,
          'public consumer entrypoint bytes differ: store',
        ],
        // Another version of the package, with otherwise identical bytes.
        [
          `node_modules/${STORE_PACKAGE_NAME}/package.json`,
          'version',
          'public payload byte identity differs: package/package.json',
        ],
        // A changed store payload.
        [
          `node_modules/${STORE_PACKAGE_NAME}/dist/store/index.js`,
          'export const openPoolStore = 1\n',
          'public payload byte identity differs: package/dist/store/index.js',
        ],
      ]
      for (const [path, replacement, message] of changes) {
        const file = join(fixture.root, path)
        const original = await publicFixtureBytes(file)
        const changed =
          replacement === 'version'
            ? `${JSON.stringify({ ...JSON.parse(original.toString()), version: '0.11.4' })}\n`
            : replacement
        await writeFile(file, changed)
        try {
          await expect(admitStoreConsumer(fixture.root)).rejects.toThrow(
            message,
          )
        } finally {
          await writeFile(file, original)
        }
      }
      // Restoring every change admits the consumer again.
      await admitStoreConsumer(fixture.root)
    } finally {
      await fixture.remove()
    }
  })

  it('releases every held gate when the body fails', async () => {
    let held: Promise<void> | undefined
    await expect(
      withGates(async (gates) => {
        held = gates.hold().opened
        throw new Error('assertion failed while an exchange was held')
      }),
    ).rejects.toThrow('assertion failed')
    if (held === undefined) throw new Error('no gate was held')
    await bounded(held, 1_000, 'the gate to open')
  })

  it('bounds a wait and reports what it waited for', async () => {
    await expect(bounded(new Promise(() => {}), 20, 'nothing')).rejects.toThrow(
      'timed out after 20 ms waiting for nothing',
    )
    expect(await bounded(Promise.resolve(7), 1_000, 'a value')).toBe(7)
  })

  it('reports whether a wait settled within its bound, clearing its timer', async () => {
    expect(await settledWithin(new Promise(() => {}), 20)).toBe('bound')
    expect(await settledWithin(Promise.resolve(), 1_000)).toBe('settled')
    expect(await settledWithin(Promise.reject(new Error('x')), 1_000)).toBe(
      'settled',
    )
    // Probing with signal 0 sends nothing; this process is alive.
    expect(probeProcess(process.pid)).toBe('alive')
  })

  it('keeps at most the output cap, stops the writer once, and refuses partial output', async () => {
    let stops = 0
    const chunk = new Uint8Array(64 * 1024).fill(0x61)
    const flood = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    const captured = await captureOutput(flood, () => {
      stops += 1
    }).finish()
    expect(stops).toBe(1)
    expect(captured.truncated).toBe(true)
    expect(captured.text.length).toBe(CHILD_OUTPUT_CAP_BYTES)
    expect(() => completeOutput(captured, 'stdout')).toThrow(
      'not read completely',
    )

    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('pipe broke'))
      },
    })
    const failed = await captureOutput(broken, () => {
      stops += 1
    }).finish()
    expect(failed).toMatchObject({ truncated: false, readError: 'pipe broke' })
    expect(() => completeOutput(failed, 'stdout')).toThrow('pipe broke')

    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"main"}\n'))
        controller.close()
      },
    })
    const whole = await captureOutput(small, () => {
      stops += 1
    }).finish()
    expect(completeOutput(whole, 'stdout')).toBe('{"id":"main"}\n')
    expect(stops).toBe(1)
  })

  it('counts acknowledgments and wakes waiters at their count', async () => {
    const signals = new Signals()
    const second = signals.wait('point', 2)
    signals.raise('point')
    expect(signals.count('point')).toBe(1)
    signals.raise('point')
    await bounded(second, 1_000, 'the second acknowledgment')
    await bounded(signals.wait('point', 1), 1_000, 'an earlier count')
  })
})

/**
 * Each owned-child test may take its child's bounds plus the bounded waits
 * on its exit and its two output pipes.
 */
const CHILD_HELPER_SLACK_MS = 3 * CHILD_REAP_BOUND_MS

describe('owned child process', () => {
  it(
    'returns the exit status and output of a child that finishes',
    async () => {
      const result = await runOwnedChild(
        [process.execPath, '-e', 'console.log("done")'],
        {
          cwd: tmpdir(),
          env: { PATH: process.env.PATH ?? '' },
          boundMs: 5_000,
        },
      )
      expect(result.pid).toBeGreaterThan(0)
      expect(completeOutput(result.stdout, 'stdout')).toBe('done\n')
      expect(completeOutput(result.stderr, 'stderr')).toBe('')
      expect(result).toMatchObject({
        exitCode: 0,
        signalCode: null,
        timedOut: false,
        signalsSent: [],
        killFailures: [],
        reaped: true,
        probe: 'ESRCH',
        waitFailures: [],
        stdout: { text: 'done\n', truncated: false },
      })
    },
    5_000 + CHILD_TERM_GRACE_MS + CHILD_HELPER_SLACK_MS,
  )

  it(
    'stops a child that outlives its bound, through its own handle, and observes its exit',
    async () => {
      const result = await runOwnedChild(
        [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        {
          cwd: tmpdir(),
          env: { PATH: process.env.PATH ?? '' },
          boundMs: 200,
          termGraceMs: CHILD_TERM_GRACE_MS,
        },
      )
      expect(result).toMatchObject({
        timedOut: true,
        exitCode: null,
        signalCode: 'SIGTERM',
        signalsSent: ['SIGTERM'],
        killFailures: [],
        reaped: true,
        // No process has the pid once its exit was observed.
        probe: 'ESRCH',
        waitFailures: [],
      })
    },
    200 + CHILD_TERM_GRACE_MS + CHILD_HELPER_SLACK_MS,
  )

  it(
    'escalates to SIGKILL when the child ignores SIGTERM, and observes its exit',
    async () => {
      const result = await runOwnedChild(
        [
          process.execPath,
          '-e',
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
        ],
        {
          cwd: tmpdir(),
          env: { PATH: process.env.PATH ?? '' },
          boundMs: 200,
          termGraceMs: 200,
        },
      )
      expect(result).toMatchObject({
        timedOut: true,
        signalCode: 'SIGKILL',
        signalsSent: ['SIGTERM', 'SIGKILL'],
        killFailures: [],
        reaped: true,
        probe: 'ESRCH',
        waitFailures: [],
      })
    },
    200 + 200 + CHILD_HELPER_SLACK_MS,
  )
})

/**
 * Each real-store test may take its work plus its bounded cleanup; the
 * cross-process test also its child's bounds and the waits on its exit.
 */
const STORE_TEST_TIMEOUT_MS = STORE_TEST_WORK_MS + POOL_CLEANUP_BOUND_MS
const CHILD_STORE_TEST_TIMEOUT_MS =
  STORE_TEST_TIMEOUT_MS +
  CHILD_BOUND_MS +
  CHILD_TERM_GRACE_MS +
  CHILD_HELPER_SLACK_MS

describe('repository on the genuine public store', () => {
  it(
    'refuses work fenced on a replaced credential before writing',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const first = await repository.login(
          login('main', 'tok-1', { projectId: 'proj-1' }, 'acct-1'),
        )
        expect(first.outcome).toBe('added')
        const replaced = await repository.replaceCredential(first.ref, {
          refreshToken: 'tok-2',
          identity: 'acct-1',
          disabled: 'keep',
        })
        expect(replaced.ref.credentialEpoch).toBe(first.ref.credentialEpoch + 1)

        const stale = await failureOf(
          repository.replaceCredential(first.ref, {
            refreshToken: 'tok-3',
            identity: 'acct-1',
            disabled: 'keep',
          }),
        )
        expect(stale.kind).toBe('attribution')
        expect(stale.ambiguous).toBe(false)
        expect((await rowOf(repository, 'main')).credential?.refreshToken).toBe(
          'tok-2',
        )

        expect(
          (
            await failureOf(
              repository.recordProject(first.ref, { projectId: 'proj-stale' }),
            )
          ).kind,
        ).toBe('attribution')
        expect(
          (
            await failureOf(
              repository.recordQuota(first.ref, {
                schemaVersion: 1,
                cachedQuotaUpdatedAt: 1,
              }),
            )
          ).kind,
        ).toBe('attribution')
        expect(
          (
            await failureOf(
              repository.recordUsage(first.ref, { family: 'claude', at: 1 }),
            )
          ).kind,
        ).toBe('attribution')
        const row = await rowOf(repository, 'main')
        expect(row.quota.status).toBe('absent')
        expect(
          row.metadata.status === 'present' && row.metadata.metadata.projectId,
        ).toBe('proj-1')
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'keeps account metadata across a replace only for the locked same-account identity',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const { ref } = await repository.login(
          login(
            'main',
            'tok-1',
            {
              email: 'a@example.test',
              projectId: 'proj-1',
              label: 'Work',
              fingerprint: fingerprint('a'),
            },
            'acct-1',
          ),
        )
        await repository.recordRateLimits(ref, { claude: Date.now() + 60_000 })
        const same = await repository.replaceCredential(ref, {
          refreshToken: 'tok-2',
          identity: 'acct-1',
          disabled: 'keep',
        })
        const kept = await metadataOf(repository, 'main')
        expect(kept.email).toBe('a@example.test')
        expect(kept.projectId).toBe('proj-1')
        expect(kept.fingerprint).toEqual(fingerprint('a'))
        expect(kept.label).toBe('Work')
        expect('rateLimitResetTimes' in kept).toBe(false)

        await repository.replaceCredential(same.ref, {
          refreshToken: 'tok-3',
          identity: 'acct-2',
          disabled: 'keep',
        })
        const other = await metadataOf(repository, 'main')
        expect('email' in other).toBe(false)
        expect('projectId' in other).toBe(false)
        expect('fingerprint' in other).toBe(false)
        expect(other.label).toBe('Work')
        expect(other.addedAt).toBe(1_000)

        // A row with no recorded identity has no known prior identity, so an
        // incoming identity alone carries nothing across.
        const anonymous = await repository.login(
          login('anon', 'tok-9', { projectId: 'proj-9' }),
        )
        expect(anonymous.ref.identity).toBeUndefined()
        await repository.replaceCredential(anonymous.ref, {
          refreshToken: 'tok-10',
          identity: 'acct-9',
          disabled: 'keep',
        })
        expect('projectId' in (await metadataOf(repository, 'anon'))).toBe(
          false,
        )
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'adds up usage increments from two store instances and keeps the later rate limit',
    async () => {
      await withPool(async (pool) => {
        const a = pool.open()
        const b = pool.open()
        const { ref } = await a.login(login('main', 'tok-1', {}, 'acct-1'))
        const dayBefore = utcDay(Date.now())
        await Promise.all([
          ...Array.from({ length: 5 }, (_, i) =>
            a.recordUsage(ref, { family: 'claude', at: 100 + i }),
          ),
          ...Array.from({ length: 5 }, (_, i) =>
            b.recordUsage(ref, { family: 'claude', at: 200 + i }),
          ),
          b.recordUsage(ref, { family: 'gemini', at: 50 }),
        ])
        await Promise.all([
          a.recordRateLimits(ref, { claude: 900 }),
          b.recordRateLimits(ref, { claude: 500, 'gemini-cli': 700 }),
        ])
        const metadata = await metadataOf(a, 'main')
        expect([dayBefore, utcDay(Date.now())]).toContain(
          metadata.dailyRequestCounts?.date ?? '',
        )
        expect(metadata.dailyRequestCounts?.claude).toBe(10)
        expect(metadata.dailyRequestCounts?.gemini).toBe(1)
        expect(metadata.lastUsed).toBe(204)
        expect(metadata.rateLimitResetTimes).toEqual({
          claude: 900,
          'gemini-cli': 700,
        })
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses work for a removed row and for its id re-added by another process',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const gone = await repository.login(login('gone', 'tok-g'))
        await repository.remove(gone.ref)
        expect((await failureOf(repository.remove(gone.ref))).kind).toBe(
          'unknown-row',
        )
        expect(
          (
            await failureOf(
              repository.recordProject(gone.ref, { projectId: 'p' }),
            )
          ).kind,
        ).toBe('unknown-row')

        const main = await repository.login(
          login('main', 'tok-a', {}, 'acct-1'),
        )
        // Keep deletion in the parent store and recreation in the child.
        // A store refuses IDs it removed; deleting in the child's store
        // would prevent recreation before the stale-reference checks.
        await repository.remove(main.ref)
        const child = join(pool.dir, 'child.ts')
        await writeFile(
          child,
          [
            `import { createAccountRepositoryFactory } from ${JSON.stringify(
              pathToFileURL(join(import.meta.dir, 'account-repository.ts'))
                .href,
            )}`,
            `const store = await import(${JSON.stringify(
              pathToFileURL(pool.bridge).href,
            )})`,
            `const fs = await import(${JSON.stringify(
              pathToFileURL(pool.fsBridge).href,
            )})`,
            `const repository = createAccountRepositoryFactory({ store, fs })({`,
            `  paths: ${JSON.stringify(pool.paths)},`,
            `  now: () => Date.now(),`,
            `  exchange: async () => { throw new Error('no exchange') },`,
            `})`,
            `const added = await repository.login({ id: 'main', refreshToken: 'tok-b', identity: 'acct-1', metadata: { addedAt: 2, lastUsed: 0 } })`,
            `await repository.dispose()`,
            `console.log(JSON.stringify(added.ref))`,
          ].join('\n'),
        )
        const result = await runOwnedChild([process.execPath, child], {
          cwd: pool.dir,
          env: { PATH: process.env.PATH ?? '', HOME: pool.dir },
          boundMs: CHILD_BOUND_MS,
          termGraceMs: CHILD_TERM_GRACE_MS,
        })
        if (
          !result.reaped ||
          result.timedOut ||
          result.exitCode !== 0 ||
          result.killFailures.length > 0 ||
          result.waitFailures.length > 0
        ) {
          throw new Error(
            `child ${result.pid}: reaped ${result.reaped}, exit ${result.exitCode}, signal ${result.signalCode}, sent [${result.signalsSent.join(', ')}], kill failures [${result.killFailures.join('; ')}], wait failures [${result.waitFailures.join('; ')}], probe ${result.probe}${result.timedOut ? ', outlived its bound' : ''}: ${result.stderr.text}`,
          )
        }
        completeOutput(result.stderr, 'stderr')
        const readded: RowRef = JSON.parse(
          completeOutput(result.stdout, 'stdout').trim(),
        )
        expect(readded.id).toBe('main')
        expect(readded.identity).toBe('acct-1')
        expect(readded.credentialEpoch).toBeGreaterThan(
          main.ref.credentialEpoch,
        )

        // Same id, same identity: only the epoch tells the credentials apart.
        expect(
          (
            await failureOf(
              repository.recordProject(main.ref, { projectId: 'stale' }),
            )
          ).kind,
        ).toBe('attribution')
        expect((await failureOf(repository.remove(main.ref))).kind).toBe(
          'attribution',
        )
        expect((await rowOf(repository, 'main')).credential?.refreshToken).toBe(
          'tok-b',
        )
      })
    },
    CHILD_STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refreshes different accounts concurrently and one account one exchange at a time',
    async () => {
      await withPool((pool) =>
        // Every held exchange is released when the test ends, even when an
        // assertion fails, so no refresh or store lock outlives the test.
        withGates(async (owned) => {
          const active = new Map<string, number>()
          let maxSameAccount = 0
          let exchanges = 0
          const gates = new Map<string, ReturnType<Gates['hold']>>()
          const exchange: AccountTokenExchange = async ({
            refreshToken,
            row,
          }) => {
            const account = row.ref.identity ?? row.ref.id
            exchanges += 1
            active.set(account, (active.get(account) ?? 0) + 1)
            maxSameAccount = Math.max(maxSameAccount, active.get(account) ?? 0)
            const held = owned.hold()
            gates.set(account, held)
            await held.opened
            active.set(account, (active.get(account) ?? 1) - 1)
            return {
              accessToken: `access-${account}-${exchanges}`,
              refreshToken,
              expiresAt: Date.now() + 3_600_000,
            }
          }
          const setup = pool.open()
          const a = await setup.login(login('row-a', 'tok-a', {}, 'acct-a'))
          const b = await setup.login(login('row-b', 'tok-b', {}, 'acct-b'))
          const first = pool.open(exchange)
          // The follower's store reports, through the store's public
          // `onLockEvent`, when it finds a lock of row-a's refresh held:
          // its row lock (`row-<identity>`) or the per-account refresh lock.
          const signals = new Signals()
          const rowALocks = new Set([
            `row-${encodeURIComponent('acct-a')}`,
            refreshProviderLock(pool.paths.statePath, {
              id: 'row-a',
              identity: 'acct-a',
            }).name,
          ])
          const second = pool.open(exchange, {
            onLockEvent: (event) => {
              if (
                event.type === 'contended' &&
                event.path === pool.paths.statePath &&
                rowALocks.has(event.name)
              ) {
                signals.raise('follower-contended')
              }
            },
          })

          // Different accounts: both exchanges are in flight at once.
          const refreshA = first.refresh(a.ref)
          const refreshB = second.refresh(b.ref)
          await until(
            () => gates.has('acct-a') && gates.has('acct-b'),
            'both exchanges',
          )
          gates.get('acct-a')?.open()
          gates.get('acct-b')?.open()
          expect((await refreshA).status).toBe('rotated')
          expect((await refreshB).status).toBe('rotated')

          // One account, two store instances: the second waits on the row and
          // per-account locks, re-reads the committed successor and stops.
          gates.clear()
          exchanges = 0
          const fresh = (row: AccountRow) =>
            (row.credential?.expiresAt ?? 0) > Date.now() + 1_800_000
              ? 'fresh'
              : undefined
          await second.replaceCredential(a.ref, {
            refreshToken: 'tok-a2',
            identity: 'acct-a',
            disabled: 'keep',
          })
          const aRef = (await rowOf(setup, 'row-a')).ref
          const leader = first.refresh(aRef)
          await until(() => gates.has('acct-a'), 'the leading exchange')
          const follower = second.refresh(aRef, { refuse: fresh })
          // The leader is released only once the follower's store has found
          // one of row-a's locks held: a refresh that let go of its locks
          // during the exchange never makes the follower wait, and fails here.
          await bounded(
            signals.wait('follower-contended', 1),
            5_000,
            "the follower to find row-a's refresh locks held",
          )
          expect(exchanges).toBe(1)
          gates.get('acct-a')?.open()
          const led = await leader
          const followed = await follower
          expect(led.status).toBe('rotated')
          expect(followed).toEqual({
            status: 'refused',
            ref: aRef,
            reason: 'fresh',
          })
          expect(exchanges).toBe(1)
          expect(maxSameAccount).toBe(1)

          // In one process, concurrent refreshes of one credential share one call.
          gates.clear()
          const latest = (await rowOf(setup, 'row-b')).ref
          const one = first.refresh(latest)
          const two = first.refresh(latest)
          expect(two).toBe(one)
          await until(() => gates.has('acct-b'), 'the shared exchange')
          gates.get('acct-b')?.open()
          expect((await one).status).toBe('rotated')
        }),
      )
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses a refresh of a replaced credential without calling the provider',
    async () => {
      await withPool(async (pool) => {
        let calls = 0
        const repository = pool.open(async ({ refreshToken }) => {
          calls += 1
          return {
            accessToken: 'x',
            refreshToken,
            expiresAt: Date.now() + 60_000,
          }
        })
        const { ref } = await repository.login(
          login('main', 'tok-1', {}, 'acct-1'),
        )
        await repository.replaceCredential(ref, {
          refreshToken: 'tok-2',
          identity: 'acct-1',
          disabled: 'keep',
        })
        expect((await failureOf(repository.refresh(ref))).kind).toBe(
          'attribution',
        )
        expect(calls).toBe(0)
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'commits refreshed metadata without dropping fields the exchange left out',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open(async ({ refreshToken, row }) => {
          expect(row.metadata.status).toBe('present')
          return {
            accessToken: 'access-1',
            refreshToken: `${refreshToken}-next`,
            expiresAt: Date.now() + 60_000,
            identity: 'acct-learnt',
            metadata: { capturedTierId: 'paid-tier', lastUsed: 1 },
          }
        })
        const { ref } = await repository.login(
          login('main', 'tok-1', { projectId: 'proj-1', lastUsed: 4_000 }),
        )
        const outcome = await repository.refresh(ref)
        expect(outcome.status).toBe('rotated')
        if (outcome.status !== 'rotated') return
        expect(outcome.ref).toEqual({
          id: 'main',
          credentialEpoch: ref.credentialEpoch,
          identity: 'acct-learnt',
        })
        const row = await rowOf(repository, 'main')
        expect(row.credential?.refreshToken).toBe('tok-1-next')
        expect(row.ref).toEqual(outcome.ref)
        const metadata = await metadataOf(repository, 'main')
        expect(metadata.projectId).toBe('proj-1')
        expect(metadata.capturedTierId).toBe('paid-tier')
        expect(metadata.lastUsed).toBe(4_000)
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'lands access verdicts with the enabled flag and declines stale ones',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const { ref } = await repository.login(
          login('main', 'tok-1', {}, 'acct-1'),
        )
        const blocked = await repository.recordAccessVerdict(ref, {
          kind: 'ineligible',
          observedAt: 2_000,
          reason: 'blocked',
        })
        expect(blocked.metadata?.accountIneligible).toBe(true)
        expect((await rowOf(repository, 'main')).enabled).toBe(false)

        const late = await repository.recordAccessVerdict(ref, {
          kind: 'verification-required',
          observedAt: 1_000,
        })
        expect(late.declined).toBe(true)
        expect((await metadataOf(repository, 'main')).accountIneligible).toBe(
          true,
        )

        expect(
          (
            await failureOf(
              repository.setEnabled(ref, { enabled: true, actor: 'user' }),
            )
          ).kind,
        ).toBe('account-ineligible')
        expect((await rowOf(repository, 'main')).enabled).toBe(false)

        await repository.recordAccessVerdict(ref, {
          kind: 'cleared',
          observedAt: 3_000,
          enable: true,
        })
        const row = await rowOf(repository, 'main')
        expect(row.enabled).toBe(true)
        expect(
          row.metadata.status === 'present' && row.metadata.metadata.enabled,
        ).toBe(true)
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'matches logins by exact email, then by secret',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const first = await repository.login(
          login('main', 'tok-1', { email: 'a@example.test' }),
        )
        const again = await repository.login(
          login('other-id', 'tok-1', { email: 'a@example.test' }),
        )
        expect(again.ref.id).toBe('main')
        expect(again.ref.credentialEpoch).toBe(first.ref.credentialEpoch)
        const second = await failureOf(
          repository.login(
            login('new-id', 'tok-2', { email: 'a@example.test' }),
          ),
        )
        expect(second.kind).toBe('duplicate-identity')
        expect(second.rowId).toBe('main')
        expect(ready(await repository.read()).rows).toHaveLength(1)
        // Exact match only: another case is another email.
        await repository.login(
          login('upper', 'tok-3', { email: 'A@example.test' }),
        )
        expect(ready(await repository.read()).rows).toHaveLength(2)
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'selects, reorders, clears and replaces the pool',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const a = await repository.login(login('a', 'tok-a'))
        const b = await repository.login(login('b', 'tok-b'))
        await repository.selectAccount('claude', b.ref)
        await repository.reorder(['b', 'a'])
        const read = ready(await repository.read())
        expect(read.rows.map((row) => row.ref.id)).toEqual(['b', 'a'])
        expect(read.routing?.activeRowByFamily?.claude).toEqual(b.ref)

        const cleared = await repository.clear()
        expect(cleared.outcome).toBe('completed')
        expect(cleared.management.targets).toEqual(['b', 'a'])
        expect(ready(await repository.read()).rows).toHaveLength(0)
        expect(
          (
            await failureOf(
              repository.recordUsage(a.ref, { family: 'claude', at: 1 }),
            )
          ).kind,
        ).toBe('unknown-row')

        const replaced = await repository.replacePool([
          login('x', 'tok-x', { email: 'x@example.test' }),
          login('y', 'tok-y', { email: 'y@example.test' }),
        ])
        expect(replaced.outcome).toBe('completed')
        const after = ready(await repository.read())
        expect(after.rows.map((row) => row.credential?.refreshToken)).toEqual([
          'tok-x',
          'tok-y',
        ])
        expect(await readdir(pool.paths.transfersDir)).toEqual([])
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'drains on flush and dispose, reports failures and then refuses work',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open(async () => {
          throw new Error('provider unavailable')
        })
        const { ref } = await repository.login(
          login('main', 'tok-1', {}, 'acct-1'),
        )
        const refreshFailure = await failureOf(repository.refresh(ref))
        expect(refreshFailure.kind).toBe('provider')
        const flushed = await repository.flush()
        expect(flushed.failures.map((failure) => failure.kind)).toEqual([
          'provider',
        ])
        expect(flushed.completed).toBe(1)

        const usage = repository.recordUsage(ref, { family: 'gemini', at: 7 })
        const disposed = await repository.dispose()
        expect(disposed.completed).toBe(1)
        expect(disposed.failures).toEqual([])
        expect((await usage).dailyRequestCounts.gemini).toBe(1)
        expect((await failureOf(repository.read())).kind).toBe('disposed')
        expect(
          (await failureOf(repository.login(login('late', 'tok-late')))).kind,
        ).toBe('disposed')
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )
})

/** A store instance the test drives directly, opened as the repository opens it. */
function openStoreDirectly(pool: Pool) {
  return pool.module.openPoolStore({
    provider: ACCOUNT_STORE_PROVIDER,
    configPath: pool.paths.configPath,
    statePath: pool.paths.statePath,
    quota: QUOTA_CODEC,
    providerState: createProviderStateCodec(ACCOUNT_STATE_POLICY),
    requireCredentialStamps: true,
    now: () => Date.now(),
  })
}

/**
 * Wraps the supplied genuine public `fs.withLock`, which still takes and
 * releases every lease itself, and records what happens around the
 * topology lease (`antigravity-topology`) only: raises `<label>-requested`
 * when it is asked for and `<label>-entered` once it is held, and appends
 * `<label>-entered` and `<label>-left` to `trace` around the holder's work.
 * Other leases taken through it (the store's save locks around binding)
 * pass through unrecorded.
 */
function tracedLocks(
  fs: AccountLockModule,
  signals: Signals,
  label: string,
  trace: string[] = [],
): AccountLockModule {
  return {
    ...fs,
    withLock: <T>(
      target: string,
      options: Parameters<AccountLockModule['withLock']>[1],
      fn: (lease: AccountLease) => Promise<T>,
    ): Promise<T> => {
      if (options.name !== 'antigravity-topology') {
        return fs.withLock(target, options, fn)
      }
      signals.raise(`${label}-requested`)
      return fs.withLock(target, options, async (lease) => {
        signals.raise(`${label}-entered`)
        trace.push(`${label}-entered`)
        try {
          return await fn(lease)
        } finally {
          trace.push(`${label}-left`)
        }
      })
    },
  }
}

describe('management on the genuine public store', () => {
  it(
    'orders a login after a clear holding the topology lease, while refreshes go on',
    async () => {
      await withPool((pool) =>
        withGates(async (owned) => {
          const signals = new Signals()
          const order: string[] = []
          const managementLock = {
            name: MANAGEMENT_LOCK_NAME,
            path: pool.paths.configPath,
          }
          const setup = pool.open()
          await setup.login(login('holder', 'tok-holder', {}, 'acct-holder'))
          // A login that finished before clear read its targets is cleared.
          await setup.login(login('a1', 'tok-a1', {}, 'acct-a1'))
          // The holder is a refresh of row `holder`: a refresh keeps its extra
          // locks across its exchange without the store's save locks, so this
          // one holds the management lock while clear, which already holds
          // the topology lease, waits for it. The refresh's provider lock
          // (`test-holder`) is distinct from the shared provider lock a login
          // takes, so it does not hold up the late login below.
          const holder = openStoreDirectly(pool)
          const held = owned.hold()
          const holdOptions = {
            providerLock: { name: 'test-holder', path: pool.paths.statePath },
            extraLocks: [managementLock],
            refuse: async () => undefined,
          }
          const holding = holder
            .refresh(
              'holder',
              async () => {
                signals.raise('holding')
                await held.opened
                throw new Error('the holder lets go of the management lock')
              },
              holdOptions,
            )
            .catch(() => undefined)
          await bounded(
            signals.wait('holding', 1),
            5_000,
            'the management lock to be held',
          )
          const clearing = pool.open(unusedExchange, {
            onLockEvent: (event) => {
              if (
                event.type === 'contended' &&
                event.name === MANAGEMENT_LOCK_NAME
              ) {
                signals.raise('clear-waiting')
              }
            },
          })
          const cleared = clearing.clear().then((receipt) => {
            order.push('clear-done')
            return receipt
          })
          // `clear` holds the topology lease, has read its targets and
          // waits to write its record.
          await bounded(
            signals.wait('clear-waiting', 1),
            5_000,
            'clear to wait for the management lock',
          )

          // Refreshes do not take the topology lease: this one completes
          // while clear holds it.
          const refresher = pool.open(async ({ refreshToken }) => ({
            accessToken: 'access-a1',
            refreshToken,
            expiresAt: Date.now() + 3_600_000,
          }))
          const a1 = await rowOf(setup, 'a1')
          const refreshed = await bounded(
            refresher.refresh(a1.ref),
            5_000,
            'a refresh while clear holds the topology lease',
          )
          expect(refreshed.status).toBe('rotated')

          // The late login requests the topology lease clear holds. Its commit
          // is recorded when it happens; the test releases clear's barrier
          // without waiting for that commit.
          const late = pool.open(
            unusedExchange,
            {},
            { store: pool.module, fs: tracedLocks(pool.fs, signals, 'late') },
          )
          const lateLogin = late
            .login(login('late', 'tok-late'))
            .then((result) => {
              order.push('late-committed')
              return result
            })
          await bounded(
            Promise.race([signals.wait('late-requested', 1), lateLogin]),
            5_000,
            'the late login to ask for the topology lease',
          )
          expect(signals.count('late-entered')).toBe(0)
          held.open()
          await holding
          const receipt = await cleared
          expect(receipt.outcome).toBe('completed')
          await lateLogin
          expect(order).toEqual(['clear-done', 'late-committed'])
          // The late login is an ordinary login after the clear.
          expect(
            ready(await setup.read()).rows.map((row) => row.ref.id),
          ).toEqual(['late'])
        }),
      )
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'lets one resumer of a replacement run at a time, so none writes from a stale step',
    async () => {
      await withPool((pool) =>
        withGates(async (owned) => {
          const signals = new Signals()
          const trace: string[] = []
          const setup = pool.open()
          await setup.login(login('old-1', 'tok-old-1'))
          const inputs = [
            login('new-1', 'tok-new-1', { email: 'n1@example.test' }),
            login('new-2', 'tok-new-2', { email: 'n2@example.test' }),
          ]
          // The first replacement records the `add` step, pauses inside the
          // topology lease before its first add, and then receives the
          // injected failure there.
          const held = owned.hold()
          let stopNextAdd = true
          const stopping: AccountStoreModule = {
            ...pool.module,
            openPoolStore: (options) => {
              const store = pool.module.openPoolStore(options)
              return {
                ...store,
                add: async (input) => {
                  if (!stopNextAdd) return store.add(input)
                  stopNextAdd = false
                  signals.raise('first-adding')
                  await held.opened
                  throw new Error('injected fault in the first replacement')
                },
              }
            },
          }
          const first = pool.open(
            unusedExchange,
            {},
            {
              store: stopping,
              fs: tracedLocks(pool.fs, signals, 'first', trace),
            },
          )
          const second = pool.open(
            unusedExchange,
            {},
            {
              store: pool.module,
              fs: tracedLocks(pool.fs, signals, 'second', trace),
            },
          )
          const firstRun = first.replacePool(inputs).then(
            () => undefined,
            (error: unknown) => error,
          )
          await bounded(
            signals.wait('first-adding', 1),
            5_000,
            'the first replacement to reach its first add',
          )
          const secondRun = second.replacePool(inputs)
          await bounded(
            Promise.race([signals.wait('second-requested', 1), secondRun]),
            5_000,
            'the second replacement to ask for the topology lease',
          )
          expect(signals.count('second-entered')).toBe(0)
          held.open()
          const firstFailure = await firstRun
          expect(
            firstFailure instanceof AccountRepositoryError
              ? firstFailure.failure.message
              : String(firstFailure),
          ).toContain('injected fault')
          const receipt = await secondRun
          expect(receipt.outcome).toBe('completed')
          expect(trace).toEqual([
            'first-entered',
            'first-left',
            'second-entered',
            'second-left',
          ])
          expect(await readdir(pool.paths.transfersDir)).toEqual([])
          expect(
            ready(await setup.read()).rows.map(
              (row) => row.credential?.refreshToken,
            ),
          ).toEqual(['tok-new-1', 'tok-new-2'])
        }),
      )
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses to report a clear completed when its journal names another operation at the final write',
    async () => {
      await withPool(async (pool) => {
        const managementLock = {
          name: MANAGEMENT_LOCK_NAME,
          path: pool.paths.configPath,
        }
        const successor = {
          id: '3b241101-e2bb-4255-8caf-4136c566a962',
          kind: 'clear',
          targets: [],
          progress: { step: 'remove', completedTargets: [] },
        }
        // The genuine public store, with a test-injected fault: just before
        // the write that would drop the record, another operation's record
        // is written in its place through the same store, so the locked
        // check of that final write finds a successor.
        let armed = true
        const replacing: AccountStoreModule = {
          ...pool.module,
          openPoolStore: (options) => {
            const store = pool.module.openPoolStore(options)
            return {
              ...store,
              updateSettings: async (mutator, settingsOptions) => {
                if (armed) {
                  const current = await store.readSettings()
                  const settings =
                    current.status === 'error' ? undefined : current.settings
                  const next =
                    settings === undefined
                      ? undefined
                      : mutator({ ...settings })
                  if (
                    settings?.[MANAGEMENT_SETTINGS_KEY] !== undefined &&
                    next !== undefined &&
                    next[MANAGEMENT_SETTINGS_KEY] === undefined
                  ) {
                    armed = false
                    await store.updateSettings(
                      (latest) => ({
                        ...latest,
                        [MANAGEMENT_SETTINGS_KEY]: successor,
                      }),
                      { extraLocks: [managementLock] },
                    )
                  }
                }
                return store.updateSettings(mutator, settingsOptions)
              },
            }
          },
        }
        const setup = pool.open()
        await setup.login(login('old-1', 'tok-old-1'))
        const clearing = pool.open(
          unusedExchange,
          {},
          {
            store: replacing,
            fs: pool.fs,
          },
        )
        const refused = await failureOf(clearing.clear())
        expect(armed).toBe(false)
        expect(refused.kind).toBe('management-pending')
        // Refusing the clear left the successor's management record untouched.
        const read = await setup.read()
        expect(
          read.status === 'management-pending'
            ? read.management.id
            : read.status,
        ).toBe(successor.id)
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'finishes a replacement interrupted after verifying, with or without its transfer file',
    async () => {
      for (const transferKept of [true, false]) {
        await withPool(async (pool) => {
          const repository = pool.open()
          const inputs = [
            login('new-1', 'tok-new-1', { email: 'n1@example.test' }),
            login('new-2', 'tok-new-2', { email: 'n2@example.test' }),
          ]
          // The state a replacement leaves once its new rows are verified:
          // the old rows gone, the inputs added, the record at `verified`.
          for (const input of inputs) await repository.login(input)
          const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
          const store = openStoreDirectly(pool)
          await store.updateSettings(
            (settings) => ({
              ...settings,
              [MANAGEMENT_SETTINGS_KEY]: {
                id,
                kind: 'replace-pool',
                targets: ['old-1'],
                progress: {
                  step: 'verified',
                  completedTargets: inputs.map((input) => input.id),
                },
                inputDigest: replacementInputDigest(inputs),
              },
            }),
            {
              extraLocks: [
                { name: MANAGEMENT_LOCK_NAME, path: pool.paths.configPath },
              ],
            },
          )
          await mkdir(pool.paths.transfersDir, { recursive: true, mode: 0o700 })
          if (transferKept) {
            await writeFile(
              join(pool.paths.transfersDir, `${id}.json`),
              JSON.stringify({
                schemaVersion: 1,
                managementId: id,
                inputs: inputs.map((input) => ({
                  id: input.id,
                  refreshToken: input.refreshToken,
                  metadata: encodeProviderMetadata(input.metadata),
                })),
              }),
              { mode: 0o600 },
            )
          }
          // Other inputs are refused even though no transfer file is left
          // to compare them with: the record's digest names the inputs.
          const other = await failureOf(
            repository.replacePool([
              login('new-1', 'tok-new-1', { email: 'other@example.test' }),
              inputs[1] ?? login('missing', 'missing'),
            ]),
          )
          expect(other.kind).toBe('management-pending')
          expect((await repository.read()).status).toBe('management-pending')
          const receipt = await repository.replacePool(inputs)
          expect(receipt.outcome).toBe('completed')
          expect(await readdir(pool.paths.transfersDir)).toEqual([])
          const read = await repository.read()
          expect(read.status).toBe('ready')
          expect(
            ready(read).rows.map((row) => row.credential?.refreshToken),
          ).toEqual(['tok-new-1', 'tok-new-2'])
        })
      }
    },
    2 * STORE_TEST_TIMEOUT_MS,
  )

  it(
    'resumes a replacement whose journal clear failed after its transfer file was deleted',
    async () => {
      await withPool(async (pool) => {
        // The genuine public store, with a test-injected fault: the first
        // write that would drop the management record throws inside the
        // store's settings mutator, so the store writes nothing. That is the
        // point between deleting the transfer file and clearing the record.
        let armed = true
        const faulted: AccountStoreModule = {
          ...pool.module,
          openPoolStore: (options) => {
            const store = pool.module.openPoolStore(options)
            return {
              ...store,
              updateSettings: (mutator, settingsOptions) =>
                store.updateSettings((settings) => {
                  const next = mutator(settings)
                  if (
                    armed &&
                    settings[MANAGEMENT_SETTINGS_KEY] !== undefined &&
                    next !== undefined &&
                    next[MANAGEMENT_SETTINGS_KEY] === undefined
                  ) {
                    armed = false
                    throw new Error('injected fault before the journal clear')
                  }
                  return next
                }, settingsOptions),
            }
          },
        }
        const old = pool.open()
        await old.login(login('old-1', 'tok-old-1'))
        const interrupted = createAccountRepositoryFactory({
          store: faulted,
          fs: pool.fs,
        })({
          paths: pool.paths,
          now: () => Date.now(),
          exchange: unusedExchange,
        })
        const inputs = [
          login('new-1', 'tok-new-1', { email: 'n1@example.test' }),
          login('new-2', 'tok-new-2', { email: 'n2@example.test' }),
        ]
        try {
          const first = await failureOf(interrupted.replacePool(inputs))
          expect(first.message).toContain('injected fault')
        } finally {
          await interrupted.dispose()
        }
        expect(armed).toBe(false)
        // The fault left the record pending with its transfer file deleted.
        expect(await readdir(pool.paths.transfersDir)).toEqual([])
        expect((await old.read()).status).toBe('management-pending')

        const receipt = await pool.open().replacePool(inputs)
        expect(receipt.outcome).toBe('completed')
        const read = await old.read()
        expect(read.status).toBe('ready')
        expect(
          ready(read).rows.map((row) => row.credential?.refreshToken),
        ).toEqual(['tok-new-1', 'tok-new-2'])
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// Replacement checks: each records what the genuine store actually leaves
// behind and asserts the exact outcome the repository must produce.
// ---------------------------------------------------------------------------

describe('replacement diagnostics on the genuine public store', () => {
  /** A repository failure's fields; any other error is rethrown, not recorded. */
  function repositoryFailure(error: unknown, store: AccountStoreModule) {
    if (!(error instanceof AccountRepositoryError)) throw error
    const cause = error.cause
    return {
      operation: error.failure.operation,
      rowId: error.failure.rowId,
      kind: error.failure.kind,
      retryable: error.failure.retryable,
      ambiguous: error.failure.ambiguous,
      message: error.failure.message,
      storeKind:
        cause instanceof store.PoolOperationError ? cause.kind : undefined,
      storeCauseMessage:
        cause instanceof store.PoolOperationError &&
        cause.cause instanceof Error
          ? cause.cause.message
          : undefined,
    }
  }

  /** A receipt or a repository failure; any other error is rethrown. */
  async function settle(
    operation: Promise<ManagementReceipt>,
    store: AccountStoreModule,
  ) {
    try {
      const receipt = await operation
      return { receipt: { outcome: receipt.outcome } } as const
    } catch (error) {
      return { failure: repositoryFailure(error, store) } as const
    }
  }

  /** Transfer file names; only a missing directory reads as none. */
  async function transferFiles(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return []
      }
      throw error
    }
  }

  /** The pool's rows as the store holds them, tokens named by `label`. */
  async function rawRows(pool: Pool, label: (token: string) => string) {
    const load = await openStoreDirectly(pool).read()
    if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
    return load.rows.map((row) => ({
      id: row.id,
      identity: row.identity,
      credentialEpoch: row.credentialEpoch,
      enabled: row.enabled,
      token:
        row.credential?.type === 'oauth'
          ? label(row.credential.refresh)
          : undefined,
      email:
        row.providerState === undefined
          ? undefined
          : decodeProviderState(row.providerState).metadata.email,
    }))
  }

  /** The journal as `read()` shows it, or undefined when none is pending. */
  async function journalOf(repository: AccountRepository) {
    const read = await repository.read()
    return read.status === 'management-pending'
      ? {
          kind: read.management.kind,
          step: read.management.progress.step,
          targets: [...read.management.targets],
          completedTargets: [...read.management.progress.completedTargets],
        }
      : undefined
  }

  const knownToken = (tokens: readonly string[]) => (token: string) =>
    tokens.includes(token) ? token : '<other>'

  it(
    'resumes an interrupted replacement with the same inputs whose nested metadata keys are ordered differently',
    async () => {
      await withPool(async (pool) => {
        // The genuine public store with a test-injected fault: the first
        // write that would drop the management record throws inside the
        // store's settings mutator, so the store writes nothing.
        const injected = 'injected fault before the journal clear'
        let armed = true
        const faulted: AccountStoreModule = {
          ...pool.module,
          openPoolStore: (options) => {
            const store = pool.module.openPoolStore(options)
            return {
              ...store,
              updateSettings: (mutator, settingsOptions) =>
                store.updateSettings((settings) => {
                  const next = mutator(settings)
                  if (
                    armed &&
                    settings[MANAGEMENT_SETTINGS_KEY] !== undefined &&
                    next !== undefined &&
                    next[MANAGEMENT_SETTINGS_KEY] === undefined
                  ) {
                    armed = false
                    throw new Error(injected)
                  }
                  return next
                }, settingsOptions),
            }
          },
        }
        const setup = pool.open()
        await setup.login(login('old-1', 'tok-old-1'))
        const history = [
          {
            fingerprint: fingerprint('h1'),
            timestamp: 20,
            reason: 'regenerated' as const,
          },
          {
            fingerprint: fingerprint('h0'),
            timestamp: 10,
            reason: 'initial' as const,
          },
        ]
        const started: AccountLoginInput = {
          id: 'new-1',
          refreshToken: 'tok-new-1',
          metadata: {
            addedAt: 1_000,
            lastUsed: 0,
            email: 'n1@example.test',
            rateLimitResetTimes: { claude: 9_000, 'gemini-cli': 8_000 },
            fingerprint: {
              deviceId: 'device-n1',
              sessionToken: 'session-n1',
              userAgent: 'antigravity-cli/test n1',
              apiClient: 'antigravity-cli',
              clientMetadata: {
                ideType: 'IDE_UNSPECIFIED',
                platform: 'darwin',
                pluginType: 'GEMINI',
              },
              createdAt: 1_700_000_000_000,
            },
            fingerprintHistory: history,
          },
        }
        // The same values, every map built in another key order; the array
        // keeps its order.
        const reordered: AccountLoginInput = {
          refreshToken: 'tok-new-1',
          metadata: {
            fingerprintHistory: history,
            fingerprint: {
              createdAt: 1_700_000_000_000,
              clientMetadata: {
                pluginType: 'GEMINI',
                platform: 'darwin',
                ideType: 'IDE_UNSPECIFIED',
              },
              apiClient: 'antigravity-cli',
              userAgent: 'antigravity-cli/test n1',
              sessionToken: 'session-n1',
              deviceId: 'device-n1',
            },
            rateLimitResetTimes: { 'gemini-cli': 8_000, claude: 9_000 },
            email: 'n1@example.test',
            lastUsed: 0,
            addedAt: 1_000,
          },
          id: 'new-1',
        }
        expect(reordered).toEqual(started)
        expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(started))

        const interrupted = createAccountRepositoryFactory({
          store: faulted,
          fs: pool.fs,
        })({
          paths: pool.paths,
          now: () => Date.now(),
          exchange: unusedExchange,
        })
        const first = await settle(
          interrupted.replacePool([started]),
          pool.module,
        ).finally(() => interrupted.dispose())
        // The first attempt failed at the injected journal clear, after the
        // verified phase was written and the transfer file deleted.
        expect(armed).toBe(false)
        expect(first).toMatchObject({
          failure: {
            kind: 'unexpected',
            storeKind: 'unexpected',
            storeCauseMessage: injected,
          },
        })
        expect(await journalOf(setup)).toMatchObject({
          kind: 'replace-pool',
          step: 'verified',
          completedTargets: ['new-1'],
        })
        expect(await transferFiles(pool.paths.transfersDir)).toEqual([])

        const resumed = await settle(
          pool.open().replacePool([reordered]),
          pool.module,
        )
        const after = {
          resumed,
          journal: await journalOf(setup),
          transfers: await transferFiles(pool.paths.transfersDir),
        }
        expect(after).toMatchObject({
          resumed: { receipt: { outcome: 'completed' } },
          journal: undefined,
          transfers: [],
        })
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'records what replacing a pool with a reused current id and a new token leaves behind',
    async () => {
      await withPool(async (pool) => {
        const tokens = knownToken(['tok-keep-old', 'tok-keep-new'])
        const setup = pool.open()
        await setup.login(login('keep', 'tok-keep-old', {}, 'acct-keep'))
        const before = await rawRows(pool, tokens)
        const outcome = await settle(
          pool
            .open()
            .replacePool([login('keep', 'tok-keep-new', {}, 'acct-keep')]),
          pool.module,
        )
        const journal = await journalOf(setup)
        const after = await rawRows(pool, tokens)
        const transfers = await transferFiles(pool.paths.transfersDir)
        const keep = after.find((row) => row.id === 'keep')
        const observed = { before, outcome, journal, after, transfers }
        // The broad safety property: an input the operation cannot complete
        // must not remove the old credential first and then leave the pool
        // pending.
        const stranded =
          journal !== undefined &&
          !after.some((row) => row.token === 'tok-keep-old')
        // A replacement adds new rows: an input naming a held row is refused
        // before anything is written, so the old row, no journal and no
        // transfer file remain.
        expect({
          outcome,
          keep,
          journal,
          transfers,
          stranded,
          observed,
        }).toMatchObject({
          outcome: {
            failure: {
              operation: 'replacePool',
              rowId: 'keep',
              kind: 'invalid-input',
              retryable: false,
              ambiguous: false,
              message:
                'input keep names a row the pool already holds; a replacement adds new rows',
              storeKind: undefined,
              storeCauseMessage: undefined,
            },
          },
          keep: { id: 'keep', identity: 'acct-keep', token: 'tok-keep-old' },
          journal: undefined,
          transfers: [],
          stranded: false,
        })
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  type AddInput = {
    id: string
    credential: { type: 'oauth'; refresh: string }
    identity?: string
    providerState?: unknown
  }

  /**
   * Replaces a pool of `old-1` with `new-1` and `new-2` through a store
   * whose first `add` passes `alter(input)` to the genuine public `add`,
   * so the backend really writes a row holding `tok-new-1` with one field
   * changed. Returns what the store and the repository then show.
   */
  async function replaceWithAlteredAdd(
    pool: Pool,
    alter: (input: AddInput) => AddInput,
  ) {
    const seen: { written?: AddInput } = {}
    const altering: AccountStoreModule = {
      ...pool.module,
      openPoolStore: (options) => {
        const store = pool.module.openPoolStore(options)
        return {
          ...store,
          add: (input) => {
            if (seen.written !== undefined) return store.add(input)
            const written = alter(input)
            seen.written = written
            return store.add(written)
          },
        }
      },
    }
    const tokens = knownToken(['tok-old-1', 'tok-new-1', 'tok-new-2'])
    const setup = pool.open()
    await setup.login(login('old-1', 'tok-old-1'))
    const inputs = [
      login('new-1', 'tok-new-1', { email: 'n1@example.test' }, 'acct-new-1'),
      login('new-2', 'tok-new-2', { email: 'n2@example.test' }, 'acct-new-2'),
    ]
    const outcome = await settle(
      pool
        .open(unusedExchange, {}, { store: altering, fs: pool.fs })
        .replacePool(inputs),
      pool.module,
    )
    const rows = await rawRows(pool, tokens)
    const written = seen.written
    return {
      written: written && {
        id: written.id,
        identity: written.identity,
        token: tokens(written.credential.refresh),
      },
      holder: rows.find((row) => row.token === 'tok-new-1'),
      rows,
      outcome,
      journal: await journalOf(setup),
      transfers: await transferFiles(pool.paths.transfersDir),
    }
  }

  /**
   * The refusal every corruption variant requires, with what was seen: the
   * replacement's own verification of its inputs (`verifyPool`) refusing
   * `new-1` with the variant's exact message, with no store failure beneath
   * it, and the journal and transfer file kept. A completed receipt, or a
   * refusal from anywhere else, does not pass.
   */
  function expectRefusedAndKept(
    observed: Awaited<ReturnType<typeof replaceWithAlteredAdd>>,
    message: string,
  ) {
    expect({
      outcome: observed.outcome,
      pending: observed.journal !== undefined,
      transferKept: observed.transfers.length === 1,
      observed,
    }).toMatchObject({
      outcome: {
        failure: {
          operation: 'replacePool',
          rowId: 'new-1',
          kind: 'unexpected',
          retryable: false,
          ambiguous: false,
          message,
          storeKind: undefined,
          storeCauseMessage: undefined,
        },
      },
      pending: true,
      transferKept: true,
    })
  }

  it(
    'refuses to complete a replacement whose stored row holds the requested token under another id',
    async () => {
      await withPool(async (pool) => {
        const observed = await replaceWithAlteredAdd(pool, (input) => ({
          ...input,
          id: 'wrong-id',
        }))
        // The backend wrote exactly this corruption.
        expect(observed.holder).toMatchObject({
          id: 'wrong-id',
          identity: 'acct-new-1',
          token: 'tok-new-1',
          email: 'n1@example.test',
        })
        expectRefusedAndKept(
          observed,
          'input new-1 is not in the pool after the replacement',
        )
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses to complete a replacement whose stored row holds the requested token under another identity',
    async () => {
      await withPool(async (pool) => {
        const observed = await replaceWithAlteredAdd(pool, (input) => ({
          ...input,
          identity: 'acct-wrong',
        }))
        expect(observed.holder).toMatchObject({
          id: 'new-1',
          identity: 'acct-wrong',
          token: 'tok-new-1',
          email: 'n1@example.test',
        })
        expectRefusedAndKept(
          observed,
          'input new-1 is recorded for another identity after the replacement',
        )
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses to complete a replacement whose stored row holds the requested token under other metadata',
    async () => {
      await withPool(async (pool) => {
        const observed = await replaceWithAlteredAdd(pool, (input) => {
          const envelope = decodeProviderState(input.providerState)
          return {
            ...input,
            providerState: encodeProviderState({
              ...envelope,
              metadata: { ...envelope.metadata, email: 'wrong@example.test' },
            }),
          }
        })
        expect(observed.holder).toMatchObject({
          id: 'new-1',
          identity: 'acct-new-1',
          token: 'tok-new-1',
          email: 'wrong@example.test',
        })
        expectRefusedAndKept(
          observed,
          'input new-1 does not hold its requested metadata after the replacement',
        )
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )
})

describe('account-store generation binding on the genuine public store', () => {
  /** A repository over `paths` with the admitted modules, outside `withPool`. */
  function repositoryAt(admitted: AdmittedStore, paths: AccountStorePaths) {
    return createAccountRepositoryFactory({
      store: admitted.module,
      fs: admitted.fs,
    })({ paths, now: () => Date.now(), exchange: unusedExchange })
  }

  async function withDir(body: (dir: string) => Promise<void>) {
    const dir = await realTempDir()
    try {
      await body(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it(
    'serves nothing for a legacy path with no published generation',
    async () => {
      const admitted = await admittedStore()
      await withDir(async (dir) => {
        const repository = repositoryAt(admitted, pathsIn(dir))
        try {
          expect(await repository.read()).toEqual({
            status: 'pending-migration',
          })
          const refused = await failureOf(
            repository.login(login('main', 'tok-1')),
          )
          expect(refused).toMatchObject({
            kind: 'pending-migration',
            message: 'the account store has not been initialized',
          })
        } finally {
          await repository.dispose()
        }
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'serves nothing while a migration or initialization is unfinished',
    async () => {
      const admitted = await admittedStore()
      await withDir(async (dir) => {
        const legacyPath = join(dir, 'antigravity-accounts.json')
        // The initializer stops right after publishing its pending
        // generation, through its own boundary hook.
        const stopped = await initializeFreshAccountStore(admitted.migration, {
          legacyPath,
          now: () => Date.now(),
          onBoundary: (boundary) => {
            if (boundary === 'pointer:after-publication') {
              throw new Error('stopped after publishing the pointer')
            }
          },
        }).then(
          () => 'completed',
          (error: unknown) => (error instanceof Error ? error.message : ''),
        )
        expect(stopped).not.toBe('completed')
        const binding = await readAccountStoreBinding(
          legacyPath,
          { store: admitted.module },
          () => Date.now(),
        )
        expect(binding.status).toBe('pending')
        const repository = repositoryAt(
          admitted,
          resolveAccountStorePaths(legacyPath),
        )
        try {
          expect(await repository.read()).toEqual({
            status: 'pending-migration',
          })
          expect(
            await failureOf(repository.login(login('main', 'tok-1'))),
          ).toMatchObject({
            kind: 'pending-migration',
            message:
              'the account store has a migration or rollback in progress',
          })
        } finally {
          await repository.dispose()
        }
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses a repository whose paths are not the published generation',
    async () => {
      await withPool(async (pool) => {
        const repository = repositoryAt(
          await admittedStore(),
          resolveAccountStorePaths(pool.paths.legacyPath, randomUUID()),
        )
        try {
          expect(
            await failureOf(repository.login(login('main', 'tok-1'))),
          ).toMatchObject({
            kind: 'load-error',
            message:
              "the published account-store generation is not this repository's",
          })
        } finally {
          await repository.dispose()
        }
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'stops serving once the store names another generation',
    async () => {
      await withPool(async (pool) => {
        const repository = pool.open()
        const { ref } = await repository.login(login('main', 'tok-1'))
        const other = resolveAccountStorePaths(
          pool.paths.legacyPath,
          randomUUID(),
        )
        await openStoreDirectly(pool).updateSettings((settings) => {
          const current = settings.antigravityGeneration
          if (typeof current !== 'object' || current === null) {
            throw new Error('no generation setting')
          }
          return {
            ...settings,
            antigravityGeneration: {
              ...current,
              id: basename(other.storeDir).slice(
                'antigravity-accounts.json.store.'.length,
                -'.generation'.length,
              ),
              storeDir: other.storeDir,
            },
          }
        }, {})
        expect(await repository.read()).toEqual({
          status: 'error',
          file: 'settings',
          reason: 'the store now belongs to another account-store generation',
        })
        expect(
          await failureOf(
            repository.recordUsage(ref, { family: 'claude', at: 1 }),
          ),
        ).toMatchObject({
          kind: 'load-error',
          message: 'the store now belongs to another account-store generation',
        })
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses to bind once the legacy file is recreated after activation',
    async () => {
      await withPool(async (pool) => {
        await writeFile(pool.paths.legacyPath, '{"version":4,"accounts":[]}')
        const read = await pool.open().read()
        expect(read).toEqual({
          status: 'error',
          file: 'config',
          reason: 'legacy source was recreated after activation',
        })
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'resumes an interrupted clear in a newly opened repository and serves nothing meanwhile',
    async () => {
      await withPool(async (pool) => {
        let armed = true
        const faulted: AccountStoreModule = {
          ...pool.module,
          openPoolStore: (options) => {
            const store = pool.module.openPoolStore(options)
            return {
              ...store,
              updateSettings: (mutator, settingsOptions) =>
                store.updateSettings((settings) => {
                  const next = mutator(settings)
                  if (
                    armed &&
                    settings[MANAGEMENT_SETTINGS_KEY] !== undefined &&
                    next !== undefined &&
                    next[MANAGEMENT_SETTINGS_KEY] === undefined
                  ) {
                    armed = false
                    throw new Error('injected fault before the journal clear')
                  }
                  return next
                }, settingsOptions),
            }
          },
        }
        const setup = pool.open()
        const kept = await setup.login(login('main', 'tok-1'))
        await setup.login(login('other', 'tok-2'))
        const interrupted = pool.open(
          unusedExchange,
          {},
          { store: faulted, fs: pool.fs },
        )
        const first = await failureOf(interrupted.clear())
        expect(first.message).toContain('injected fault')
        expect(armed).toBe(false)

        // A repository opened afterwards binds the same generation, refuses
        // ordinary work while the clear is pending, and finishes the clear.
        const reopened = pool.open()
        expect((await reopened.read()).status).toBe('management-pending')
        expect(
          (
            await failureOf(
              reopened.recordUsage(kept.ref, { family: 'claude', at: 1 }),
            )
          ).kind,
        ).toBe('management-pending')
        const receipt = await reopened.clear()
        expect(receipt.outcome).toBe('completed')
        expect(ready(await reopened.read()).rows).toEqual([])
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )

  it(
    'binds a generation holding a torn row, without routing that row',
    async () => {
      await withPool(async (pool) => {
        const setup = pool.open()
        const torn = await setup.login(
          login('torn', 'tok-torn', {}, 'acct-torn'),
        )
        const healthy = await setup.login(
          login('healthy', 'tok-healthy', {}, 'acct-healthy'),
        )
        // A replace through the genuine store stops between its state write
        // and its config write, through the store's public write-step hook.
        const options = {
          provider: ACCOUNT_STORE_PROVIDER,
          configPath: pool.paths.configPath,
          statePath: pool.paths.statePath,
          quota: QUOTA_CODEC,
          providerState: createProviderStateCodec(ACCOUNT_STATE_POLICY),
          requireCredentialStamps: true as const,
          now: () => Date.now(),
          onStep: (step: string, info: { operation: string }) => {
            if (
              info.operation === 'replace' &&
              step === 'before-config-write'
            ) {
              throw new Error('stopped between the replace writes')
            }
          },
        }
        const stopping = pool.module.openPoolStore(options)
        const stopped = await stopping
          .replace(
            torn.ref.id,
            { type: 'oauth', refresh: 'tok-torn-next' },
            { identity: 'acct-torn' },
            {
              attribution: {
                credentialEpoch: torn.ref.credentialEpoch,
                identity: 'acct-torn',
              },
            },
          )
          .then(
            () => 'completed',
            () => 'stopped',
          )
        expect(stopped).toBe('stopped')

        const reopened = pool.open()
        const read = ready(await reopened.read())
        expect(read.rows.find((row) => row.ref.id === 'torn')?.torn).toBe(true)
        const manager = AccountManager.fromRepository(read, {
          repository: reopened,
          now: () => Date.now(),
        })
        expect(manager.getAccounts().map((account) => account.ref)).toEqual([
          healthy.ref,
        ])
      })
    },
    STORE_TEST_TIMEOUT_MS,
  )
})
