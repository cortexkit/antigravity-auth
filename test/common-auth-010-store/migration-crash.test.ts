import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accountMigrationDurability,
  accountStorePointerPath,
  createAccountMigrationFactory,
  createAccountRollbackFactory,
  decodeAccountMigrationJournal,
  decodeAccountStorePointer,
  initializeFreshAccountStore,
  resolveAccountStorePaths as logicalPaths,
  readAccountStoreAdmission,
  readAccountStoreBinding,
} from '../../packages/core/src/account-migration.ts'
import {
  isValidProviderState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from '../../packages/core/src/account-repository-codecs.ts'
import {
  clearAccountStorage,
  loadAccountStorage,
  mutateAccountStorage,
  saveAccountStorage,
  saveAccountStorageReplace,
} from '../../packages/core/src/account-storage.ts'
import {
  assertDisposableChildRoot,
  type ChildLockClaim,
  type FixtureModules,
  loadOldMigrationWriter,
  loadPublicMigrationModules,
  MIGRATION_SOURCE,
  type MigrationFixture,
  type MigrationFixtureFactory,
  type MigrationFixtureInputs,
  migrationChildEnvironment,
  migrationFixtureInputs,
  preparePublicMigrationConsumer,
  resolvedConsumerPath,
  resolvePublicMigrationConsumer,
  withMigrationFixtures,
} from './migration-child.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CHILD = join(ROOT, 'test/common-auth-010-store/migration-child.ts')
function resolveAccountStorePaths(legacyPath: string) {
  const pointer = decodeAccountStorePointer(
    JSON.parse(readFileSync(accountStorePointerPath(legacyPath), 'utf8')),
    legacyPath,
  )
  return logicalPaths(legacyPath, pointer.id)
}
/** Each integration case owns its package consumer and store fixtures, including cleanup on failure. */
function integrationIt(
  name: string,
  body: (
    fixture: MigrationFixtureFactory,
    modules: FixtureModules,
    inputs: MigrationFixtureInputs,
  ) => Promise<void>,
): void {
  it(name, () =>
    withMigrationFixtures(async (fixture) => {
      const inputs = migrationFixtureInputs(process.env)
      const consumer = await fixture({
        version: 4,
        accounts: [],
        activeIndex: 0,
      })
      const modules = await loadPublicMigrationModules(consumer, inputs)
      await body(fixture, modules, inputs)
    }),
  )
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid owned child message')
  return value as Record<string, unknown>
}
const CHILD_OUTPUT_CAP_BYTES = 128 * 1024
const CHILD_START_BOUND_MS = 500
const CHILD_EXECUTION_BOUND_MS = 3000
const CHILD_TERM_GRACE_MS = 250
const CHILD_REAP_BOUND_MS = 500
const CHILD_PIPE_FINISH_MS = 250

interface CapturedChildOutput {
  bytes: Buffer
  observedBytes: number
  truncated: boolean
  complete: boolean
  readError?: string
}
async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function captureChildOutput(
  stream: import('node:stream').Readable | null,
  onOverflow: (error: Error) => void,
  name: string,
) {
  const chunks: Buffer[] = []
  let kept = 0
  let observedBytes = 0
  let truncated = false
  let complete = false
  let readError: string | undefined
  let finishRead: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  if (stream === null) {
    readError = `${name} pipe missing`
    finishRead()
  } else {
    stream.on('data', (value: Buffer | string) => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : value
      observedBytes += bytes.length
      const room = Math.max(0, CHILD_OUTPUT_CAP_BYTES - kept)
      if (room) {
        const part = Buffer.from(bytes.subarray(0, room))
        chunks.push(part)
        kept += part.length
      }
      if (bytes.length > room && !truncated) {
        truncated = true
        onOverflow(
          new Error(`${name} exceeded ${CHILD_OUTPUT_CAP_BYTES} bytes`),
        )
      }
      // Keep draining after overflow; only retained bytes are capped.
    })
    stream.once('end', () => {
      complete = true
      finishRead()
    })
    stream.once('error', (error: Error) => {
      readError = error.message
      finishRead()
    })
    stream.once('close', () => {
      if (!complete) readError ??= `${name} closed before end`
      finishRead()
    })
  }
  return {
    async finish(): Promise<CapturedChildOutput> {
      if (!(await settledWithin(finished, CHILD_PIPE_FINISH_MS))) {
        readError ??= `${name} remained open after ${CHILD_PIPE_FINISH_MS} ms`
        stream?.destroy()
      }
      return {
        bytes: Buffer.concat(chunks, kept),
        observedBytes,
        truncated,
        complete,
        ...(readError === undefined ? {} : { readError }),
      }
    },
  }
}

