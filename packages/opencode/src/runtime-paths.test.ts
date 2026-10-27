// Where the vault folder lives for a config folder, and how a process that
// never decided its layout follows the marker. Paths only: nothing here
// moves a file.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OPENCODE_VAULT_DIR_NAME } from './plugin/vault-custody'
import { processConfigFolderKey } from './process-heartbeat'
import {
  __resetRuntimeLayoutsForTest,
  configDirIdentity,
  currentRuntimeLayout,
  getVaultDir,
  legacyAccountFile,
  RUNTIME_LAYOUT_MARKER_FILE,
  type RuntimeLayoutLocation,
  runtimeLayoutLocation,
  setRuntimeLayout,
  VAULT_DIR_NAME,
} from './runtime-paths'

const ENV_NAMES = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
] as const
const POSIX = process.platform !== 'win32'

let saved: Record<string, string | undefined>
let count = 0
let root: string

function testRoot(): string {
  const value = process.env.ANTIGRAVITY_TEST_ROOT
  if (!value) throw new Error('test/setup.ts did not pin ANTIGRAVITY_TEST_ROOT')
  return value
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  count++
  root = join(testRoot(), 'runtime-paths', String(count))
  mkdirSync(root, { recursive: true })
  root = realpathSync.native(root)
  process.env.XDG_STATE_HOME = join(root, 'state')
  __resetRuntimeLayoutsForTest()
})

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  __resetRuntimeLayoutsForTest()
})

const stateRoot = () => join(root, 'state', 'cortexkit', 'antigravity-auth')

/**
 * `runtimeLayoutLocation()` computed in a fresh process with this test's
 * environment plus `extra` (an undefined value removes a variable).
 */
