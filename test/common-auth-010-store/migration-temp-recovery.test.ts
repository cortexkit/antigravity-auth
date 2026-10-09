import { describe, expect, it, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCOUNT_STORE_GENERATION_SETTINGS_KEY,
  type AccountMigrationModules,
  createAccountMigrationFactory,
  createAccountRollbackFactory,
  decodeAccountMigrationJournal,
  readAccountStoreAdmission,
  resolvePublishedAccountStorePaths,
} from '../../packages/core/src/account-migration.ts'
import {
  decodeProviderState,
  encodeQuotaState,
  isValidProviderState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from '../../packages/core/src/account-repository-codecs.ts'
import {
  assertDisposableChildRoot,
  loadPublicMigrationModules,
  MIGRATION_SOURCE,
  type MigrationFixture,
  type MigrationFixtureInputs,
  migrationChildEnvironment,
  migrationFixtureInputs,
  preparePublicMigrationConsumer,
  resolvePublicMigrationConsumer,
  withMigrationFixtures,
} from './migration-child.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE = join(ROOT, 'packages/core/src/account-migration.ts')
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const options = (fixture: MigrationFixture) => ({
  legacyPath: fixture.legacyPath,
  now: () => 100,
  offline: { processesStopped: true as const },
})
async function pathsOf(fixture: MigrationFixture) {
  const paths = await resolvePublishedAccountStorePaths(fixture.legacyPath)
  if (!paths) throw new Error('fixture has no published generation')
  return paths
}
async function journalOf(fixture: MigrationFixture) {
  return decodeAccountMigrationJournal(
    JSON.parse(
      await fs.readFile((await pathsOf(fixture)).migrationPath, 'utf8'),
    ),
  )
}
function openStore(
  modules: AccountMigrationModules,
  paths: Awaited<ReturnType<typeof pathsOf>>,
) {
  return modules.store.openPoolStore({
    provider: 'antigravity',
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: QUOTA_CODEC,
    providerState: {
      validate: isValidProviderState,
      credentialBound: providerStateCredentialBound,
      merge: (_previous, incoming) => incoming,
      onReplace: () => {
        throw new Error('fixture must not replace credentials')
      },
    },
    requireCredentialStamps: true,
    now: () => 100,
  })
}
async function assertImported(
  fixture: MigrationFixture,
  modules: AccountMigrationModules,
) {
  const paths = await pathsOf(fixture)
  const journal = await journalOf(fixture)
  expect(journal.status).toBe('active')
  expect(Object.hasOwn(journal, 'ownedTemps')).toBe(false)
  expect(journal.mapping).toHaveLength(2)
  const store = openStore(modules, paths)
  const view = await store.read()
  expect(view.status).toBe('ready')
  if (view.status !== 'ready')
    throw new Error('import did not produce a ready store')
  expect(view.rows.map((row) => row.id)).toEqual(
    journal.mapping.map((row) => row.id),
  )
  for (const [index, row] of view.rows.entries()) {
    const captured = journal.manifest.accounts[index]
    const intended = MIGRATION_SOURCE.accounts[index]
    if (!captured || !intended)
      throw new Error('missing captured or intended row')
    expect(row.credential).toEqual({
      type: 'oauth',
      refresh: intended.refreshToken,
      lastRefreshedAt: 100,
    })
    expect(row.credentialEpoch).toBe(1)
    expect(row.hasEntry).toBe(true)
    expect(row.stamp).toBe('bound')
    expect(row.unbound).toBeUndefined()
    expect(row.invalid).toBeUndefined()
    expect(row.torn).toBeUndefined()
    expect(row.enabled).toBe(captured.metadata.enabled !== false)
    expect(decodeProviderState(row.providerState)?.metadata).toEqual(
      captured.metadata,
    )
    expect(row.quota).toEqual(
      captured.quota === undefined
        ? undefined
        : encodeQuotaState(captured.quota),
    )
  }
  const settings = await store.readSettings()
  expect(settings.status).toBe('ready')
  if (settings.status !== 'ready')
    throw new Error('missing generation settings')
  const saved = JSON.parse(await fs.readFile(paths.migrationPath, 'utf8'))
  const manifestBytes = JSON.stringify(saved.manifest, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  )
  expect(settings.settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY]).toEqual({
    schemaVersion: 1,
    id: journal.id,
    legacyPath: journal.legacyPath,
    storeDir: journal.storeDir,
    sourceKind: 'file',
    initialManifestSha256: sha256(Buffer.from(manifestBytes)),
  })
  expect(
    (await readAccountStoreAdmission(fixture.legacyPath, modules, () => 100))
      .status,
  ).toBe('active')
  const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
  const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'))
  expect(config.accounts.map((row: { id: string }) => row.id)).toEqual(
    journal.mapping.map((row) => row.id),
  )
  expect(Object.keys(state.accounts).sort()).toEqual(
    journal.mapping.map((row) => row.id).sort(),
  )
}

