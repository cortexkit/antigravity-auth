// Exercise the bundled CLI, not a source-only relocation factory. All account
// data is synthetic; on success the receipt records equality without rows.
// An assertion failure may include synthetic fixture data in its error.
// Usage: node --experimental-import-meta-resolve relocate.mjs ROOT EVIDENCE CLI
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'Store relocation proof needs Windows')
assert.equal(process.argv.length, 5, 'Expected ROOT EVIDENCE CLI')
const root = resolve(process.argv[2])
const evidence = resolve(process.argv[3])
const cli = resolve(process.argv[4])
const withinProfile = relative(resolve(process.env.USERPROFILE), root)
assert.ok(
  withinProfile &&
    !withinProfile.startsWith('..') &&
    !isAbsolute(withinProfile),
  'ROOT must be a fresh folder below the real user profile',
)

const profile = join(root, 'profile')
const config = join(profile, 'config', 'opencode')
const anchor = join(config, 'antigravity-accounts.json')
const pointer = `${anchor}.store.pointer.json`
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const result = { node: process.version, stages: [], attempts: [] }
let stage = 'setup'
const check = async (name, run) => {
  stage = name
  await run()
  result.stages.push(name)
}
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))

async function command(label, args) {
  const attempt = spawnSync(process.execPath, [cli, ...args], {
    cwd: profile,
    env: process.env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  })
  await writeFile(join(evidence, `${label}.stdout`), attempt.stdout ?? '')
  await writeFile(join(evidence, `${label}.stderr`), attempt.stderr ?? '')
  result.attempts.push({
    label,
    status: attempt.status,
    signal: attempt.signal,
    error: attempt.error?.message,
  })
  assert.equal(attempt.error, undefined, `${label} did not run`)
  assert.equal(attempt.signal, null, `${label} was interrupted`)
  assert.equal(attempt.status, 0, `${label} failed: ${attempt.stderr}`)
  return attempt
}