/** Uses only its direct child handle; execution, termination, reap and pipe waits are separate bounds. */
async function crashOwnedChild(
  fixture: MigrationFixture,
  boundary: string,
  operation: 'migrate' | 'rollback' | 'initialize',
  inputs: MigrationFixtureInputs,
): Promise<ChildLockClaim[]> {
  // Copy and verify inputs before spawning; the child's fixed execution budget
  // covers the operation, not dependency materialization. It rechecks all bytes.
  await preparePublicMigrationConsumer(fixture, inputs)
  const env = migrationChildEnvironment(fixture, inputs)
  const child = spawn(
    process.execPath,
    [CHILD, '--child', fixture.root, fixture.nonce, boundary, operation],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  const startedAt = performance.now()
  const trackedPid = child.pid
  fixture.cleanupBlocked = 'spawned child exit has not been observed'
  let owned = false
  let crashed = false
  let timedOut = false
  let exited = false
  let startObserved = false
  let primary: unknown
  const cleanup: unknown[] = []
  const signalsSent: string[] = []
  const claims: ChildLockClaim[] = []
  let markFailure: () => void = () => {}
  const failed = new Promise<void>((resolve) => {
    markFailure = resolve
  })
  const fail = (error: unknown) => {
    primary ??= error
    markFailure()
  }
  let markStart: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    markStart = resolve
  })
  let markExit: () => void = () => {}
  const exit = new Promise<void>((resolve) => {
    markExit = resolve
  })
  child.once('spawn', () => {
    startObserved = true
    markStart()
  })
  child.once('error', (error: Error) => {
    fail(error)
    markStart()
    markExit()
  })
  child.once('exit', () => {
    exited = true
    markExit()
  })
  const stdout = captureChildOutput(child.stdout, fail, 'stdout')
  const stderr = captureChildOutput(child.stderr, fail, 'stderr')
  child.on('message', (message: unknown) => {
    try {
      const reply = record(message)
      if (reply.nonce !== fixture.nonce || reply.pid !== trackedPid)
        throw new Error(
          'child IPC differs from captured spawn and fixture nonce',
        )
      if (reply.kind === 'owned') owned = true
      else if (reply.kind === 'crash') {
        if (
          !owned ||
          reply.boundary !== boundary ||
          !Array.isArray(reply.locks) ||
          reply.locks.length > 128
        )
          throw new Error('child did not reach the named boundary')
        crashed = true
        for (const item of reply.locks) {
          const claim = record(item)
          if (
            typeof claim.path !== 'string' ||
            typeof claim.ownerId !== 'string'
          )
            throw new Error('invalid child lease reference')
          claims.push({ path: claim.path, ownerId: claim.ownerId })
        }
      } else if (reply.kind !== 'completed')
        throw new Error('unexpected child IPC kind')
    } catch (error) {
      fail(error)
    }
  })
  const observeExit = async (ms: number) =>
    (await settledWithin(exit, ms)) &&
    exited &&
    (child.exitCode !== null || child.signalCode !== null)
  const signal = (name: 'SIGTERM' | 'SIGKILL') => {
    // Handle state and tracked PID are checked immediately before each call.
    // This is direct-child authority, not an atomic guarantee about PID reuse.
    if (exited || child.exitCode !== null || child.signalCode !== null) return
    if (trackedPid === undefined || child.pid !== trackedPid) {
      cleanup.push(new Error('captured child handle identity changed'))
      return
    }
    try {
      if (child.kill(name)) signalsSent.push(name)
      else
        cleanup.push(
          new Error(`${name} was not delivered through the child handle`),
        )
    } catch (error) {
      cleanup.push(error)
    }
  }
  try {
    if (!(await settledWithin(started, CHILD_START_BOUND_MS)) || !startObserved)
      fail(new Error('child start was not observed within its bound'))
    const remaining = Math.max(
      0,
      CHILD_EXECUTION_BOUND_MS - (performance.now() - startedAt),
    )
    if (!(await settledWithin(Promise.race([exit, failed]), remaining))) {
      timedOut = true
      fail(
        new Error('child exceeded its 3000 ms post-spawn execution deadline'),
      )
    }
    if (!exited) {
      signal('SIGTERM')
      if (!(await observeExit(CHILD_TERM_GRACE_MS))) signal('SIGKILL')
      if (!(await observeExit(CHILD_REAP_BOUND_MS)))
        cleanup.push(
          new Error('child exit was not observed within the reap bound'),
        )
    }
  } catch (error) {
    fail(error)
  }
  const reaped =
    exited && (child.exitCode !== null || child.signalCode !== null)
  if (reaped) delete fixture.cleanupBlocked
  const [out, err] = await Promise.all([stdout.finish(), stderr.finish()])
  if (
    out.truncated ||
    err.truncated ||
    !out.complete ||
    !err.complete ||
    out.readError ||
    err.readError
  )
    fail(
      new Error(
        'child output was not complete within the byte and finish bounds',
      ),
    )
  const preClaim = operation === 'initialize' && boundary === 'before-capture'
  if (
    !reaped ||
    !owned ||
    !crashed ||
    child.exitCode !== 73 ||
    timedOut ||
    (!claims.length && !preClaim)
  )
    fail(
      new Error(
        `child did not report/exit at ${boundary}: code=${child.exitCode}, owned=${owned}, crashed=${crashed}; stderr=${JSON.stringify(err.bytes.toString('utf8'))}`,
      ),
    )
  const result = {
    pid: trackedPid,
    code: child.exitCode,
    signal: child.signalCode,
    timedOut,
    reaped,
    signalsSent,
    stdout: out,
    stderr: err,
  }
  if (primary !== undefined || cleanup.length)
    throw new AggregateError(
      [...(primary === undefined ? [] : [primary]), ...cleanup],
      `owned child failed: code=${child.exitCode}, owned=${owned}, crashed=${crashed}, timeout=${timedOut}; bounded stderr=${JSON.stringify(err.bytes.toString('utf8'))}; bounded raw stdout/stderr retained in cause`,
      { cause: result },
    )
  // Lease cleanup is allowed only after a confirmed exit. References are scoped
  // to this single-child fixture and must still name the same regular files.
  for (const claim of claims) {
    if (
      !claim.path.startsWith(`${fixture.root}${sep}`) ||
      !claim.path.endsWith('.lock') ||
      claim.path !== resolve(claim.path)
    )
      throw new Error('claimed lease escapes disposable root')
    const stat = await lstat(claim.path)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('claimed lease is nonregular')
    const fd = await open(claim.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const current = record(JSON.parse((await fd.readFile()).toString('utf8')))
      const after = await lstat(claim.path)
      if (
        current.ownerId !== claim.ownerId ||
        stat.dev !== after.dev ||
        stat.ino !== after.ino
      )
        throw new Error('reported lease reference changed after child exit')
      await unlink(claim.path)
    } finally {
      await fd.close()
    }
  }
  return claims
}

const PHASES = ['capture', 'build', 'verify', 'retire', 'activate'] as const
const MIGRATION_CASES = [
  ...PHASES.flatMap((phase) => [`before-${phase}`, `after-${phase}`]),
  ...['add'].flatMap((operation) =>
    [
      'before-state-write',
      'after-state-write',
      'before-config-write',
      'after-config-write',
    ].map((step) => `public:${operation}:${step}`),
  ),
  ...[
    'disable',
    'enable',
    'pull',
    'reorder',
    'updateSettings',
    'initialize',
  ].flatMap((operation) =>
    ['before-config-write', 'after-config-write'].map(
      (step) => `public:${operation}:${step}`,
    ),
  ),
  ...[
    'before-config-write',
    'after-config-write',
    'before-state-write',
    'after-state-write',
  ].map((step) => `public:remove:${step}`),
]
const ROLLBACK_CASES = PHASES.flatMap((phase) => [
  `rollback:before-${phase}`,
  `rollback:after-${phase}`,
])
const FRESH_CASES = [
  ...PHASES.flatMap((phase) => [`before-${phase}`, `after-${phase}`]),
  'pointer:after-link-before-parent-sync',
  'pointer:after-sync-before-stage-cleanup',
  ...['initialize', 'updateSettings'].flatMap((operation) =>
    ['before-config-write', 'after-config-write'].map(
      (step) => `public:${operation}:${step}`,
    ),
  ),
]

