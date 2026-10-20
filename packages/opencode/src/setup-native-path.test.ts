import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCommonAuthClaustrum,
  loadCommonAuthPiSlot,
} from '@cortexkit/antigravity-auth-core'
import { runCommand } from '../../../test/support/run-command.ts'

import type {
  OAuthLoginDependencies,
  OAuthLoginRequest,
} from './plugin/oauth-login'

const login = {
  type: 'success' as const,
  refresh: 'synthetic-native-setup-refresh',
  access: 'synthetic-native-setup-access',
  expires: 123,
  projectId: 'synthetic-project',
}
// Replace only the remote OAuth ceremony; the CLI's actual upsert persists the result.
const ceremony = mock(
  async (_request: OAuthLoginRequest, deps: OAuthLoginDependencies) => {
    await deps.upsert(login)
    return login
  },
)
mock.module('./plugin/oauth-login', () => ({ performOAuthLogin: ceremony }))
const { createDefaultCliDependencies, runCli } = await import('./cli.ts')
const { createSetupPlugin } = await import('./setup.ts')
const { runSetup } = await import('./common-auth-embedded/setup/index.js')
const piWorkspace = fileURLToPath(new URL('../../pi/', import.meta.url))
const node = Bun.which('node')
if (!node)
  throw new Error('Node is required for the genuine Pi SDK comparison.')
const originalEnv = { ...process.env }
const roots: string[] = []
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  ceremony.mockClear()
})

function profile(tilde: boolean) {
  const root = realpathSync(
    mkdtempSync(
      join(
        process.platform === 'win32' ? tmpdir() : '/tmp',
        'setup-native-pi-',
      ),
    ),
  )
  roots.push(root)
  const home = join(root, 'home')
  const native = join(home, 'native-pi')
  const extension = join(root, 'extension-decoy')
  const bin = join(root, 'bin')
  for (const path of [native, extension, bin])
    mkdirSync(path, { recursive: true, mode: 0o700 })
  for (const name of ['pi', 'ck']) {
    writeFileSync(
      join(bin, process.platform === 'win32' ? `${name}.cmd` : name),
      process.platform === 'win32'
        ? '@echo off\r\necho 1.0.0\r\n'
        : '#!/bin/sh\necho 1.0.0\n',
      { mode: 0o700 },
    )
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
    OPENCODE_DB: join(root, 'isolated.db'),
    PI_AGENT_DIR: extension,
    PI_CODING_AGENT_DIR: tilde ? '~/native-pi' : native,
    PI_ANTIGRAVITY_AUTH_FILE: join(extension, 'antigravity-accounts.json'),
    SUBC_CONNECTION_FILE: join(root, 'connection.json'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'connection.json'),
    PATH: `${bin}${delimiter}${process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin'}`,
  }
  Object.assign(process.env, env)
  const nativeAuth = join(native, 'auth.json')
  const decoyAuth = join(extension, 'auth.json')
  for (const [path, refresh] of [
    [nativeAuth, 'synthetic-native-before'],
    [decoyAuth, 'synthetic-decoy-before'],
  ]) {
    writeFileSync(
      path!,
      JSON.stringify({
        google: { type: 'oauth', refresh, access: '', expires: 0 },
      }),
      { mode: 0o600 },
    )
  }
  const decoyBytes = readFileSync(decoyAuth)
  const deps = createDefaultCliDependencies()
  let output = ''
  let errors = ''
  deps.stdout = {
    write: (value) => {
      output += value
    },
  }
  deps.stderr = {
    write: (value) => {
      errors += value
    },
  }
  deps.setupIO = {
    env,
    home,
    platform: process.platform,
    terminal: {
      input: {
        isTTY: false,
        setRawMode() {},
        resume() {},
        pause() {},
        on() {},
        removeListener() {},
      },
      output: { write() {} },
    },
  }
  return {
    root,
    native,
    extension,
    nativeAuth,
    decoyAuth,
    decoyBytes,
    deps,
    env,
    output: () => output,
    errors: () => errors,
  }
}