await mkdir(evidence, { recursive: true })
try {
  await mkdir(root, { mode: 0o700 })
  Object.assign(process.env, {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: join(profile, 'roaming'),
    LOCALAPPDATA: join(profile, 'local'),
    XDG_CONFIG_HOME: join(profile, 'config'),
    XDG_DATA_HOME: join(profile, 'data'),
    XDG_CACHE_HOME: join(profile, 'cache'),
    XDG_STATE_HOME: join(profile, 'state'),
    OPENCODE_CONFIG_DIR: config,
    ANTIGRAVITY_AUTH_RPC_DIR: join(profile, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(profile, 'sidebar.json'),
  })
  const core = await import('../../packages/core/dist/index.js')
  const product = await import(
    '../../packages/opencode/dist/windows-vault-product.mjs'
  )
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href
  const { verifyPrivatePath } = await import(
    import.meta.resolve('@cortexkit/private-files', coreUrl)
  )
  const modules = await core.loadCommonAuthStoreModules()
  const stateAnchor = join(
    product.runtimeLayoutLocation().stateHomeDir,
    'antigravity-accounts.json',
  )
  result.cliSha256 = digest(await readFile(cli))

  const repository = (paths) =>
    core.createAccountRepositoryFactory(modules)({
      paths,
      now: Date.now,
      exchange: async () => ({
        accessToken: 'synthetic-relocate-access',
        refreshToken: 'synthetic-relocate-rotated-refresh',
        expiresAt: Date.now() + 3_600_000,
        identity: 'synthetic-relocate-identity',
      }),
    })
  const readRows = async (path) => {
    const binding = await core.readAccountStoreBinding(path, modules, Date.now)
    assert.equal(binding.status, 'bound')
    const repo = repository(binding.paths)
    try {
      const view = await repo.read()
      assert.equal(view.status, 'ready')
      return { paths: binding.paths, rows: view.rows }
    } finally {
      await repo.dispose()
    }
  }

  let originalPointer
  let before
  await check('seed-config-anchor-store', async () => {
    await mkdir(config, { recursive: true, mode: 0o700 })
    const initialized = await core.initializeFreshAccountStore(modules, {
      legacyPath: anchor,
      now: Date.now,
    })
    assert.equal(initialized.status, 'completed')
    const binding = await core.readAccountStoreBinding(
      anchor,
      modules,
      Date.now,
    )
    assert.equal(binding.status, 'bound')
    const repo = repository(binding.paths)
    try {
      const first = await repo.login({
        id: randomUUID(),
        refreshToken: 'synthetic-relocate-refresh-one',
        identity: 'synthetic-relocate-identity',
        metadata: { addedAt: 1000, lastUsed: 0, email: 'one@example.invalid' },
      })
      const refreshed = await repo.refresh(first.ref)
      assert.equal(refreshed.status, 'rotated')
      await repo.recordQuota(refreshed.ref, {
        schemaVersion: 1,
        cachedQuotaUpdatedAt: 1700000000000,
        cachedQuota: { claude: { remainingFraction: 0.25, modelCount: 1 } },
      })
      await repo.login({
        id: randomUUID(),
        refreshToken: 'synthetic-relocate-refresh-two',
        metadata: { addedAt: 2000, lastUsed: 0, email: 'two@example.invalid' },
      })
    } finally {
      await repo.dispose()
    }
    originalPointer = await json(pointer)
    assert.equal(originalPointer.schemaVersion, 1)
    before = await readRows(anchor)
    assert.equal(before.rows.length, 2)
    assert.equal(existsSync(`${stateAnchor}.store.pointer.json`), false)
    result.originalGeneration = originalPointer.id
  })

  let moved
  await check('relocate-to-state-home', async () => {
    await command('relocate', ['store', 'relocate', '--offline', '--yes'])
    const forward = await json(pointer)
    const published = await json(`${stateAnchor}.store.pointer.json`)
    assert.deepEqual(forward, {
      schemaVersion: 2,
      id: originalPointer.id,
      directoryBasename: originalPointer.directoryBasename,
      relocatedTo: { legacyPath: stateAnchor, id: published.id },
    })
    assert.equal(published.schemaVersion, 1)
    assert.notEqual(published.id, originalPointer.id)
    moved = await readRows(stateAnchor)
    assert.equal(
      moved.paths.storeDir,
      join(dirname(stateAnchor), published.directoryBasename),
    )
    assert.equal(existsSync(before.paths.storeDir), true)
    assert.equal(existsSync(anchor), false)
    assert.equal(existsSync(stateAnchor), false)
    const journal = await json(moved.paths.migrationPath)
    assert.equal(journal.status, 'active')
    assert.equal(journal.sourceKind, 'generation')
    result.movedGeneration = published.id
    result.configPointerForwards = true
  })
  await check('moved-store-passes-private-path-check', async () => {
    await verifyPrivatePath(moved.paths.storeDir, 'directory')
    await verifyPrivatePath(moved.paths.configPath, 'file')
    await verifyPrivatePath(moved.paths.statePath, 'file')
    result.privatePath = true
  })
  await check('moved-accounts-equal-seeded-accounts', async () => {
    assert.deepEqual(moved.rows, before.rows)
    const throughForward = await readRows(anchor)
    assert.equal(throughForward.paths.storeDir, moved.paths.storeDir)
    assert.deepEqual(throughForward.rows, before.rows)
    result.accountEquivalence = true
  })
  await check('back-help-warns-about-overwrite', async () => {
    const help = await command('back-help', [
      'store',
      'relocate',
      '--back',
      '--help',
    ])
    assert.match(
      help.stdout.replace(/\s+/g, ' '),
      /Going back replaces the old pre-move backup with your current accounts/,
    )
  })
  let current
  await check('add-account-after-move', async () => {
    const repo = repository(moved.paths)
    try {
      await repo.login({
        id: randomUUID(),
        refreshToken: 'synthetic-relocate-refresh-after-move',
        metadata: { addedAt: 3000, lastUsed: 0, email: 'new@example.invalid' },
      })
    } finally {
      await repo.dispose()
    }
    current = await readRows(stateAnchor)
    assert.equal(current.rows.length, 3)
  })
  await check('relocate-back-restores-original-pointer-and-store', async () => {
    await command('relocate-back', [
      'store',
      'relocate',
      '--back',
      '--offline',
      '--yes',
    ])
    assert.deepEqual(await json(pointer), originalPointer)
    const restored = await readRows(anchor)
    assert.equal(restored.paths.storeDir, before.paths.storeDir)
    assert.deepEqual(restored.rows, current.rows)
    const throughState = await readRows(stateAnchor)
    assert.equal(throughState.paths.storeDir, restored.paths.storeDir)
    assert.deepEqual(throughState.rows, current.rows)
    result.originalPointerRestored = true
    result.restoredAccountEquivalence = true
    result.accountCount = restored.rows.length
  })
  result.outcome = 'passed'
  console.log(
    `Windows account-store relocation: passed; ${result.stages.length} stages`,
  )
} catch (error) {
  result.outcome = 'failed'
  result.failedStage = stage
  result.error = error instanceof Error ? error.stack : String(error)
  console.error(`Windows account-store relocation failed at ${stage}`)
  console.error(result.error)
  process.exitCode = 1
} finally {
  await writeFile(
    join(evidence, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  )
}