async function locationInChild(
  extra: Record<string, string | undefined>,
): Promise<RuntimeLayoutLocation> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name]
  const module = fileURLToPath(new URL('./runtime-paths.ts', import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const m = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(m.runtimeLayoutLocation()))`,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`location child failed: ${stderr}`)
  return JSON.parse(stdout) as RuntimeLayoutLocation
}

describe('where the state-home folder is', () => {
  it('is opencode/ only for <home>/.config/opencode and a keyed folder for every other config folder', async () => {
    const home = join(root, 'home')
    // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, at
    // process start under Bun, so each case runs in its own process. An
    // unset XDG_STATE_HOME puts the state home under the home folder.
    const env = (extra: Record<string, string>) => ({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: undefined,
      OPENCODE_CONFIG_DIR: undefined,
      XDG_STATE_HOME: undefined,
      ...extra,
    })
    const homeState = join(home, '.local', 'state', 'cortexkit')
    const atHome = await locationInChild(env({}))
    expect(atHome.isDefaultConfigDir).toBe(true)
    expect(atHome.stateHomeDir).toBe(
      join(homeState, 'antigravity-auth', 'opencode'),
    )

    const first = await locationInChild(
      env({ XDG_CONFIG_HOME: join(root, 'xdg-a') }),
    )
    const second = await locationInChild(
      env({ XDG_CONFIG_HOME: join(root, 'xdg-b') }),
    )
    for (const other of [first, second]) {
      expect(other.isDefaultConfigDir).toBe(false)
      expect(other.stateHomeDir).toMatch(
        /[\\/]cortexkit[\\/]antigravity-auth[\\/]opencode-[0-9a-f]{16}$/,
      )
    }
    // Two XDG_CONFIG_HOME values never share a folder.
    expect(first.stateHomeDir).not.toBe(second.stateHomeDir)

    // OPENCODE_CONFIG_DIR naming the home config folder is that folder.
    const named = await locationInChild(
      env({ OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode') }),
    )
    expect(named.stateHomeDir).toBe(atHome.stateHomeDir)
  })

  it('names the config folder by its real path without folding case', () => {
    const real = join(root, 'Real-Config')
    mkdirSync(real, { recursive: true })
    const link = join(root, 'link-config')
    symlinkSync(real, link, POSIX ? 'dir' : 'junction')
    process.env.OPENCODE_CONFIG_DIR = link
    const viaLink = runtimeLayoutLocation()
    expect(viaLink.key).toBe(realpathSync.native(real))
    expect(viaLink.key).toContain('Real-Config')
    expect(viaLink.configDir).toBe(link)
    __resetRuntimeLayoutsForTest()
    process.env.OPENCODE_CONFIG_DIR = real
    expect(runtimeLayoutLocation().stateHomeDir).toBe(viaLink.stateHomeDir)
    // A folder that does not exist yet is named by its resolved path.
    __resetRuntimeLayoutsForTest()
    process.env.OPENCODE_CONFIG_DIR = join(root, 'Not-There', '..', 'Not-Here')
    expect(runtimeLayoutLocation().key).toBe(join(root, 'Not-Here'))
  })

  it("the layout key equals the key 3.0.13's heartbeat writes", () => {
    const real = join(root, 'Upper-Case-Config')
    mkdirSync(real, { recursive: true })
    const link = join(root, 'linked')
    symlinkSync(real, link, POSIX ? 'dir' : 'junction')
    const cases = [
      link,
      real,
      join(root, 'Missing', '..', 'Missing-Too'),
      // OPENCODE_CONFIG_DIR is used untrimmed by both.
      `${real}/`,
    ]
    for (const folder of cases) {
      __resetRuntimeLayoutsForTest()
      process.env.OPENCODE_CONFIG_DIR = folder
      expect(runtimeLayoutLocation().key).toBe(processConfigFolderKey())
      expect(configDirIdentity(folder)).toBe(processConfigFolderKey())
    }
  })

  it('two config folders never share a state-home folder', () => {
    process.env.OPENCODE_CONFIG_DIR = join(root, 'first-config')
    const first = runtimeLayoutLocation()
    process.env.OPENCODE_CONFIG_DIR = join(root, 'second-config')
    const second = runtimeLayoutLocation()
    expect(first.stateHomeDir).not.toBe(second.stateHomeDir)
    expect(first.stateHomeDir.startsWith(stateRoot())).toBe(true)
    expect(second.stateHomeDir.startsWith(stateRoot())).toBe(true)
  })

  it('keeps a decided location fixed even when the folder later becomes a link', () => {
    const config = join(root, 'config-a')
    process.env.OPENCODE_CONFIG_DIR = config
    const before = runtimeLayoutLocation()
    setRuntimeLayout(before, 'legacy')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, config, POSIX ? 'dir' : 'junction')
    expect(runtimeLayoutLocation()).toBe(before)
  })
})

describe('the vault folder', () => {
  it('has the name the vault custody code uses', () => {
    expect(VAULT_DIR_NAME).toBe(OPENCODE_VAULT_DIR_NAME)
  })

  it('is beside the account file in the legacy layout', () => {
    const config = join(root, 'config')
    process.env.OPENCODE_CONFIG_DIR = config
    if (POSIX)
      expect(legacyAccountFile()).toBe(
        join(config, 'antigravity-accounts.json'),
      )
    expect(currentRuntimeLayout()).toBe('legacy')
    expect(getVaultDir()).toBe(
      join(resolve(legacyAccountFile(), '..'), 'antigravity-auth-vault'),
    )
    const custom = join(root, 'elsewhere', 'antigravity-accounts.json')
    expect(getVaultDir(custom)).toBe(
      join(root, 'elsewhere', 'antigravity-auth-vault'),
    )
  })

  it('a tool that never decided follows the marker alone', () => {
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
    const location = runtimeLayoutLocation()
    expect(getVaultDir()).toBe(join(root, 'config', 'antigravity-auth-vault'))
    mkdirSync(location.stateHomeDir, { recursive: true })
    writeFileSync(
      join(location.stateHomeDir, RUNTIME_LAYOUT_MARKER_FILE),
      '{"version":1}\n',
    )
    expect(currentRuntimeLayout()).toBe('state-home')
    expect(getVaultDir()).toBe(
      join(location.stateHomeDir, 'antigravity-auth-vault'),
    )
  })

  it("a process's own decision wins over the marker", () => {
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
    const location = runtimeLayoutLocation()
    mkdirSync(location.stateHomeDir, { recursive: true })
    writeFileSync(
      join(location.stateHomeDir, RUNTIME_LAYOUT_MARKER_FILE),
      '{"version":1}\n',
    )
    setRuntimeLayout(location, 'legacy')
    expect(getVaultDir()).toBe(join(root, 'config', 'antigravity-auth-vault'))
  })
})
