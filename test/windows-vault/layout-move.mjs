// Windows only: the one-time move of the vault files out of OpenCode's config
// folder into the plugin's state-home folder, against the bundled product.
//
// 1. An enrollment approved through the real enrollment manager and token
//    writer, in the config folder where versions before the move keep it.
// 2. The real move (`prepareRuntimeLayout`), with no other process running.
// 3. The moved token's folder passes `@cortexkit/private-files`
//    `verifyPrivatePath(dir, 'directory')`, the check the enrollment token
//    writer runs on a token's folder before it rewrites the token; the moved
//    token keeps a protected owner-only DACL, and the vault library reads it
//    (its reader checks the DACL too) as the same token, so the host stays
//    approved without enrolling again.
// 4. Control: in a second config folder whose state-home vault folder already
//    exists as a plain `mkdir` (an inherited, not owner-only DACL), the move
//    is not made and the files stay in the config folder.
//
// Usage: node --experimental-import-meta-resolve test/windows-vault/layout-move.mjs ROOT
// ROOT must be a fresh folder below the real user profile; it is removed at
// the end. The check fails on any other platform: it proves nothing there.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPrivateTokenDacl, readTokenDacl } from './dacl.mjs'

assert.equal(
  process.platform,
  'win32',
  'The vault layout move check runs only on Windows',
)
const root = resolve(process.argv[2])
const parent = resolve(process.env.USERPROFILE)
const rel = relative(parent, root)
assert.ok(
  rel && !rel.startsWith('..') && !isAbsolute(rel),
  'ROOT must be below the real user profile',
)

const profile = join(root, 'profile')
const TOKEN = 'opencode-enrollment.json'
const STATE = 'opencode-enrollment-state.json'
const stages = []
let stage = 'setup'
const check = async (name, run) => {
  stage = name
  await run()
  stages.push(name)
}

/** Enrollment that a stand-in vault approves at once; counts its proposals. */
function approvingVault() {
  const calls = []
  return {
    calls,
    connectEnrollment: async () => ({
      enrollPropose: async () => {
        calls.push('propose')
        return { requestId: 'layout-move-request' }
      },
      enrollPoll: async () => {
        calls.push('poll')
        return {
          status: 'approved',
          name: 'antigravity-auth-opencode',
          token: 'ab'.repeat(32),
          tokenGeneration: 1,
        }
      },
      close() {},
    }),
  }
}

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
    ANTIGRAVITY_AUTH_RPC_DIR: join(profile, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(profile, 'sidebar.json'),
  })
  const product = await import(
    '../../packages/opencode/dist/windows-vault-product.mjs'
  )
  const core = await import('../../packages/core/dist/index.js')
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href
  const { verifyPrivatePath } = await import(
    import.meta.resolve('@cortexkit/private-files', coreUrl)
  )
  const { version } = JSON.parse(
    await readFile(resolve('packages/opencode/package.json'), 'utf8'),
  )
  const quiet = { info() {}, warn() {} }
  const claustrum = await core.loadCommonAuthClaustrum()

  /** Enrolls in the config folder, as a version before the move does. */
  const enrollInConfigFolder = async (config) => {
    await mkdir(config, { recursive: true, mode: 0o700 })
    const vault = approvingVault()
    const custody = product.createOpenCodeVaultCustody({
      vaultDir: join(config, 'antigravity-auth-vault'),
      accountFile: join(config, 'antigravity-accounts.json'),
      reporterSource: 'direct',
      readHostSlot: async () => undefined,
      connectEnrollment: vault.connectEnrollment,
    })
    try {
      assert.equal((await custody.requestAccess()).state, 'approved')
      await custody.useVault()
    } finally {
      await custody.dispose()
    }
    return join(config, 'antigravity-auth-vault')
  }

  const config = join(profile, 'config', 'opencode')
  process.env.OPENCODE_CONFIG_DIR = config
  let legacy
  let moved
  await check('enroll-in-config-folder', async () => {
    legacy = await enrollInConfigFolder(config)
    assert.equal(fs.statSync(join(legacy, TOKEN)).isFile(), true)
  })
  await check('move-to-state-home', async () => {
    const layout = await product.prepareRuntimeLayout({ version, log: quiet })
    assert.equal(layout, 'state-home')
    moved = join(
      product.runtimeLayoutLocation().stateHomeDir,
      'antigravity-auth-vault',
    )
    assert.equal(product.getVaultDir(), moved)
    assert.equal(fs.existsSync(join(legacy, TOKEN)), false)
    // An approved enrollment leaves its state behind for older versions.
    assert.equal(fs.existsSync(join(legacy, STATE)), true)
  })
  await check('moved-token-folder-passes-private-path-check', async () => {
    await verifyPrivatePath(moved, 'directory')
  })
  await check('moved-token-owner-only-DACL', async () => {
    assertPrivateTokenDacl(readTokenDacl(join(moved, TOKEN)))
    const token = await claustrum.readClaustrumEnrollmentToken(
      join(moved, TOKEN),
    )
    assert.equal(token.token_generation, 1)
  })
  await check('moved-enrollment-stays-approved-without-proposal', async () => {
    const vault = approvingVault()
    const custody = product.createOpenCodeVaultCustody({
      vaultDir: moved,
      accountFile: join(config, 'antigravity-accounts.json'),
      reporterSource: 'direct',
      readHostSlot: async () => undefined,
      connectEnrollment: vault.connectEnrollment,
    })
    try {
      assert.equal((await custody.status()).enrollment.state, 'approved')
      assert.equal((await custody.readMode()).record?.mode, 'custody')
      assert.equal((await custody.requestAccess()).state, 'approved')
      assert.deepEqual(vault.calls, [])
    } finally {
      await custody.dispose()
    }
  })

  await check('non-private-destination-keeps-config-folder', async () => {
    const other = join(profile, 'config', 'other-opencode')
    process.env.OPENCODE_CONFIG_DIR = other
    const otherLegacy = await enrollInConfigFolder(other)
    const before = fs.readFileSync(join(otherLegacy, TOKEN))
    const destination = join(
      product.runtimeLayoutLocation().stateHomeDir,
      'antigravity-auth-vault',
    )
    // A plain folder inherits its parent's DACL: not owner-only.
    fs.mkdirSync(destination, { recursive: true })
    await assert.rejects(
      verifyPrivatePath(destination, 'directory'),
      'the control folder must fail the private-path check',
    )
    const layout = await product.prepareRuntimeLayout({ version, log: quiet })
    assert.equal(layout, 'legacy')
    assert.deepEqual(fs.readFileSync(join(otherLegacy, TOKEN)), before)
    assert.equal(fs.existsSync(join(destination, TOKEN)), false)
  })
  console.log(`Windows vault layout move: passed; ${stages.length} stages`)
} catch (error) {
  console.error(`Windows vault layout move failed at ${stage}`)
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
