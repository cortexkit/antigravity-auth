import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getUserConfigPath } from '../packages/opencode/src/plugin/config/loader.ts'
import { getOpencodeConfigDir } from '../packages/opencode/src/plugin/config/updater.ts'
import { defaultFilesystemRoots } from '../packages/opencode/src/plugin/dependencies.ts'
import { getConfigDir as getStorageConfigDir } from '../packages/opencode/src/plugin/storage.ts'
import { getRpcDir } from '../packages/opencode/src/rpc/rpc-dir.ts'
import { getSidebarStateFile } from '../packages/opencode/src/sidebar-state.ts'
import { resolveTuiLogPath } from '../packages/opencode/src/tui/file-logger.ts'
import {
  getPiAntigravityAuthFile,
  getPiConfigDir,
} from '../packages/pi/src/paths.ts'
import { runCommand } from './support/run-command.ts'

describe('test environment isolation', () => {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')

  it('exposes ANTIGRAVITY_TEST_ROOT as a temp dir', () => {
    expect(root.startsWith(require('node:os').tmpdir())).toBe(true)
    expect(root).toContain('antigravity-auth-test-')
  })

  it('isolates HOME from the real user home', () => {
    expect(process.env.HOME).toBe(`${root}/home`)
    expect(process.env.USERPROFILE).toBe(`${root}/home`)
  })

  it('isolates XDG dirs from real XDG dirs', () => {
    expect(process.env.XDG_CONFIG_HOME).toBe(`${root}/config`)
    expect(process.env.XDG_CACHE_HOME).toBe(`${root}/cache`)
    expect(process.env.XDG_DATA_HOME).toBe(`${root}/data`)
  })

  it('isolates Windows-style APPDATA/LOCALAPPDATA', () => {
    expect(process.env.APPDATA).toBe(`${root}/config`)
    expect(process.env.LOCALAPPDATA).toBe(`${root}/cache`)
  })

  it('sets OPENCODE_CONFIG_DIR under the test root', () => {
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(`${root}/config/opencode`)
  })

  it('sets PI_AGENT_DIR and PI_ANTIGRAVITY_AUTH_FILE under the test root', () => {
    expect(process.env.PI_AGENT_DIR).toBe(`${root}/pi-agent`)
    expect(process.env.PI_ANTIGRAVITY_AUTH_FILE).toBe(
      `${root}/pi-agent/antigravity-accounts.json`,
    )
  })

  it('pins Pi native credentials separately from the extension directory', () => {
    expect(process.env.PI_CODING_AGENT_DIR).toBe(`${root}/pi-agent`)
  })

  it('pi path helpers return paths under the test root', () => {
    expect(getPiConfigDir().startsWith(root)).toBe(true)
    expect(getPiAntigravityAuthFile().startsWith(root)).toBe(true)
  })

  it('opencode storage config dir resolves under the test root', () => {
    expect(getStorageConfigDir().startsWith(root)).toBe(true)
  })

  it('recovery storage constants resolve under the test root', async () => {
    // constants.ts captures XDG_DATA_HOME at import time. A real XDG_DATA_HOME
    // in the caller env would otherwise pin OPENCODE_STORAGE outside the root.
    const recovery = await import(
      `../packages/opencode/src/plugin/recovery/constants.ts?bust=${Date.now()}`
    )

    expect(recovery.OPENCODE_STORAGE.startsWith(root)).toBe(true)
    expect(recovery.MESSAGE_STORAGE.startsWith(root)).toBe(true)
    expect(recovery.PART_STORAGE.startsWith(root)).toBe(true)
  })
})

/**
 * Guard: every writable-path resolver must resolve inside the test root.
 *
 * Positive checks use the preload's overrides. A fresh child removes those
 * overrides and calls the real resolvers against an owned HOME/XDG tree.
 *
 * If any assertion fails the suite is silently writing to the operator's
 * live state. The error message names the offending resolver and the
 * path it resolved to so the root cause is immediately visible.
 */