describe('owned real-process migration crash seams', () => {
  function options(fixture: MigrationFixture) {
    return {
      legacyPath: fixture.legacyPath,
      offline: { processesStopped: true as const },
      now: Date.now,
    }
  }

  for (const boundary of MIGRATION_CASES)
    integrationIt(
      `restarts losslessly after genuine ${boundary}`,
      async (create, modules, inputs) => {
        const empty = boundary.startsWith('public:initialize:')
        const fixture = await create(
          empty
            ? { version: 4, accounts: [], activeIndex: 0 }
            : MIGRATION_SOURCE,
        )
        if (boundary.startsWith('public:remove:')) {
          await createAccountMigrationFactory(modules)(options(fixture))
          await createAccountRollbackFactory(modules)(options(fixture))
        }
        const original = await readFile(fixture.legacyPath)
        const claims = await crashOwnedChild(
          fixture,
          boundary,
          'migrate',
          inputs,
        )
        expect(claims.length).toBeGreaterThan(0)
        expect(
          (await createAccountMigrationFactory(modules)(options(fixture)))
            .status,
        ).toBe('completed')
        expect(
          (
            await readAccountStoreAdmission(
              fixture.legacyPath,
              modules,
              Date.now,
            )
          ).status,
        ).toBe('active')
        const paths = resolveAccountStorePaths(fixture.legacyPath)
        const journal = decodeAccountMigrationJournal(
          JSON.parse(await readFile(paths.migrationPath, 'utf8')),
        )
        expect(
          await readFile(
            join(paths.backupsDir, `${journal.sourceSha256}.json`),
          ),
        ).toEqual(original)
        expect(
          await readFile(join(paths.retiredDir, `${journal.id}.json`)),
        ).toEqual(original)
        expect(
          journal.manifest.accounts.map((row) => row.refreshToken),
        ).toEqual(
          empty ? [] : ['synthetic-first-refresh', 'synthetic-second-refresh'],
        )
        expect(journal.completedRows).toEqual(
          journal.mapping.map((row) => row.id),
        )
        await assertCurrentStoreRows(
          fixtureStore(modules, fixture.legacyPath),
          empty
            ? { version: 4, accounts: [], activeIndex: 0 }
            : MIGRATION_SOURCE,
        )
        const finalBytes = await Promise.all(
          [paths.configPath, paths.migrationPath].map((path) => readFile(path)),
        )
        expect(
          (await createAccountMigrationFactory(modules)(options(fixture)))
            .status,
        ).toBe('completed')
        expect(
          await Promise.all(
            [paths.configPath, paths.migrationPath].map((path) =>
              readFile(path),
            ),
          ),
        ).toEqual(finalBytes)
      },
    )

  for (const boundary of ROLLBACK_CASES)
    integrationIt(
      `restores current credentials once after genuine ${boundary}`,
      async (create, modules, inputs) => {
        const fixture = await create(MIGRATION_SOURCE)
        await createAccountMigrationFactory(modules)(options(fixture))
        const originalJournal = decodeAccountMigrationJournal(
          await json(
            resolveAccountStorePaths(fixture.legacyPath).migrationPath,
          ),
        )
        await fixtureStore(modules, fixture.legacyPath).rotate(
          originalJournal.mapping[0]!.id,
          {
            type: 'oauth',
            refresh: 'synthetic-crash-current-refresh',
            access: 'synthetic-crash-current-access',
            expires: Date.now() + 10000,
          },
        )
        await crashOwnedChild(fixture, boundary, 'rollback', inputs)
        expect(
          (await createAccountRollbackFactory(modules)(options(fixture)))
            .status,
        ).toBe('completed')
        expect(
          (
            await readAccountStoreAdmission(
              fixture.legacyPath,
              modules,
              Date.now,
            )
          ).status,
        ).toBe('inactive')
        const restored = await readFile(fixture.legacyPath)
        const expected = structuredClone(MIGRATION_SOURCE)
        expected.accounts[0]!.refreshToken = 'synthetic-crash-current-refresh'
        expect(JSON.parse(restored.toString('utf8'))).toEqual(expected)
        await assertCurrentStoreRows(
          fixtureStore(modules, fixture.legacyPath),
          expected,
        )
        expect(
          (await createAccountRollbackFactory(modules)(options(fixture)))
            .status,
        ).toBe('completed')
        expect(await readFile(fixture.legacyPath)).toEqual(restored)
      },
    )

  for (const boundary of FRESH_CASES)
    integrationIt(
      `resumes owned absent-source initialization after genuine ${boundary}`,
      async (create, modules, inputs) => {
        const fixture = await create(MIGRATION_SOURCE)
        await unlink(fixture.legacyPath)
        await crashOwnedChild(fixture, boundary, 'initialize', inputs)
        const request = { legacyPath: fixture.legacyPath, now: Date.now }
        expect(
          (await initializeFreshAccountStore(modules, request)).status,
        ).toBe('completed')
        expect(
          (
            await readAccountStoreAdmission(
              fixture.legacyPath,
              modules,
              Date.now,
            )
          ).status,
        ).toBe('active')
        const paths = resolveAccountStorePaths(fixture.legacyPath)
        const journal = decodeAccountMigrationJournal(
          JSON.parse(await readFile(paths.migrationPath, 'utf8')),
        )
        expect(journal.sourceKind).toBe('absent')
        expect(journal.sourceAbsenceVerified).toBe(true)
        expect(journal.sourceSha256).toBeUndefined()
        expect(journal.retiredSha256).toBeUndefined()
        expect(journal.manifest.accounts).toEqual([])
        const emptyRead = await fixtureStore(modules, fixture.legacyPath).read()
        expect(emptyRead.status).toBe('ready')
        if (emptyRead.status !== 'ready')
          throw new Error('fresh current store unavailable')
        expect(emptyRead.rows).toEqual([])
        await expect(readFile(fixture.legacyPath)).rejects.toMatchObject({
          code: 'ENOENT',
        })
        const before = await Promise.all(
          [paths.configPath, paths.migrationPath].map((path) => readFile(path)),
        )
        expect(
          (await initializeFreshAccountStore(modules, request)).status,
        ).toBe('completed')
        expect(
          await Promise.all(
            [paths.configPath, paths.migrationPath].map((path) =>
              readFile(path),
            ),
          ),
        ).toEqual(before)
      },
    )
})

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}
function fixtureStore(
  modules: FixtureModules,
  legacyPath: string,
  onStep?: Parameters<FixtureModules['store']['openPoolStore']>[0]['onStep'],
) {
  const paths = resolveAccountStorePaths(legacyPath)
  return modules.store.openPoolStore({
    provider: 'antigravity',
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: QUOTA_CODEC,
    providerState: {
      validate: isValidProviderState,
      credentialBound: providerStateCredentialBound,
      merge: (_previous, incoming) => incoming,
      onReplace: (_previous, replacement) => replacement.incoming,
    },
    requireCredentialStamps: true,
    now: Date.now,
    ...(onStep === undefined ? {} : { onStep }),
  })
}
function options(fixture: MigrationFixture) {
  return {
    legacyPath: fixture.legacyPath,
    offline: { processesStopped: true as const },
    now: Date.now,
  }
}
async function assertCurrentStoreRows(
  store: ReturnType<typeof fixtureStore>,
  expectedSource: unknown,
): Promise<void> {
  const source = record(expectedSource)
  if (!Array.isArray(source.accounts))
    throw new Error('expected fixture accounts absent')
  const read = await store.read()
  expect(read.status).toBe('ready')
  if (read.status !== 'ready')
    throw new Error('actual public store is not ready')
  expect(read.rows.length).toBe(source.accounts.length)
  expect(new Set(read.rows.map((row) => row.id)).size).toBe(read.rows.length)
  for (const [index, row] of read.rows.entries()) {
    const expected = record(source.accounts[index])
    if (typeof expected.refreshToken !== 'string')
      throw new Error('expected fixture token missing')
    expect(row.credential?.type === 'oauth' && row.credential.refresh).toBe(
      expected.refreshToken,
    )
    expect(row.enabled).toBe(expected.enabled !== false)
    expect(row.hasEntry).toBe(true)
    expect(row.stamp).toBe('bound')
    expect(row.torn).toBeUndefined()
    expect(row.invalid).toBeUndefined()
    expect(row.unbound).toBeUndefined()
    expect(row.identity).toBeUndefined()
    const metadata = { ...expected }
    const quota: Record<string, unknown> = { schemaVersion: 1 }
    let quotaPresent = false
    delete metadata.refreshToken
    for (const key of [
      'cachedQuotaAccountId',
      'cachedQuota',
      'cachedPerModelQuota',
      'cachedQuotaUpdatedAt',
    ]) {
      if (Object.hasOwn(expected, key)) {
        quota[key] = expected[key]
        quotaPresent = true
      }
      delete metadata[key]
    }
    expect(row.providerState).toEqual({ schemaVersion: 1, metadata })
    expect(row.quota).toEqual(quotaPresent ? quota : undefined)
  }
}