describe('Pi native path', () => {
  it.each([
    'absolute',
    'tilde',
  ] as const)('shared detection matches the genuine installed Pi SDK (path=%s)', async (pathKind) => {
    const p = profile(pathKind === 'tilde')
    // Start with the owned HOME before importing the public SDK: Bun's current
    // process can retain its startup OS home after a test changes process.env.
    // The Node probe fails at its own deadline, before this test's timeout.
    const ran = await runCommand(
      [
        node,
        '--input-type=module',
        '--eval',
        "import { getAgentDir } from '@earendil-works/pi-coding-agent'; process.stdout.write(JSON.stringify(getAgentDir()))",
      ],
      { cwd: piWorkspace, env: p.env, deadlineMs: 5_000 },
    )
    // Keep the node-style fields the assertions read; a spawn failure now throws.
    const sdk = {
      ...ran,
      status: ran.exitCode,
      error: undefined as Error | undefined,
    }
    expect(sdk.error).toBeUndefined()
    expect(sdk.status).toBe(0)
    const sdkDirectory = JSON.parse(sdk.stdout)
    const plugin = await createSetupPlugin(p.deps, async () => 0)
    plugin.beforeSignIn = async (_host, context) => {
      expect(context.piAgentDir).toBe(sdkDirectory)
      expect(context.piAgentDir).toBe(p.native)
      throw new Error('detection captured')
    }
    await expect(
      runSetup(plugin, ['--yes', '--no-claustrum'], p.deps.setupIO),
    ).rejects.toThrow('detection captured')
    expect(ceremony).not.toHaveBeenCalled()
  }, 15_000)

  it.each([
    'absolute',
    'tilde',
  ] as const)('CLI OAuth writes the detected native file and preserves the extension decoy (path=%s)', async (pathKind) => {
    const p = profile(pathKind === 'tilde')
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=2', '--login'],
        p.deps,
      ),
    ).toBe(0)
    expect(ceremony).toHaveBeenCalledTimes(1)
    expect({
      nativeRefresh: JSON.parse(readFileSync(p.nativeAuth, 'utf8')).google
        .refresh,
      decoyBytes: readFileSync(p.decoyAuth),
    }).toEqual({ nativeRefresh: login.refresh, decoyBytes: p.decoyBytes })
    expect(existsSync(join(p.extension, 'auth.json.lock'))).toBe(false)
  })

  it.each([
    'absolute',
    'tilde',
  ] as const)('CLI rejects native custody before OAuth even when the extension decoy has a login (path=%s)', async (pathKind) => {
    const p = profile(pathKind === 'tilde')
    const { openPiSlot } = await loadCommonAuthPiSlot()
    await openPiSlot({
      authPath: p.nativeAuth,
      stashPath: join(
        p.extension,
        'antigravity-auth-vault',
        'google-login-stash.json',
      ),
      provider: 'google',
      placeholderKey: 'antigravity-vault-custody',
    }).enterVault()
    const nativeBytes = readFileSync(p.nativeAuth)
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=2', '--login'],
        p.deps,
      ),
    ).toBe(1)
    expect(p.errors()).toContain('vault marker')
    expect(ceremony).not.toHaveBeenCalled()
    expect(readFileSync(p.nativeAuth)).toEqual(nativeBytes)
    expect(readFileSync(p.decoyAuth)).toEqual(p.decoyBytes)
  })

  it('default CLI refuses Pi login without detected context before OAuth or file writes', async () => {
    const p = profile(false)
    const nativeBytes = readFileSync(p.nativeAuth)
    await expect(
      p.deps.performLogin(
        { noBrowser: true, isHeadless: true, accounts: [], startFresh: false },
        p.deps.openBrowser,
        'pi',
      ),
    ).rejects.toThrow('detected native agent directory')
    expect(ceremony).not.toHaveBeenCalled()
    expect(readFileSync(p.nativeAuth)).toEqual(nativeBytes)
    expect(readFileSync(p.decoyAuth)).toEqual(p.decoyBytes)
  })

  it('vault activation moves only the detected native login into the unchanged extension stash location', async () => {
    const p = profile(false)
    const plugin = await createSetupPlugin(p.deps, async () => 0)
    const host = plugin.vault.hosts.pi
    expect(host.paths.stateDir).toBe(
      join(p.extension, 'antigravity-auth-vault'),
    )
    const nativeBefore = JSON.parse(readFileSync(p.nativeAuth, 'utf8')).google
    const claustrum = await loadCommonAuthClaustrum()
    const manager = new claustrum.ClaustrumEnrollmentManager({
      paths: claustrum.hostEnrollmentPaths(host.paths),
      proposedName: host.name,
      client: {
        enrollPropose: async () => ({ requestId: 'synthetic-native-request' }),
        enrollPoll: async () => ({
          status: 'approved' as const,
          name: host.name,
          token: 'ab'.repeat(32),
          tokenGeneration: 1,
        }),
      },
    })
    expect((await manager.reconcile()).state).toBe('approved')
    await plugin.beforeRegister?.('pi', 'claustrum', {
      hosts: ['pi'],
      opencodeGeneration: '1',
      mode: 'claustrum',
      piAgentDir: p.native,
    })
    const { openPiSlot } = await loadCommonAuthPiSlot()
    const slot = openPiSlot({
      authPath: p.nativeAuth,
      stashPath: join(
        p.extension,
        'antigravity-auth-vault',
        'google-login-stash.json',
      ),
      provider: 'google',
      placeholderKey: 'antigravity-vault-custody',
    })
    expect(await slot.inspect()).toEqual({
      slot: 'placeholder',
      stash: 'valid',
    })
    expect(readFileSync(p.decoyAuth)).toEqual(p.decoyBytes)
    expect(await slot.exitVault()).toBe('restored')
    expect(JSON.parse(readFileSync(p.nativeAuth, 'utf8')).google).toEqual(
      nativeBefore,
    )
    expect(readFileSync(p.decoyAuth)).toEqual(p.decoyBytes)
  })
})