describe('state leak guard — every path resolver must stay inside the test root', () => {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  const parent = dirname(root)

  async function probe(mode: 'paths' | 'cache') {
    const owned = mkdtempSync(join(parent, 'antigravity-resolver-control-'))
    const project = join(owned, 'project')
    mkdirSync(project)
    try {
      const result = await runCommand(
        [
          process.execPath,
          fileURLToPath(
            new URL('./support/environment-probe.ts', import.meta.url),
          ),
          mode,
        ],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            HOME: join(owned, 'home'),
            USERPROFILE: join(owned, 'home'),
            XDG_CONFIG_HOME: join(owned, 'config'),
            XDG_STATE_HOME: join(owned, 'state'),
            XDG_DATA_HOME: join(owned, 'data'),
            XDG_CACHE_HOME: join(owned, 'cache'),
            APPDATA: join(owned, 'config'),
            LOCALAPPDATA: join(owned, 'cache'),
            ANTIGRAVITY_AUTH_DEBUG: '0',
          },
          deadlineMs: 4_000,
        },
      )
      expect(result.exitCode, result.stderr).toBe(0)
      const output = JSON.parse(
        result.stdout.trim().split('\n').at(-1) as string,
      )
      return { owned, project, output }
    } finally {
      rmSync(owned, { recursive: true, force: true })
    }
  }

  // ── Sidebar state ─────────────────────────────────────────────────────────

  it('getSidebarStateFile() resolves under the test root', () => {
    const resolved = getSidebarStateFile()
    expect(
      resolved.startsWith(root),
      `getSidebarStateFile() resolved OUTSIDE test root: ${resolved}\n` +
        "The suite would corrupt the operator's live sidebar state file. " +
        'Check that ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE is pinned in test/setup.ts.',
    ).toBe(true)
  })

  it('real production resolvers use the owned HOME/XDG tree without test overrides', async () => {
    const { owned, project, output } = await probe('paths')
    const state = join(owned, 'state', 'cortexkit', 'antigravity-auth')
    const config = join(owned, 'config', 'opencode')
    const hash = createHash('sha256').update(project).digest('hex').slice(0, 16)
    expect(output).toEqual({
      sidebar: join(state, 'sidebar-state.json'),
      rpc: join(state, 'rpc', hash),
      roots: {
        projectRoot: project,
        userConfigRoot: config,
        sidebarStateRoot: state,
        rpcRoot: join(state, 'rpc'),
      },
      log: join(state, 'tui.log'),
      config: join(config, 'antigravity.json'),
      updater: config,
      storage: config,
      userConfig: join(config, 'opencode.json'),
    })
    expect(JSON.stringify(output)).not.toContain(root)
  })

  // ── RPC dir ───────────────────────────────────────────────────────────────

  it('getRpcDir() resolves under the test root', () => {
    // Use an arbitrary project directory; what matters is that the root dir
    // is isolated, not the per-project hash suffix.
    const resolved = getRpcDir('/some/project')
    expect(
      resolved.startsWith(root),
      `getRpcDir() resolved OUTSIDE test root: ${resolved}\n` +
        "The suite would write port files into the operator's real state dir " +
        '(2119 leaked project dirs observed). Check that ANTIGRAVITY_AUTH_RPC_DIR ' +
        'is pinned in test/setup.ts.',
    ).toBe(true)
  })

  // ── defaultFilesystemRoots() — same XDG_STATE_HOME gap ───────────────────

  it('defaultFilesystemRoots() sidebarStateRoot resolves under the test root', () => {
    const { sidebarStateRoot } = defaultFilesystemRoots()
    expect(
      sidebarStateRoot.startsWith(root),
      `defaultFilesystemRoots().sidebarStateRoot resolved OUTSIDE test root: ${sidebarStateRoot}`,
    ).toBe(true)
  })

  it('defaultFilesystemRoots() rpcRoot resolves under the test root', () => {
    const { rpcRoot } = defaultFilesystemRoots()
    expect(
      rpcRoot.startsWith(root),
      `defaultFilesystemRoots().rpcRoot resolved OUTSIDE test root: ${rpcRoot}`,
    ).toBe(true)
  })

  // ── TUI log ───────────────────────────────────────────────────────────────

  it('resolveTuiLogPath() resolves under the test root', () => {
    const resolved = resolveTuiLogPath()
    expect(
      resolved.startsWith(root),
      `resolveTuiLogPath() resolved OUTSIDE test root: ${resolved}\n` +
        'Check that ANTIGRAVITY_AUTH_TUI_LOG_FILE or XDG_STATE_HOME is pinned.',
    ).toBe(true)
  })

  // ── Plugin config (getUserConfigPath, getOpencodeConfigDir) ───────────────

  it('getUserConfigPath() resolves under the test root', () => {
    const resolved = getUserConfigPath()
    expect(
      resolved.startsWith(root),
      `getUserConfigPath() resolved OUTSIDE test root: ${resolved}\n` +
        'Check that OPENCODE_CONFIG_DIR is pinned in test/setup.ts.',
    ).toBe(true)
  })

  it('getOpencodeConfigDir() resolves under the test root', () => {
    // getOpencodeConfigDir() uses XDG_CONFIG_HOME (pinned), not OPENCODE_CONFIG_DIR.
    const resolved = getOpencodeConfigDir()
    expect(
      resolved.startsWith(root),
      `getOpencodeConfigDir() resolved OUTSIDE test root: ${resolved}`,
    ).toBe(true)
  })

  // ── Storage config dir ────────────────────────────────────────────────────

  it('storage getConfigDir() resolves under the test root', () => {
    const resolved = getStorageConfigDir()
    expect(
      resolved.startsWith(root),
      `storage getConfigDir() resolved OUTSIDE test root: ${resolved}`,
    ).toBe(true)
  })

  it('auto-update-checker USER_OPENCODE_CONFIG resolves under the test root', async () => {
    const { USER_OPENCODE_CONFIG } = await import(
      `../packages/opencode/src/hooks/auto-update-checker/constants.ts?bust=${Date.now()}`
    )
    expect(
      (USER_OPENCODE_CONFIG as string).startsWith(root),
      `auto-update-checker USER_OPENCODE_CONFIG resolved OUTSIDE test root: ${USER_OPENCODE_CONFIG as string}`,
    ).toBe(true)
  })

  it('session.created invalidates only the owned updater cache', async () => {
    const { output } = await probe('cache')
    expect(output.requests).toEqual([
      'https://registry.npmjs.org/-/package/@cortexkit/opencode-antigravity-auth/dist-tags',
    ])
    expect(output.toast).toMatchObject({
      body: { message: expect.stringContaining('1.2.6') },
    })
    expect(output.installed).toBe(false)
    expect(output.dependencies).toEqual({ unrelated: '9.9.9' })
    expect(output.config).toBe(
      JSON.stringify({ plugin: ['@cortexkit/opencode-antigravity-auth'] }),
    )
  })
})