// Always run the real-public-store durability check. The separately admitted Mac
// process-crash matrix is selected with ACCOUNT_MIGRATION_TEMP_CRASH=1; it never
// falls back to an unsandboxed executable when the required pins are unavailable.
describe('public migration target durability', () => {
  it('syncs each renamed target then its directory under native locks before acknowledgment', async () => {
    await withMigrationFixtures(async (fixture) => {
      const owned = await fixture()
      const inputs = migrationFixtureInputs(process.env)
      const modules = await loadPublicMigrationModules(owned, inputs)
      const actualOpen = fs.open
      let interval:
        | { target: string; directory: string; syncs: string[] }
        | undefined
      const completed: string[] = []
      const probe = spyOn(fs, 'open').mockImplementation(
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await actualOpen(...args)
          const actualSync = handle.sync.bind(handle)
          handle.sync = async () => {
            await actualSync()
            if (interval) interval.syncs.push(String(args[0]))
          }
          return handle
        },
      )
      const guarded: AccountMigrationModules = {
        ...modules,
        fs: {
          ...modules.fs,
          async writeJsonAtomic(...args) {
            expect(interval).toBeUndefined()
            return modules.fs.writeJsonAtomic(...args)
          },
        },
        store: {
          ...modules.store,
          openPoolStore(config) {
            return modules.store.openPoolStore({
              ...config,
              async onStep(step, info) {
                expect(interval).toBeUndefined()
                if (step.startsWith('after-')) {
                  const target = step.includes('state')
                    ? config.statePath
                    : config.configPath
                  interval = { target, directory: dirname(target), syncs: [] }
                  for (const path of [config.configPath, config.statePath]) {
                    const lock = JSON.parse(
                      await fs.readFile(
                        modules.fs.lockPathFor(path, 'save'),
                        'utf8',
                      ),
                    )
                    expect(lock.ownerId).toMatch(/^[a-f0-9-]{36}$/)
                  }
                  await config.onStep?.(step, info)
                  expect(interval.syncs).toEqual([target, dirname(target)])
                  completed.push(`${info.operation}:${step}`)
                  interval = undefined
                } else {
                  await config.onStep?.(step, info)
                }
              },
            })
          },
        },
      }
      try {
        expect(
          (await createAccountMigrationFactory(guarded)(options(owned))).status,
        ).toBe('completed')
        expect(completed).toContain('add:after-state-write')
        expect(completed).toContain('add:after-config-write')
        expect(completed.length).toBeGreaterThan(4)
        await assertImported(owned, modules)
      } finally {
        probe.mockRestore()
      }
    })
  })
})

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`explicit local crash gate requires ${name}`)
  return value
}
async function pinnedExecutable(path: string, expected: string): Promise<void> {
  if (path !== resolve(path) || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error(
      'executable pin must be an absolute path and independent SHA256',
    )
  const stat = await fs.stat(path)
  if (!stat.isFile() || sha256(await fs.readFile(path)) !== expected)
    throw new Error(`executable differs from supplied pin: ${path}`)
}
async function within(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((done) => {
        timer = setTimeout(() => done(false), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// A generated entry keeps child execution out of bun:test. Imports in the bridge
// use only the admitted package's public specifiers; no private dist URL is used.
function childEntry(
  consumerPath: string,
  kind: 'state' | 'config',
  window: 'before' | 'after',
) {
  return `
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { createAccountMigrationFactory, resolvePublishedAccountStorePaths } from ${JSON.stringify(SOURCE)}
import { assertDisposableChildRoot } from ${JSON.stringify(join(ROOT, 'test/common-auth-010-store/migration-child.ts'))}
const [root, nonce, parent, port] = process.argv.slice(2)
const parentPid = Number(parent)
await assertDisposableChildRoot(root, nonce, parentPid, process.env)
if (process.ppid !== parentPid) throw new Error('child parent differs from fixture owner')
const deadline = setTimeout(() => process.exit(75), 5000)
try {
  let profileDenied = false
  try { await readFile(join(root, 'denied-profile')) } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    profileDenied = true
  }
  if (!profileDenied) throw new Error('OS profile-read denial did not hold')
  const networkDenied = await new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) })
    socket.once('connect', () => { socket.destroy(); reject(new Error('OS network denial did not hold')) })
    socket.once('error', (error) => {
      socket.destroy()
      if (['EPERM', 'EACCES', 'ECONNREFUSED'].includes(error.code)) done(true)
      else reject(error)
    })
  })
  const { importEntries } = await import(${JSON.stringify(consumerPath)})
  const modules = await importEntries()
  const native = modules.store
  const wrapped = { ...modules, store: { ...native, openPoolStore(config) {
    return native.openPoolStore({ ...config, async onStep(step, info) {
      if (info.operation === 'add' && step === ${JSON.stringify(`${window}-${kind}-write`)}) {
        const paths = await resolvePublishedAccountStorePaths(join(root, 'accounts.json'))
        if (!paths) throw new Error('crash lacks a published generation')
        const locks = []
        for (const directory of [root, paths.storeDir]) {
          for (const name of await readdir(directory)) {
            if (!name.endsWith('.lock')) continue
            const path = join(directory, name)
            const stat = await lstat(path)
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('claimed lock is not regular')
            const payload = JSON.parse(await readFile(path, 'utf8'))
            locks.push({ path, dev: stat.dev, ino: stat.ino, ownerId: payload.ownerId })
          }
        }
        const names = (await readdir(paths.storeDir)).filter(name => name.startsWith(${JSON.stringify(`${kind}.json.`)}) && name.endsWith('.tmp'))
        const journal = JSON.parse(await readFile(paths.migrationPath, 'utf8'))
        const report = { pid: process.pid, nonce, kind: ${JSON.stringify(kind)}, window: ${JSON.stringify(window)}, observerForwarded: false, names, locks, journal, networkDenied, profileDenied }
        await writeFile(join(root, 'crash.json'), JSON.stringify(report), { mode: 0o600, flag: 'wx' })
        console.log(JSON.stringify({ kind: 'process-crash', pid: process.pid, nonce, step, observerForwarded: false }))
        await assertDisposableChildRoot(root, nonce, parentPid, process.env)
        if (process.ppid !== parentPid) throw new Error('child ownership changed before abrupt exit')
        // Abrupt process exit bypasses writeJsonAtomic's finally and all lease
        // release callbacks. It demonstrates process recovery, not power-loss survival.
        process.exit(73)
      }
      await config.onStep?.(step, info)
    } })
  } } }
  await createAccountMigrationFactory(wrapped)({ legacyPath: join(root, 'accounts.json'), now: () => 100, offline: { processesStopped: true }, async onBoundary(point) {
    if (point !== 'after-capture') return
    const paths = await resolvePublishedAccountStorePaths(join(root, 'accounts.json'))
    await writeFile(join(paths.storeDir, 'foreign-note.tmp'), 'foreign regular sentinel', { mode: 0o600, flag: 'wx' })
    const { symlink } = await import('node:fs/promises')
    await symlink(join(root, 'denied-profile'), join(paths.storeDir, 'foreign-link.tmp'))
  } })
  throw new Error('named native crash seam was not reached')
} finally { clearTimeout(deadline) }
`
}

interface CrashReport {
  pid: number
  nonce: string
  kind: 'state' | 'config'
  window: 'before' | 'after'
  observerForwarded: false
  names: string[]
  locks: { path: string; dev: number; ino: number; ownerId: string }[]
  journal: unknown
  networkDenied: true
  profileDenied: true
}
async function crashBeforeForwarding(
  fixture: MigrationFixture,
  inputs: MigrationFixtureInputs,
  kind: 'state' | 'config',
  window: 'before' | 'after',
): Promise<CrashReport> {
  if (process.platform !== 'darwin')
    throw new Error('explicit crash gate requires macOS Seatbelt')
  const executable = required('ACCOUNT_MIGRATION_TEMP_BUN')
  const executablePin = required('ACCOUNT_MIGRATION_TEMP_BUN_SHA256')
  const sandboxPin = required('ACCOUNT_MIGRATION_TEMP_SANDBOX_SHA256')
  await pinnedExecutable(executable, executablePin)
  await pinnedExecutable('/usr/bin/sandbox-exec', sandboxPin)
  const consumer = await preparePublicMigrationConsumer(fixture, inputs)
  await resolvePublicMigrationConsumer(consumer)
  const program = join(fixture.root, 'temp-crash-child.mjs')
  await fs.writeFile(program, childEntry(consumer.consumerPath, kind, window), {
    mode: 0o600,
    flag: 'wx',
  })
  await fs.writeFile(
    join(fixture.root, 'denied-profile'),
    'protected foreign profile sentinel',
    { mode: 0o600, flag: 'wx' },
  )
  const literal = (path: string) => JSON.stringify(path)
  const profile = `(version 1)(allow default)(deny network*)
(deny file-write* (require-all (require-not (subpath ${literal(fixture.root)})) (require-not (literal "/dev/null"))))
(deny file-read* (literal ${literal(join(fixture.root, 'denied-profile'))}))
(deny file-read* (require-all (subpath "/Users") (require-not (subpath ${literal(ROOT)})) (require-not (literal ${literal(executable)}))))`
  const env = migrationChildEnvironment(fixture, inputs)
  await assertDisposableChildRoot(fixture.root, fixture.nonce, process.pid, env)
  let connections = 0
  const listener = createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise<void>((done, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', done)
  })
  const address = listener.address()
  if (!address || typeof address === 'string')
    throw new Error('network-denial control lacks a live endpoint')
  // Bun reports some Seatbelt-denied connects as ECONNREFUSED. The endpoint
  // must be demonstrably live, not an unused port that would refuse anyway.
  await new Promise<void>((done, reject) => {
    const control = createConnection({ host: '127.0.0.1', port: address.port })
    control.once('error', reject)
    control.once('close', () => done())
  })
  expect(connections).toBe(1)
  const argv = [
    '-p',
    profile,
    executable,
    program,
    fixture.root,
    fixture.nonce,
    String(process.pid),
    String(address.port),
  ]
  const child = spawn('/usr/bin/sandbox-exec', argv, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  fixture.cleanupBlocked = 'owned child exit has not been observed'
  const pid = child.pid
  let exited = false
  let failure: Error | undefined
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
  const sizes = { stdout: 0, stderr: 0 }
  const exit = new Promise<void>((done) => {
    child.once('exit', () => {
      exited = true
      done()
    })
    child.once('error', (error) => {
      failure = error
      done()
    })
  })
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  for (const name of ['stdout', 'stderr'] as const) {
    child[name].on('data', (bytes: Buffer) => {
      sizes[name] += bytes.length
      const kept = chunks[name].reduce((size, item) => size + item.length, 0)
      const room = Math.max(0, 128 * 1024 - kept)
      if (room) chunks[name].push(bytes.subarray(0, room))
      if (sizes[name] > 128 * 1024)
        failure = new Error('owned child output exceeded bound')
    })
  }
  const signal = async (name: 'SIGTERM' | 'SIGKILL') => {
    await assertDisposableChildRoot(
      fixture.root,
      fixture.nonce,
      process.pid,
      env,
    )
    if (exited || child.exitCode !== null || child.signalCode !== null) return
    if (pid === undefined || child.pid !== pid)
      throw new Error('owned direct child identity changed')
    if (!child.kill(name))
      throw new Error(`owned child ${name} was not delivered`)
  }
  try {
    if (!(await within(exit, 8000))) {
      failure = new Error('owned child exceeded finite execution bound')
      await signal('SIGTERM')
      if (!(await within(exit, 250))) await signal('SIGKILL')
      if (!(await within(exit, 1000)))
        throw new Error('owned child was not reaped; fixture retained')
    }
    if (exited) delete fixture.cleanupBlocked
    if (!(await within(closed, 1000)))
      throw new Error('owned child pipes did not close within bound')
    const evidence = required('ACCOUNT_MIGRATION_TEMP_EVIDENCE')
    const destination = join(evidence, `${fixture.nonce}-${window}-${kind}`)
    await fs.mkdir(destination, { mode: 0o700 })
    await fs.writeFile(
      join(destination, 'stdout'),
      Buffer.concat(chunks.stdout),
      { mode: 0o600 },
    )
    await fs.writeFile(
      join(destination, 'stderr'),
      Buffer.concat(chunks.stderr),
      { mode: 0o600 },
    )
    await fs.writeFile(
      join(destination, 'receipt.json'),
      JSON.stringify(
        {
          executable,
          executablePin,
          sandboxPin,
          argv,
          pid,
          exitCode: child.exitCode,
          signal: child.signalCode,
          sourceSha256: sha256(await fs.readFile(SOURCE)),
          testSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
          childSha256: sha256(await fs.readFile(program)),
          stdoutBytes: sizes.stdout,
          stderrBytes: sizes.stderr,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    if (failure) throw failure
    expect(exited).toBe(true)
    expect(child.exitCode).toBe(73)
    expect(child.signalCode).toBeNull()
    expect(listener.listening).toBe(true)
    expect(connections).toBe(1)
    const report: CrashReport = JSON.parse(
      await fs.readFile(join(fixture.root, 'crash.json'), 'utf8'),
    )
    if (pid === undefined) throw new Error('spawn did not capture an owned PID')
    expect(report.pid).toBe(pid)
    expect(report.nonce).toBe(fixture.nonce)
    expect(report.observerForwarded).toBe(false)
    expect(report.networkDenied).toBe(true)
    expect(report.profileDenied).toBe(true)
    expect(report.locks.length).toBeGreaterThan(2)
    expect(Object.hasOwn(report.journal as object, 'ownedTemps')).toBe(false)
    await fs.writeFile(
      join(destination, 'crash.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    )
    // Remove only this exited child's reported regular lease inodes, not native
    // staging files. Recovery then runs immediately rather than waiting for TTLs.
    for (const claim of report.locks) {
      if (
        !claim.path.startsWith(`${fixture.root}${sep}`) ||
        claim.path !== resolve(claim.path) ||
        !claim.path.endsWith('.lock')
      )
        throw new Error('child lease escapes owned fixture')
      const stat = await fs.lstat(claim.path)
      const current = JSON.parse(await fs.readFile(claim.path, 'utf8'))
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.dev !== claim.dev ||
        stat.ino !== claim.ino ||
        current.ownerId !== claim.ownerId
      )
        throw new Error('exited child lease identity changed')
      await fs.unlink(claim.path)
    }
    return report
  } finally {
    listener.close()
    if (!exited && child.pid !== undefined) {
      await signal('SIGTERM')
      if (!(await within(exit, 250))) await signal('SIGKILL')
      if (await within(exit, 1000)) delete fixture.cleanupBlocked
    }
  }
}

async function snapshot(path: string) {
  const stat = await fs.lstat(path)
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    symlink: stat.isSymbolicLink(),
    contents: stat.isSymbolicLink()
      ? await fs.readlink(path)
      : sha256(await fs.readFile(path)),
  }
}

if (process.env.ACCOUNT_MIGRATION_TEMP_CRASH === '1') {
  describe('admitted public-store process crashes', () => {
    it('before-observer native residues do not poison repeated resume or rollback', async () => {
      await withMigrationFixtures(async (fixture) => {
        const inputs = migrationFixtureInputs(process.env)
        const modules = await loadPublicMigrationModules(
          await fixture(),
          inputs,
        )
        for (const kind of ['state', 'config'] as const) {
          for (const recovery of ['resume', 'rollback'] as const) {
            const owned = await fixture()
            const original = await fs.readFile(owned.legacyPath)
            const report = await crashBeforeForwarding(
              owned,
              inputs,
              kind,
              'before',
            )
            const paths = await pathsOf(owned)
            expect(report.names).toHaveLength(1)
            const name = report.names[0]
            if (
              !name ||
              !new RegExp(`^${kind}\\.json\\.[a-f0-9-]{36}\\.tmp$`).test(name)
            )
              throw new Error(
                'native crash did not leave the intended private temp',
              )
            const residue = join(paths.storeDir, name)
            const preserved = [
              residue,
              join(paths.storeDir, 'foreign-note.tmp'),
              join(paths.storeDir, 'foreign-link.tmp'),
              join(owned.root, 'denied-profile'),
            ]
            const prior = await Promise.all(preserved.map(snapshot))
            expect(prior[0]?.mode).toBe(0o600)
            expect(prior[0]?.symlink).toBe(false)
            expect(prior[2]?.symlink).toBe(true)
            const captured = await journalOf(owned)
            expect(captured.completedRows).toEqual([])
            expect(
              sha256(
                await fs.readFile(
                  join(paths.backupsDir, `${captured.sourceSha256}.json`),
                ),
              ),
            ).toBe(sha256(original))
            if (recovery === 'resume') {
              const migrate = createAccountMigrationFactory(modules)
              expect((await migrate(options(owned))).status).toBe('completed')
              await assertImported(owned, modules)
              expect((await journalOf(owned)).mapping).toEqual(captured.mapping)
              const finished = await Promise.all(
                [paths.configPath, paths.statePath, paths.migrationPath].map(
                  (path) => fs.readFile(path),
                ),
              )
              expect((await migrate(options(owned))).status).toBe('completed')
              expect(
                await Promise.all(
                  [paths.configPath, paths.statePath, paths.migrationPath].map(
                    (path) => fs.readFile(path),
                  ),
                ),
              ).toEqual(finished)
              await assertImported(owned, modules)
            }
            const rollback = createAccountRollbackFactory(modules)
            expect((await rollback(options(owned))).status).toBe('completed')
            const restored = await fs.readFile(owned.legacyPath)
            expect((await rollback(options(owned))).status).toBe('completed')
            expect(await fs.readFile(owned.legacyPath)).toEqual(restored)
            const exported = JSON.parse(restored.toString('utf8'))
            expect(
              exported.accounts.map(
                (row: { refreshToken: string }) => row.refreshToken,
              ),
            ).toEqual(MIGRATION_SOURCE.accounts.map((row) => row.refreshToken))
            expect((await journalOf(owned)).status).toBe('inactive')
            if (recovery === 'rollback') expect(restored).toEqual(original)
            expect(await Promise.all(preserved.map(snapshot))).toEqual(prior)
            // A cancelled import allocates a new generation; it must not reclaim
            // inert credentials left in the previous, still-private generation.
            expect(
              (await createAccountMigrationFactory(modules)(options(owned)))
                .status,
            ).toBe('completed')
            expect((await pathsOf(owned)).storeDir).not.toBe(paths.storeDir)
            await assertImported(owned, modules)
            expect(await Promise.all(preserved.map(snapshot))).toEqual(prior)
          }
        }
      })
    }, 60000)

    it('after-rename before-observer targets recover with exact planned IDs and stamps', async () => {
      await withMigrationFixtures(async (fixture) => {
        const inputs = migrationFixtureInputs(process.env)
        const modules = await loadPublicMigrationModules(
          await fixture(),
          inputs,
        )
        for (const kind of ['state', 'config'] as const) {
          const owned = await fixture()
          const report = await crashBeforeForwarding(
            owned,
            inputs,
            kind,
            'after',
          )
          const paths = await pathsOf(owned)
          expect(report.names).toEqual([])
          const captured = await journalOf(owned)
          expect(captured.completedRows).toEqual([])
          const first = captured.mapping[0]?.id
          if (!first) throw new Error('crash has no planned first row')
          expect(first).toBeString()
          const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'))
          expect(Object.keys(state.accounts)).toEqual([first])
          if (kind === 'config') {
            const view = await openStore(modules, paths).read()
            expect(view.status).toBe('ready')
            if (view.status !== 'ready')
              throw new Error('renamed config must expose its imported row')
            expect(view.rows.map((row) => row.id)).toEqual([first])
            expect(view.rows[0]?.stamp).toBe('bound')
            expect(view.rows[0]?.credential).toEqual({
              type: 'oauth',
              refresh:
                MIGRATION_SOURCE.accounts[0]?.refreshToken ??
                (() => {
                  throw new Error('missing intended first row')
                })(),
              lastRefreshedAt: 100,
            })
          }
          const sentinels = [
            join(paths.storeDir, 'foreign-note.tmp'),
            join(paths.storeDir, 'foreign-link.tmp'),
            join(owned.root, 'denied-profile'),
          ]
          const prior = await Promise.all(sentinels.map(snapshot))
          const migrate = createAccountMigrationFactory(modules)
          expect((await migrate(options(owned))).status).toBe('completed')
          await assertImported(owned, modules)
          expect((await journalOf(owned)).mapping).toEqual(captured.mapping)
          const finished = await Promise.all(
            [paths.configPath, paths.statePath, paths.migrationPath].map(
              (path) => fs.readFile(path),
            ),
          )
          expect((await migrate(options(owned))).status).toBe('completed')
          await assertImported(owned, modules)
          expect(
            await Promise.all(
              [paths.configPath, paths.statePath, paths.migrationPath].map(
                (path) => fs.readFile(path),
              ),
            ),
          ).toEqual(finished)
          expect(await Promise.all(sentinels.map(snapshot))).toEqual(prior)
        }
      })
    }, 60000)
  })
}