// Backend checks are physically outside packages/core/src. The normal core
// unit gate cannot import this file, load a public package or start a child.
describe('genuine public-store offline migration', () => {
  integrationIt(
    'imports full rows, credential stamps, field presence, order and independent cursors then verifies active no-op',
    async (fixture, modules) => {
      const f = await fixture()
      const sourceBytes = await readFile(f.legacyPath)
      const result = await createAccountMigrationFactory(modules)(options(f))
      expect(result.status).toBe('completed')
      const paths = resolveAccountStorePaths(f.legacyPath)
      const journal = decodeAccountMigrationJournal(
        await json(paths.migrationPath),
      )
      expect(journal.phase).toBe('activate')
      expect(journal.status).toBe('active')
      expect(journal.sourceSha256).toBe(hash(sourceBytes))
      expect(journal.completedRows).toEqual(
        journal.mapping.map((row) => row.id),
      )
      expect(
        await readFile(join(paths.backupsDir, `${journal.sourceSha256}.json`)),
      ).toEqual(sourceBytes)
      expect(
        await readFile(join(paths.retiredDir, `${journal.id}.json`)),
      ).toEqual(sourceBytes)
      const store = fixtureStore(modules, f.legacyPath)
      const read = await store.read()
      expect(read.status).toBe('ready')
      if (read.status !== 'ready') throw new Error('successor is not ready')
      expect(read.rows.map((row) => row.id)).toEqual(
        journal.mapping.map((row) => row.id),
      )
      expect(
        read.rows.map((row) =>
          row.credential?.type === 'oauth' ? row.credential.refresh : undefined,
        ),
      ).toEqual(['synthetic-first-refresh', 'synthetic-second-refresh'])
      for (const [index, row] of read.rows.entries()) {
        expect(row.stamp).toBe('bound')
        expect(row.torn).toBeUndefined()
        expect(row.unbound).toBeUndefined()
        expect(row.providerStateDropped).toBeUndefined()
        const input = MIGRATION_SOURCE.accounts[index]
        if (!input) throw new Error('expected fixture row absent')
        const expected: Record<string, unknown> = { ...input }
        for (const key of [
          'refreshToken',
          'cachedQuota',
          'cachedPerModelQuota',
          'cachedQuotaAccountId',
          'cachedQuotaUpdatedAt',
        ])
          delete expected[key]
        // Construct the expected stored fields directly from the source fixture,
        // without using the migration's encoder or captured manifest.
        expect(row.providerState).toEqual({
          schemaVersion: 1,
          metadata: expected,
        })
      }
      expect(read.rows.map((row) => row.enabled)).toEqual([true, false])
      expect(read.rows[0]!.quota).toEqual({
        schemaVersion: 1,
        cachedQuota: MIGRATION_SOURCE.accounts[0]!.cachedQuota,
        cachedPerModelQuota: MIGRATION_SOURCE.accounts[0]!.cachedPerModelQuota,
        cachedQuotaAccountId: null,
        cachedQuotaUpdatedAt: 10,
      })
      expect(read.rows[1]!.quota).toEqual({
        schemaVersion: 1,
        cachedQuota: null,
        cachedPerModelQuota: [],
      })
      const settings = await store.readSettings()
      expect(settings.status).toBe('ready')
      if (settings.status !== 'ready') throw new Error('settings absent')
      expect(settings.settings.antigravityManagement).toBeUndefined()
      expect(settings.settings.antigravityRouting).toMatchObject({
        activeIndex: 7,
        activeIndexByFamily: MIGRATION_SOURCE.activeIndexByFamily,
        activeRow: { id: read.rows[1]!.id, credentialEpoch: 1 },
        activeRowByFamily: {
          claude: { id: read.rows[0]!.id, credentialEpoch: 1 },
          gemini: { id: read.rows[1]!.id, credentialEpoch: 1 },
        },
        legacySourceFields: { future: MIGRATION_SOURCE.future },
      })
      const before = await Promise.all(
        [paths.configPath, paths.statePath, paths.migrationPath].map((path) =>
          readFile(path),
        ),
      )
      expect(
        (await createAccountMigrationFactory(modules)(options(f))).status,
      ).toBe('completed')
      expect(
        await Promise.all(
          [paths.configPath, paths.statePath, paths.migrationPath].map((path) =>
            readFile(path),
          ),
        ),
      ).toEqual(before)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
    },
  )

  integrationIt(
    'malformed source refuses with unchanged L and no journal owner',
    async (fixture, modules) => {
      const f = await fixture()
      await writeFile(f.legacyPath, '{broken', { mode: 0o600 })
      const before = await readFile(f.legacyPath)
      await expect(
        createAccountMigrationFactory(modules)(options(f)),
      ).rejects.toThrow('malformed source JSON')
      expect(await readFile(f.legacyPath)).toEqual(before)
      await expect(
        readFile(accountStorePointerPath(f.legacyPath)),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  integrationIt(
    'independently verifies exclusive backup bytes before any successor ownership',
    async (fixture, modules) => {
      const f = await fixture()
      const before = await readFile(f.legacyPath)
      let stage: ReturnType<typeof logicalPaths> | undefined
      await expect(
        createAccountMigrationFactory(modules)({
          ...options(f),
          onBoundary: async (point) => {
            if (point !== 'capture:before-backup') return
            const names = (await readdir(f.root)).filter((name) =>
              /^accounts\.json\.store\.[0-9a-f-]{36}\.generation$/.test(name),
            )
            if (names.length !== 1 || !names[0])
              throw new Error('exclusive stage not reached')
            const id = names[0].slice(
              'accounts.json.store.'.length,
              -'.generation'.length,
            )
            stage = logicalPaths(f.legacyPath, id)
            await writeFile(
              join(stage.backupsDir, `${hash(before)}.json`),
              'wrong independent bytes',
              { mode: 0o600, flag: 'wx' },
            )
          },
        }),
      ).rejects.toThrow('exclusive backup or recovery copy differs')
      expect(await readFile(f.legacyPath)).toEqual(before)
      if (!stage) throw new Error('backup stage reference absent')
      await expect(readFile(stage.migrationPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(stage.configPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

  integrationIt(
    'verifies full successor metadata before retiring L even when every token and source hash still matches',
    async (fixture, modules) => {
      const f = await fixture()
      const before = await readFile(f.legacyPath)
      await expect(
        createAccountMigrationFactory(modules)({
          ...options(f),
          onBoundary: async (point) => {
            if (point !== 'after-build') return
            const paths = resolveAccountStorePaths(f.legacyPath)
            const state: {
              accounts: Record<
                string,
                { commonAuthProviderState: { metadata: { lastUsed: number } } }
              >
            } = JSON.parse(await readFile(paths.statePath, 'utf8'))
            const entry = Object.values(state.accounts)[0]
            if (!entry) throw new Error('real successor state did not execute')
            // The public stamp binds token, credential epoch and identity, but not
            // lastUsed; token/stamp validity must not replace full metadata comparison.
            entry.commonAuthProviderState.metadata.lastUsed = 777
            await writeFile(paths.statePath, `${JSON.stringify(state)}\n`, {
              mode: 0o600,
            })
          },
        }),
      ).rejects.toThrow('successor full metadata, quota or presence differs')
      expect(await readFile(f.legacyPath)).toEqual(before)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('pending')
    },
  )

  integrationIt(
    'refuses POSIX directory sync failure and reports Windows mode-bit limits honestly',
    async (fixture, modules) => {
      const f = await fixture()
      const before = await readFile(f.legacyPath)
      const invoke = createAccountMigrationFactory(modules)({
        ...options(f),
        onBoundary: (point) => {
          if (point === 'before-directory-sync')
            throw new Error('forced directory sync failure')
        },
      })
      if (process.platform === 'win32') {
        expect((await invoke).status).toBe('completed')
        expect(accountMigrationDurability()).toBe(
          'windows-reopened-no-directory-power-loss-guarantee',
        )
      } else {
        await expect(invoke).rejects.toThrow('forced directory sync failure')
        expect(await readFile(f.legacyPath)).toEqual(before)
      }
      expect(accountMigrationDurability('win32')).toBe(
        'windows-reopened-no-directory-power-loss-guarantee',
      )
      expect(accountMigrationDurability('linux')).toBe('posix-directory-synced')
    },
  )

  integrationIt(
    'two offline migrators converge on one verified generation without a convergence loop',
    async (fixture, modules) => {
      const f = await fixture()
      const migrate = createAccountMigrationFactory(modules)
      const results = await Promise.all([
        migrate(options(f)),
        migrate(options(f)),
      ])
      expect(results.map((result) => result.status)).toEqual([
        'completed',
        'completed',
      ])
      const ids = results.map((result) =>
        result.status === 'completed' ? result.receipt.id : undefined,
      )
      expect(new Set(ids).size).toBe(1)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
    },
  )

  integrationIt(
    'new legacy writers fail closed and genuine old save/replace/clear cannot touch D; recreated L refuses',
    async (fixture, modules, inputs) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      const paths = resolveAccountStorePaths(f.legacyPath)
      const before = await Promise.all(
        [paths.configPath, paths.statePath, paths.migrationPath].map((path) =>
          readFile(path),
        ),
      )
      const legacy = {
        version: 4 as const,
        accounts: [
          { refreshToken: 'synthetic-old-writer', addedAt: 1, lastUsed: 2 },
        ],
        activeIndex: 0,
      }
      for (const write of [
        () => saveAccountStorage(f.legacyPath, legacy),
        () => saveAccountStorageReplace(f.legacyPath, legacy),
        () => mutateAccountStorage(f.legacyPath, () => legacy),
        () => clearAccountStorage(f.legacyPath),
        () => loadAccountStorage(f.legacyPath),
      ])
        await expect(write()).rejects.toThrow(
          'legacy storage is owned by the account store',
        )
      const old = await loadOldMigrationWriter(inputs)
      await old.saveAccountStorage(f.legacyPath, legacy)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
      await expect(
        createAccountMigrationFactory(modules)(options(f)),
      ).rejects.toThrow('legacy source was recreated')
      await old.saveAccountStorageReplace(f.legacyPath, {
        ...legacy,
        accounts: [
          { refreshToken: 'synthetic-old-replace', addedAt: 1, lastUsed: 2 },
        ],
      })
      await old.clearAccountStorage(f.legacyPath)
      expect(
        await Promise.all(
          [paths.configPath, paths.statePath, paths.migrationPath].map((path) =>
            readFile(path),
          ),
        ),
      ).toEqual(before)
    },
  )

  integrationIt(
    'rolls back current refreshed credentials/full metadata and remigrates with new UUIDs while retaining retired epochs',
    async (fixture, modules) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      const paths = resolveAccountStorePaths(f.legacyPath)
      const original = decodeAccountMigrationJournal(
        await json(paths.migrationPath),
      )
      const store = fixtureStore(modules, f.legacyPath)
      const first = original.mapping[0]!.id
      await store.rotate(first, {
        type: 'oauth',
        refresh: 'synthetic-current-refreshed',
        access: 'synthetic-current-access',
        expires: Date.now() + 10000,
      })
      const rollback = await createAccountRollbackFactory(modules)(options(f))
      expect(rollback.status).toBe('completed')
      const restored: { accounts: Record<string, unknown>[] } = JSON.parse(
        await readFile(f.legacyPath, 'utf8'),
      )
      expect(restored.accounts[0]!.refreshToken).toBe(
        'synthetic-current-refreshed',
      )
      expect(restored.accounts[0]!.projectId).toBe('first-project')
      expect(restored.accounts[0]!.dailyRequestCounts).toEqual({
        date: '2000-01-01',
        claude: 7,
        gemini: 8,
      })
      expect(restored.accounts[0]!.cachedPerModelQuota).toEqual(
        MIGRATION_SOURCE.accounts[0]!.cachedPerModelQuota,
      )
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('inactive')
      expect(
        (await createAccountMigrationFactory(modules)(options(f))).status,
      ).toBe('completed')
      const remigratedPaths = resolveAccountStorePaths(f.legacyPath)
      const remigrated = decodeAccountMigrationJournal(
        await json(remigratedPaths.migrationPath),
      )
      expect(
        remigrated.mapping.every(
          (row) => !original.mapping.some((old) => old.id === row.id),
        ),
      ).toBe(true)
      const config: {
        commonAuthPool: { retiredEpochs: Record<string, number> }
      } = JSON.parse(await readFile(paths.configPath, 'utf8'))
      for (const old of original.mapping)
        expect(
          config.commonAuthPool.retiredEpochs[old.id],
        ).toBeGreaterThanOrEqual(1)
      const read = await fixtureStore(modules, f.legacyPath).read()
      if (read.status !== 'ready')
        throw new Error('remigrated successor unavailable')
      expect(
        read.rows[0]!.credential?.type === 'oauth' &&
          read.rows[0]!.credential.refresh,
      ).toBe('synthetic-current-refreshed')
    },
  )

  integrationIt(
    'rollback never overwrites a recreated L and pre-retirement cancellation keeps original bytes',
    async (fixture, modules) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      await writeFile(f.legacyPath, 'unrelated bytes', {
        mode: 0o600,
        flag: 'wx',
      })
      await expect(
        createAccountRollbackFactory(modules)(options(f)),
      ).rejects.toThrow(
        'rollback refuses an existing or recreated legacy source',
      )
      expect(await readFile(f.legacyPath, 'utf8')).toBe('unrelated bytes')
      const pending = await fixture()
      const before = await readFile(pending.legacyPath)
      await expect(
        createAccountMigrationFactory(modules)({
          ...options(pending),
          onBoundary: (point) => {
            if (point === 'after-build')
              throw new Error('stop unserved generation')
          },
        }),
      ).rejects.toThrow('stop unserved generation')
      expect(
        (await createAccountRollbackFactory(modules)(options(pending))).status,
      ).toBe('completed')
      expect(await readFile(pending.legacyPath)).toEqual(before)
      expect(
        (await readAccountStoreAdmission(pending.legacyPath, modules, Date.now))
          .status,
      ).toBe('inactive')
    },
  )

  integrationIt(
    'empty file input explicitly bootstraps a real store; absent journal, malformed and wrong-association receipts never imply active',
    async (fixture, modules) => {
      const f = await fixture({
        version: 4,
        accounts: [],
        activeIndex: null,
        future: [],
      })
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('pending')
      expect(
        (await createAccountMigrationFactory(modules)(options(f))).status,
      ).toBe('completed')
      const paths = resolveAccountStorePaths(f.legacyPath)
      const journal = await json(paths.migrationPath)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
      expect(() =>
        decodeAccountMigrationJournal({
          ...(journal as Record<string, unknown>),
          storeDir: join(f.root, 'unrelated'),
        }),
      ).toThrow('journal successor association differs')
      for (const mutation of [
        { status: 'unknown' },
        { phase: 'served' },
        { schemaVersion: 2 },
        { verification: null },
        { retiredSha256: '0'.repeat(64) },
      ]) {
        expect(() =>
          decodeAccountMigrationJournal({
            ...(journal as Record<string, unknown>),
            ...mutation,
          }),
        ).toThrow()
      }
      await writeFile(paths.migrationPath, '{}', { mode: 0o600 })
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
      await unlink(paths.migrationPath)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
      if (process.platform !== 'win32') {
        const insecure = await fixture()
        await chmod(insecure.legacyPath, 0o644)
        await expect(
          createAccountMigrationFactory(modules)(options(insecure)),
        ).rejects.toThrow('insecure POSIX')
      }
    },
  )

  integrationIt(
    'child ownership and profile guard rejects forbidden inputs while the owned disposable control passes',
    async (fixture, _modules, inputs) => {
      const f = await fixture()
      const env = migrationChildEnvironment(f, inputs)
      await assertDisposableChildRoot(f.root, f.nonce, process.pid, env)
      await expect(
        assertDisposableChildRoot(
          join(f.root, 'home'),
          f.nonce,
          process.pid,
          env,
        ),
      ).rejects.toThrow('non-disposable root')
      await expect(
        assertDisposableChildRoot(f.root, f.nonce, process.pid + 1, env),
      ).rejects.toThrow('fixture ownership differs')
      await expect(
        assertDisposableChildRoot(f.root, f.nonce, process.pid, {
          ...env,
          HOME: 'forbidden-not-opened',
        }),
      ).rejects.toThrow('unisolated HOME')
      await expect(
        assertDisposableChildRoot(f.root, f.nonce, process.pid, {
          ...env,
          NODE_OPTIONS: '--require forbidden-not-opened',
        }),
      ).rejects.toThrow('unexpected environment key NODE_OPTIONS')
      await assertDisposableChildRoot(f.root, f.nonce, process.pid, env)
    },
  )

  integrationIt(
    'explicitly initializes an absent source before first login with no phantom backups, hashes or retired bytes',
    async (fixture, modules) => {
      const f = await fixture()
      await unlink(f.legacyPath)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('initialization-required')
      const result = await initializeFreshAccountStore(modules, {
        legacyPath: f.legacyPath,
        now: Date.now,
      })
      expect(result.status).toBe('completed')
      if (result.status !== 'completed')
        throw new Error('fresh initialization incomplete')
      expect(result.receipt.sourceKind).toBe('absent')
      expect(result.receipt.restartRequired).toBe(false)
      const paths = resolveAccountStorePaths(f.legacyPath)
      const journal = decodeAccountMigrationJournal(
        await json(paths.migrationPath),
      )
      expect(journal.sourceKind).toBe('absent')
      expect(journal.sourceAbsenceVerified).toBe(true)
      expect(journal.sourceSha256).toBeUndefined()
      expect(journal.retiredSha256).toBeUndefined()
      expect(journal.manifest.sourceVersion).toBeNull()
      expect(journal.mapping).toEqual([])
      expect(await readdir(paths.backupsDir)).toEqual([])
      expect(await readdir(paths.retiredDir)).toEqual([])
      await expect(readFile(paths.statePath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const read = await fixtureStore(modules, f.legacyPath).read()
      expect(read.status).toBe('ready')
      if (read.status !== 'ready')
        throw new Error('fresh empty store unavailable')
      expect(read.rows).toEqual([])
      const before = await Promise.all(
        [paths.configPath, paths.migrationPath].map((path) => readFile(path)),
      )
      expect(
        (
          await initializeFreshAccountStore(modules, {
            legacyPath: f.legacyPath,
            now: Date.now,
          })
        ).status,
      ).toBe('completed')
      expect(
        await Promise.all(
          [paths.configPath, paths.migrationPath].map((path) => readFile(path)),
        ),
      ).toEqual(before)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
      expect(() =>
        decodeAccountMigrationJournal({
          ...JSON.parse(before[1]!.toString('utf8')),
          sourceSha256: '0'.repeat(64),
        }),
      ).toThrow('absent source cannot claim a backup hash')
    },
  )

  integrationIt(
    'concurrent fresh claims never overwrite or adopt a foreign generation',
    async (fixture, modules) => {
      const f = await fixture()
      await unlink(f.legacyPath)
      const request = { legacyPath: f.legacyPath, now: Date.now }
      const results = await Promise.allSettled([
        initializeFreshAccountStore(modules, request),
        initializeFreshAccountStore(modules, request),
      ])
      const completed = results.flatMap((result) =>
        result.status === 'fulfilled' && result.value.status === 'completed'
          ? [result.value.receipt.id]
          : [],
      )
      expect(completed.length).toBeGreaterThan(0)
      expect(new Set(completed).size).toBe(1)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
    },
  )

  integrationIt(
    'fresh first claim rejects existing, dangling, malformed, alias and zero-roster foreign artifacts',
    async (fixture, modules) => {
      const f = await fixture()
      const request = { legacyPath: f.legacyPath, now: Date.now }
      await expect(
        initializeFreshAccountStore(modules, request),
      ).rejects.toThrow('existing or appearing legacy source')
      await unlink(f.legacyPath)
      await symlink(join(f.root, 'missing-dir'), f.legacyPath, 'junction')
      await expect(
        initializeFreshAccountStore(modules, request),
      ).rejects.toThrow('existing or appearing legacy source')
      await unlink(f.legacyPath)
      const paths = logicalPaths(f.legacyPath)
      await symlink(join(f.root, 'home'), paths.storeDir, 'junction')
      await expect(
        initializeFreshAccountStore(modules, request),
      ).rejects.toThrow('foreign logical store directory')
      await unlink(paths.storeDir)
      await mkdir(paths.storeDir, { mode: 0o700 })
      await writeFile(
        paths.configPath,
        '{"version":1,"accounts":[],"commonAuthPool":{"schemaVersion":1,"rows":{}}}',
        { mode: 0o600, flag: 'wx' },
      )
      const before = await readFile(paths.configPath)
      await expect(
        initializeFreshAccountStore(modules, request),
      ).rejects.toThrow('foreign logical store directory')
      expect(await readFile(paths.configPath)).toEqual(before)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
      await writeFile(paths.migrationPath, '{}', { mode: 0o600, flag: 'wx' })
      await expect(
        initializeFreshAccountStore(modules, request),
      ).rejects.toThrow('foreign logical store directory')
    },
  )

  for (const phase of ['capture', 'build', 'verify', 'retire', 'activate']) {
    for (const side of ['before', 'after'])
      integrationIt(
        `fresh source appearance at ${side}-${phase} refuses without changing L`,
        async (fixture, modules) => {
          const f = await fixture()
          await unlink(f.legacyPath)
          await expect(
            initializeFreshAccountStore(modules, {
              legacyPath: f.legacyPath,
              now: Date.now,
              onBoundary: async (point) => {
                if (point === `${side}-${phase}`)
                  await writeFile(f.legacyPath, 'foreign appearing source', {
                    mode: 0o600,
                    flag: 'wx',
                  })
              },
            }),
          ).rejects.toThrow('existing or appearing legacy source')
          expect(await readFile(f.legacyPath, 'utf8')).toBe(
            'foreign appearing source',
          )
          expect(
            (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
              .status,
          ).not.toBe('active')
        },
      )
  }

  integrationIt(
    'supported package exports resolve inside the verified package and refuse missing or corrupted maps',
    async (fixture, _modules, inputs) => {
      const good = await preparePublicMigrationConsumer(await fixture(), inputs)
      const paths = await resolvePublicMigrationConsumer(good)
      expect(resolvedConsumerPath(paths.store)).toBe(good.expectedStore)
      expect(resolvedConsumerPath(paths.fs)).toBe(good.expectedFs)
      const missing = await preparePublicMigrationConsumer(
        await fixture(),
        inputs,
      )
      const missingManifest = record(
        await json(join(missing.packageRoot, 'package.json')),
      )
      delete missingManifest.exports
      await writeFile(
        join(missing.packageRoot, 'package.json'),
        JSON.stringify(missingManifest),
        { mode: 0o600 },
      )
      await expect(resolvePublicMigrationConsumer(missing)).rejects.toThrow()
      const corrupt = await preparePublicMigrationConsumer(
        await fixture(),
        inputs,
      )
      const corruptManifest = record(
        await json(join(corrupt.packageRoot, 'package.json')),
      )
      record(corruptManifest.exports)['./store'] = {
        import: './dist/fs/index.js',
      }
      await writeFile(
        join(corrupt.packageRoot, 'package.json'),
        JSON.stringify(corruptManifest),
        { mode: 0o600 },
      )
      await expect(resolvePublicMigrationConsumer(corrupt)).rejects.toThrow()
    },
  )
})

describe('migration source and active-generation counterexamples', () => {
  integrationIt(
    'three-row raw-index-7 fallback preserves absent and null family encodings through rollback',
    async (fixture, modules) => {
      for (const families of [
        undefined,
        null,
        { claude: null, gemini: null },
      ]) {
        const source = {
          version: 4,
          activeIndex: 7,
          ...(families === undefined ? {} : { activeIndexByFamily: families }),
          accounts: [
            { refreshToken: 'synthetic-three-a', addedAt: 1, lastUsed: 1 },
            { refreshToken: 'synthetic-three-b', addedAt: 2, lastUsed: 2 },
            { refreshToken: 'synthetic-three-c', addedAt: 3, lastUsed: 3 },
          ],
        }
        const f = await fixture(source)
        await createAccountMigrationFactory(modules)(options(f))
        await createAccountRollbackFactory(modules)(options(f))
        expect(await json(f.legacyPath)).toEqual(source)
      }
    },
  )

  integrationIt(
    'cancelled pending empty seed completes cleanup on rollback retry and can remigrate',
    async (fixture, modules) => {
      const f = await fixture({ version: 4, accounts: [], activeIndex: 0 })
      const before = await readFile(f.legacyPath)
      await expect(
        createAccountMigrationFactory(modules)({
          ...options(f),
          onBoundary: (point) => {
            if (point === 'public:initialize:before-config-write')
              throw new Error('stop owned empty seed')
          },
        }),
      ).rejects.toThrow('stop owned empty seed')
      const rollback = createAccountRollbackFactory(modules)
      expect((await rollback(options(f))).status).toBe('completed')
      expect((await rollback(options(f))).status).toBe('completed')
      expect(await readFile(f.legacyPath)).toEqual(before)
      const settings = await fixtureStore(modules, f.legacyPath).readSettings()
      if (settings.status !== 'ready')
        throw new Error('cancelled seed remained pending')
      expect(settings.settings.antigravityManagement).toBeUndefined()
      expect(
        (await createAccountMigrationFactory(modules)(options(f))).status,
      ).toBe('completed')
      await assertCurrentStoreRows(fixtureStore(modules, f.legacyPath), {
        version: 4,
        accounts: [],
        activeIndex: 0,
      })
    },
  )

  integrationIt(
    'pending journal token, clock and metadata changes cannot alter its exclusive capture',
    async (fixture, modules) => {
      for (const field of ['token', 'clock', 'metadata']) {
        const f = await fixture()
        const before = await readFile(f.legacyPath)
        await expect(
          createAccountMigrationFactory(modules)({
            ...options(f),
            onBoundary: (point) => {
              if (point === 'after-capture')
                throw new Error('pause captured source')
            },
          }),
        ).rejects.toThrow('pause captured source')
        const paths = resolveAccountStorePaths(f.legacyPath)
        const changed = record(await json(paths.migrationPath))
        const manifest = record(changed.manifest)
        if (field === 'clock')
          manifest.normalizationClock = Number(manifest.normalizationClock) + 1
        else {
          if (!Array.isArray(manifest.accounts))
            throw new Error('captured account list absent')
          const row = record(manifest.accounts[0])
          if (field === 'token') row.refreshToken = 'synthetic-tampered'
          else record(row.metadata).lastUsed = 999
        }
        await writeFile(paths.migrationPath, JSON.stringify(changed), {
          mode: 0o600,
        })
        await expect(
          createAccountMigrationFactory(modules)(options(f)),
        ).rejects.toThrow('exclusive capture snapshot')
        expect(await readFile(f.legacyPath)).toEqual(before)
        await expect(readFile(paths.configPath)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
    },
  )

  integrationIt(
    'active ownership permits current refresh, row replacement and retained tombstones but refuses damaged or foreign config',
    async (fixture, modules) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      const paths = resolveAccountStorePaths(f.legacyPath)
      const original = record(await json(paths.configPath))
      const generation = original.antigravityGeneration
      expect(record(generation).id).toBe(
        decodeAccountMigrationJournal(await json(paths.migrationPath)).id,
      )
      const store = fixtureStore(modules, f.legacyPath)
      const read = await store.read()
      if (read.status !== 'ready') throw new Error('current rows absent')
      await store.rotate(read.rows[0]!.id, {
        type: 'oauth',
        refresh: 'synthetic-active-new-current',
      })
      await store.remove(read.rows[1]!.id)
      await store.reorder([read.rows[0]!.id])
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
      const updated = record(await json(paths.configPath))
      expect(updated.antigravityGeneration).toEqual(generation)
      const goodBytes = await readFile(paths.configPath)
      for (const damaged of [
        { ...updated, antigravityGeneration: undefined },
        {
          ...updated,
          antigravityGeneration: {
            ...record(generation),
            id: '00000000-0000-4000-8000-000000000000',
          },
        },
        {
          antigravityGeneration: generation,
          antigravityRouting: updated.antigravityRouting,
        },
      ]) {
        await writeFile(paths.configPath, JSON.stringify(damaged), {
          mode: 0o600,
        })
        expect(
          (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
            .status,
        ).toBe('error')
      }
      await writeFile(paths.configPath, goodBytes, { mode: 0o600 })
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('active')
    },
  )
})

describe('genuine public failure mapping', () => {
  integrationIt(
    'public store contention remains a bounded pending migration outcome',
    async (fixture, modules) => {
      const f = await fixture()
      let release: () => void = () => {}
      let acquired: () => void = () => {}
      let acquisitionObserved = false
      const untilRelease = new Promise<void>((resolve) => {
        release = resolve
      })
      const acquiredPromise = new Promise<void>((resolve) => {
        acquired = resolve
      })
      let holder: Promise<void> | undefined
      try {
        const result = await createAccountMigrationFactory(modules)({
          ...options(f),
          onBoundary: async (point) => {
            if (point !== 'after-capture') return
            const paths = resolveAccountStorePaths(f.legacyPath)
            holder = modules.fs.withLock(
              paths.configPath,
              { name: 'save', ttlMs: 10_000, timeoutMs: 2_000, renew: true },
              async () => {
                acquisitionObserved = true
                acquired()
                await untilRelease
              },
            )
            if (
              !(await settledWithin(
                Promise.race([acquiredPromise, holder]),
                500,
              )) ||
              !acquisitionObserved
            )
              throw new Error(
                'owned contention fixture did not acquire its save lease',
              )
          },
        })
        expect(result).toEqual({ status: 'pending', reason: 'lock-contention' })
        expect(
          (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
            .status,
        ).toBe('pending')
      } finally {
        release()
        await holder
      }
    },
  )

  integrationIt(
    'public store lease-loss failure remains pending without retiring the source',
    async (fixture, modules) => {
      const f = await fixture()
      const before = await readFile(f.legacyPath)
      const result = await createAccountMigrationFactory(modules)({
        ...options(f),
        onBoundary: async (point) => {
          if (point !== 'public:add:before-state-write') return
          const paths = resolveAccountStorePaths(f.legacyPath)
          const path = modules.fs.lockPathFor(
            paths.configPath,
            'antigravity-management',
          )
          const changed = record(await json(path))
          changed.ownerId = '00000000-0000-4000-8000-000000000000'
          await writeFile(path, JSON.stringify(changed), { mode: 0o600 })
        },
      })
      expect(result).toEqual({ status: 'pending', reason: 'ownership-lost' })
      expect(await readFile(f.legacyPath)).toEqual(before)
    },
  )
})

describe('exclusive pointer publication and immutable generation paths', () => {
  integrationIt(
    'absent L and absent pointer refuse an unrelated empty logical store directory unchanged',
    async (fixture, modules) => {
      const f = await fixture()
      await unlink(f.legacyPath)
      const logical = logicalPaths(f.legacyPath)
      await mkdir(logical.storeDir, { mode: 0o700 })
      const before = await lstat(logical.storeDir)
      await expect(
        initializeFreshAccountStore(modules, {
          legacyPath: f.legacyPath,
          now: Date.now,
        }),
      ).rejects.toThrow('foreign logical store directory')
      const after = await lstat(logical.storeDir)
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
      expect(await readdir(logical.storeDir)).toEqual([])
      await expect(
        readFile(accountStorePointerPath(f.legacyPath)),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
    },
  )

  integrationIt(
    'link EEXIST preserves a competing foreign pointer and never adopts a foreign directory',
    async (fixture, modules) => {
      const f = await fixture()
      await unlink(f.legacyPath)
      const pointerPath = accountStorePointerPath(f.legacyPath)
      const foreign = 'foreign pointer bytes'
      await expect(
        initializeFreshAccountStore(modules, {
          legacyPath: f.legacyPath,
          now: Date.now,
          onBoundary: async (point) => {
            if (point === 'pointer:before-link')
              await writeFile(pointerPath, foreign, { mode: 0o600, flag: 'wx' })
          },
        }),
      ).rejects.toThrow('pointer publication refuses overwrite')
      expect(await readFile(pointerPath, 'utf8')).toBe(foreign)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
    },
  )

  integrationIt(
    'a logical foreign empty directory appearing immediately before link survives untouched',
    async (fixture, modules) => {
      const f = await fixture()
      await unlink(f.legacyPath)
      const logical = logicalPaths(f.legacyPath)
      await expect(
        initializeFreshAccountStore(modules, {
          legacyPath: f.legacyPath,
          now: Date.now,
          onBoundary: async (point) => {
            if (point === 'pointer:before-link')
              await mkdir(logical.storeDir, { mode: 0o700 })
          },
        }),
      ).rejects.toThrow('foreign logical store directory')
      expect(await readdir(logical.storeDir)).toEqual([])
    },
  )

  integrationIt(
    'pointer aliases, arbitrary basenames and a missing pointed journal do not imply active',
    async (fixture, modules) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      const paths = resolveAccountStorePaths(f.legacyPath)
      const path = accountStorePointerPath(f.legacyPath)
      const good = await readFile(path)
      const pointer = record(JSON.parse(good.toString('utf8')))
      await writeFile(
        path,
        JSON.stringify({ ...pointer, directoryBasename: '../foreign' }),
        { mode: 0o600 },
      )
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
      await unlink(path)
      await symlink(join(f.root, 'missing-pointer'), path)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
      await unlink(path)
      await writeFile(path, good, { mode: 0o600, flag: 'wx' })
      await unlink(paths.migrationPath)
      expect(
        (await readAccountStoreAdmission(f.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
    },
  )

  integrationIt(
    'remigration preserves old physical directories and refuses stale constructor generation admission',
    async (fixture, modules) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      const old = resolveAccountStorePaths(f.legacyPath)
      const oldJournal = decodeAccountMigrationJournal(
        await json(old.migrationPath),
      )
      await createAccountRollbackFactory(modules)(options(f))
      await createAccountMigrationFactory(modules)(options(f))
      const current = resolveAccountStorePaths(f.legacyPath)
      expect(current.storeDir).not.toBe(old.storeDir)
      expect((await lstat(old.storeDir)).isDirectory()).toBe(true)
      expect(
        (
          await readAccountStoreAdmission(
            f.legacyPath,
            modules,
            Date.now,
            oldJournal.id,
          )
        ).status,
      ).toBe('error')
      const admitted = await readAccountStoreAdmission(
        f.legacyPath,
        modules,
        Date.now,
      )
      expect(admitted.status).toBe('active')
      if (admitted.status !== 'active')
        throw new Error('current publication not active')
      expect(admitted.paths).toEqual(current)
    },
  )
})

describe('trusted binding is not credential-serving admission', () => {
  integrationIt(
    'completed generation binds for clear and replacement recovery while serving remains pending',
    async (fixture, modules) => {
      const f = await fixture()
      await createAccountMigrationFactory(modules)(options(f))
      const paths = resolveAccountStorePaths(f.legacyPath)
      const generation = decodeAccountMigrationJournal(
        await json(paths.migrationPath),
      ).id
      const store = fixtureStore(modules, f.legacyPath)
      for (const kind of ['clear', 'replace-pool']) {
        await store.updateSettings((settings) => {
          settings.antigravityManagement = {
            id: '00000000-0000-4000-8000-000000000000',
            kind,
            targets: [],
            progress: { step: 'remove', completedTargets: [] },
            ...(kind === 'replace-pool' ? { inputDigest: '0'.repeat(64) } : {}),
          }
          return settings
        })
        const binding = await readAccountStoreBinding(
          f.legacyPath,
          modules,
          Date.now,
          generation,
        )
        expect(binding.status).toBe('bound')
        if (binding.status !== 'bound')
          throw new Error('trusted recovery binding unavailable')
        expect(binding.paths).toEqual(paths)
        expect(
          (
            await readAccountStoreAdmission(
              f.legacyPath,
              modules,
              Date.now,
              generation,
            )
          ).status,
        ).toBe('pending')
        // The repository owns strict management decoding/resumption. Its genuine
        // reopen tests consume these published physical config.json/state.json
        // and migration.json paths, not the unrelated logical store directory.
      }
      await store.updateSettings((settings) => {
        delete settings.antigravityManagement
        return settings
      })
      expect(
        (
          await readAccountStoreAdmission(
            f.legacyPath,
            modules,
            Date.now,
            generation,
          )
        ).status,
      ).toBe('active')
      expect(
        (
          await readAccountStoreBinding(
            f.legacyPath,
            modules,
            Date.now,
            '00000000-0000-4000-8000-000000000000',
          )
        ).status,
      ).toBe('error')
    },
  )

  integrationIt(
    'torn and orphan public credentials permit trusted binding but never serving',
    async (fixture, modules) => {
      const torn = await fixture()
      await createAccountMigrationFactory(modules)(options(torn))
      const stable = fixtureStore(modules, torn.legacyPath)
      const before = await stable.read()
      if (before.status !== 'ready')
        throw new Error('baseline current credentials unavailable')
      const row = before.rows[0]
      if (!row) throw new Error('baseline row unavailable')
      const interrupted = fixtureStore(
        modules,
        torn.legacyPath,
        (step, info) => {
          if (info.operation === 'replace' && step === 'after-state-write')
            throw new Error('stop genuine torn replacement')
        },
      )
      await expect(
        interrupted.replace(
          row.id,
          { type: 'oauth', refresh: 'synthetic-torn-current' },
          { providerState: row.providerState },
        ),
      ).rejects.toThrow('stop genuine torn replacement')
      expect(
        (await readAccountStoreBinding(torn.legacyPath, modules, Date.now))
          .status,
      ).toBe('bound')
      expect(
        (await readAccountStoreAdmission(torn.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')

      const orphan = await fixture()
      await createAccountMigrationFactory(modules)(options(orphan))
      const interruptedAdd = fixtureStore(
        modules,
        orphan.legacyPath,
        (step, info) => {
          if (info.operation === 'add' && step === 'after-state-write')
            throw new Error('stop genuine orphan add')
        },
      )
      await expect(
        interruptedAdd.add({
          id: '00000000-0000-4000-8000-000000000001',
          credential: { type: 'oauth', refresh: 'synthetic-orphan-current' },
          providerState: {
            schemaVersion: 1,
            metadata: { addedAt: 1, lastUsed: 1 },
          },
        }),
      ).rejects.toThrow('stop genuine orphan add')
      expect(
        (await readAccountStoreBinding(orphan.legacyPath, modules, Date.now))
          .status,
      ).toBe('bound')
      expect(
        (await readAccountStoreAdmission(orphan.legacyPath, modules, Date.now))
          .status,
      ).toBe('error')
    },
  )

  integrationIt(
    'unfinished migration or rollback and inactive generations cannot be recovery bindings',
    async (fixture, modules) => {
      const f = await fixture()
      await expect(
        createAccountMigrationFactory(modules)({
          ...options(f),
          onBoundary: (point) => {
            if (point === 'after-capture')
              throw new Error('stop pending generation')
          },
        }),
      ).rejects.toThrow('stop pending generation')
      expect(
        (await readAccountStoreBinding(f.legacyPath, modules, Date.now)).status,
      ).toBe('pending')
      await createAccountMigrationFactory(modules)(options(f))
      await expect(
        createAccountRollbackFactory(modules)({
          ...options(f),
          onBoundary: (point) => {
            if (point === 'rollback:after-capture')
              throw new Error('stop pending rollback')
          },
        }),
      ).rejects.toThrow('stop pending rollback')
      expect(
        (await readAccountStoreBinding(f.legacyPath, modules, Date.now)).status,
      ).toBe('pending')
      await createAccountRollbackFactory(modules)(options(f))
      expect(
        (await readAccountStoreBinding(f.legacyPath, modules, Date.now)).status,
      ).toBe('inactive')
    },
  )
})
