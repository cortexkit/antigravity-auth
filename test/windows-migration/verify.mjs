import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertPublishedAccountStoreGeneration,
  createAccountRepositoryFactory,
  loadCommonAuthStoreModules,
  resolvePublishedAccountStorePaths,
} from '../../packages/core/dist/index.js'

assert.equal(process.platform, 'win32')
const root = resolve(process.argv[2])
const consumer = resolve(process.argv[3])
const candidate = resolve(process.argv[4])
await mkdir(root, { recursive: true })
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const syncTest = join(root, 'sync-test.txt')
await writeFile(syncTest, 'synthetic sync test\n')
const minimal = []
for (const mode of ['r', 'r+']) {
  const handle = await open(syncTest, mode)
  try {
    await handle.sync()
    minimal.push({ mode, outcome: 'ok' })
  } catch (error) {
    minimal.push({
      mode,
      outcome: 'error',
      code: error.code,
      syscall: error.syscall,
    })
  } finally {
    await handle.close()
  }
}
await writeFile(join(root, 'minimal.json'), JSON.stringify(minimal, null, 2))
assert.equal(minimal[0].code, 'EPERM')
assert.equal(minimal[1].outcome, 'ok')

const profile = join(root, 'profile')
const config = join(profile, 'config', 'opencode')
await mkdir(config, { recursive: true })
const legacy = join(config, 'antigravity-accounts.json')
const original = Buffer.from(
  `${JSON.stringify(
    {
      version: 4,
      accounts: [
        {
          email: 'synthetic@example.invalid',
          refreshToken: 'synthetic-refresh-only-no-real-credential',
          projectId: 'synthetic-project',
          managedProjectId: 'synthetic-managed-project',
          enabled: true,
          addedAt: 1700000000000,
          lastUsed: 1700000000000,
          capturedPaidTierId: 'synthetic-paid-tier',
          capturedTierAt: 1700000000000,
          cachedQuota: {
            'gemini-flash': { remainingFraction: 0.75, modelCount: 1 },
          },
          cachedQuotaUpdatedAt: 1700000000000,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { gemini: 0, claude: 0 },
    },
    null,
    2,
  )}\n`,
)
await writeFile(legacy, original)
const env = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: join(profile, 'roaming'),
  LOCALAPPDATA: join(profile, 'local'),
  XDG_CONFIG_HOME: join(profile, 'config'),
  XDG_DATA_HOME: join(profile, 'data'),
  XDG_CACHE_HOME: join(profile, 'cache'),
  XDG_STATE_HOME: join(profile, 'state'),
  OPENCODE_CONFIG_DIR: config,
  PI_AGENT_DIR: join(profile, 'pi'),
  PI_CODING_AGENT_DIR: join(profile, 'pi-native'),
  PROBE_PROFILE: profile,
}
const hook = pathToFileURL(resolve('test/windows-migration/sync-hook.mjs')).href
const attempts = []
async function migrate(label, cli) {
  const eventsPath = join(root, `${label}.sync.jsonl`)
  const result = spawnSync(
    process.execPath,
    ['--import', hook, cli, 'migrate', '--offline'],
    {
      cwd: profile,
      env: { ...env, PROBE_SYNC_EVENTS: eventsPath },
      input: 'yes\n',
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  await writeFile(join(root, `${label}.stdout`), result.stdout ?? '')
  await writeFile(join(root, `${label}.stderr`), result.stderr ?? '')
  const events = existsSync(eventsPath)
    ? (await readFile(eventsPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  attempts.push({
    label,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    events,
  })
  await writeFile(
    join(root, 'attempts.json'),
    JSON.stringify(attempts, null, 2),
  )
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  return { ...result, events }
}
async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else if (entry.isFile())
      found.push({ path, sha256: digest(await readFile(path)) })
    else throw new Error('Unexpected non-regular migration artifact')
  }
  return found
}
const baselineCli = join(
  consumer,
  'node_modules',
  '@cortexkit',
  'opencode-antigravity-auth',
  'dist',
  'cli.js',
)
const baseline = await migrate('released-3.0.0', baselineCli)
assert.equal(baseline.status, 1)
assert.match(baseline.stderr, /EPERM.*fsync/)
assert.equal(digest(await readFile(legacy)), digest(original))
assert.equal(existsSync(`${legacy}.store.pointer.json`), false)
const failedSync = baseline.events.find((event) => event.outcome === 'error')
assert.equal(failedSync?.code, 'EPERM')
assert.equal(failedSync?.flags, 0)
assert.match(failedSync?.path ?? '', /backups/)
const before = await files(profile)
assert.equal(before.length, 2)
const oldBackup = before.find((file) => file.path !== legacy)
assert.ok(oldBackup)
assert.equal(oldBackup.sha256, digest(original))
await writeFile(join(root, 'leftover.json'), JSON.stringify(before, null, 2))

const fixed = await migrate('fixed-candidate', candidate)
assert.equal(fixed.status, 0)
assert.match(
  fixed.stdout,
  /Migration completed: generation [a-f0-9-]+ is active\./,
)
assert.equal(
  fixed.events.filter((event) => event.outcome === 'error').length,
  0,
)
assert.equal(existsSync(legacy), false)
assert.equal(digest(await readFile(oldBackup.path)), oldBackup.sha256)
const paths = await resolvePublishedAccountStorePaths(legacy)
assert.ok(paths)
await assertPublishedAccountStoreGeneration(paths)
const journal = JSON.parse(await readFile(paths.migrationPath, 'utf8'))
assert.equal(journal.status, 'active')
assert.equal(journal.sourceSha256, digest(original))
const repository = createAccountRepositoryFactory(
  await loadCommonAuthStoreModules(),
)({
  paths,
  now: Date.now,
  exchange: async () => {
    throw new Error('Read-only verification must not exchange credentials')
  },
})
try {
  const view = await repository.read()
  assert.equal(view.status, 'ready')
  assert.equal(view.rows.length, 1)
  const row = view.rows[0]
  assert.equal(row.enabled, true)
  assert.equal(row.usable, true)
  assert.equal(
    row.credential.refreshToken,
    'synthetic-refresh-only-no-real-credential',
  )
  assert.equal(row.metadata.status, 'present')
  assert.equal(row.metadata.metadata.email, 'synthetic@example.invalid')
  assert.equal(
    row.metadata.metadata.managedProjectId,
    'synthetic-managed-project',
  )
  assert.equal(row.metadata.metadata.capturedPaidTierId, 'synthetic-paid-tier')
  assert.equal(row.quota.status, 'present')
  assert.equal(
    row.quota.quota.cachedQuota['gemini-flash'].remainingFraction,
    0.75,
  )
  assert.equal(row.quota.quota.cachedQuotaUpdatedAt, 1700000000000)
} finally {
  await repository.dispose()
}
const pointerBefore = await readFile(`${legacy}.store.pointer.json`)
const replay = await migrate('completed-replay', candidate)
assert.equal(replay.status, 0)
assert.equal(
  digest(await readFile(`${legacy}.store.pointer.json`)),
  digest(pointerBefore),
)
assert.equal(digest(await readFile(oldBackup.path)), oldBackup.sha256)
const generations = (await readdir(config)).filter((name) =>
  name.endsWith('.generation'),
)
assert.equal(generations.length, 2)
await writeFile(
  join(root, 'result.json'),
  JSON.stringify(
    {
      node: process.version,
      baselineSource: 'f39bc1ba7201d5ac52d69b3f970d9905829d55f9',
      candidateCoreHash: digest(
        await readFile(resolve('packages/core/dist/account-migration.js')),
      ),
      candidateCliHash: digest(await readFile(candidate)),
      oldBackupPreserved: true,
      activeGeneration: journal.id,
      generations,
      accountEquivalence: true,
      replaySamePointer: true,
      attempts,
    },
    null,
    2,
  ),
)
console.log('WINDOWS_MIGRATION_LEFTOVER_REPLAY_OK')
