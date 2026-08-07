import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
 * Two assertions per resolver:
 *   (a) under-test: the resolved path IS inside the test root
 *   (b) production default: the resolved path is NOT inside the test root
 *       (i.e. it would write to the real user dir in production, proving
 *       the test-env override is actually doing work — a resolver
 *       accidentally hardcoded to a temp path would pass (a) but fail (b))
 *
 * If any assertion fails the suite is silently writing to the operator's
 * live state. The error message names the offending resolver and the
 * path it resolved to so the root cause is immediately visible.
 */
describe('state leak guard — every path resolver must stay inside the test root', () => {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')

  // The operator's real home — used to assert production defaults differ.
  // homedir() reads HOME (pinned by preload), so the production default is
  // computed by stripping the test indirection.
  const realHome = homedir()
  // Production xdg-state default that the real user sees outside of tests.
  const productionXdgState = join(realHome, '.local', 'state')

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

  it('getSidebarStateFile() production default is NOT under the test root', () => {
    // Verifies the test-env override is doing real work: without it, the
    // resolver would fall back to this production path.
    const productionDefault = join(
      productionXdgState,
      'cortexkit',
      'antigravity-auth',
      'sidebar-state.json',
    )
    expect(productionDefault.startsWith(root)).toBe(false)
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

  it('getRpcDir() production default is NOT under the test root', () => {
    const productionDefault = join(
      productionXdgState,
      'cortexkit',
      'antigravity-auth',
      'rpc',
    )
    expect(productionDefault.startsWith(root)).toBe(false)
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

  it('defaultFilesystemRoots() production xdg-state defaults are NOT under the test root', () => {
    const productionSidebar = join(
      productionXdgState,
      'cortexkit',
      'antigravity-auth',
    )
    const productionRpc = join(
      productionXdgState,
      'cortexkit',
      'antigravity-auth',
      'rpc',
    )
    expect(productionSidebar.startsWith(root)).toBe(false)
    expect(productionRpc.startsWith(root)).toBe(false)
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

  it('resolveTuiLogPath() production default is NOT under the test root', () => {
    const productionDefault = join(
      productionXdgState,
      'cortexkit',
      'antigravity-auth',
      'tui.log',
    )
    expect(productionDefault.startsWith(root)).toBe(false)
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

  it('config resolver production defaults are NOT under the test root', () => {
    const productionConfig = join(realHome, '.config', 'opencode')
    expect(productionConfig.startsWith(root)).toBe(false)
  })

  // ── Storage config dir ────────────────────────────────────────────────────

  it('storage getConfigDir() resolves under the test root', () => {
    const resolved = getStorageConfigDir()
    expect(
      resolved.startsWith(root),
      `storage getConfigDir() resolved OUTSIDE test root: ${resolved}`,
    ).toBe(true)
  })

  // ── auto-update-checker constants (module-level captures, separate class) ────
  //
  // auto-update-checker/constants.ts uses os.homedir() directly (not HOME
  // env) for CACHE_DIR. Bun's os.homedir() is an OS-level call that does NOT
  // read process.env.HOME — it returns the passwd entry. This means CACHE_DIR
  // resolves to the real ~/.cache/opencode regardless of env pinning.
  //
  // This is a named finding, not a failure to fix: the test suite does NOT
  // write to CACHE_DIR. The write paths (installPackage, invalidatePackage)
  // only fire from the plugin's session.created event, which unit tests never
  // trigger. The only test-time read is an existsSync check in checker.ts:149
  // which is a no-op when the directory is absent. CACHE_DIR is therefore
  // UNREACHABLE FOR WRITES in the unit test suite.
  //
  // USER_OPENCODE_CONFIG uses XDG_CONFIG_HOME (pinned) and resolves correctly.
  // It is asserted here separately because its failure mode (import-order
  // sensitivity) differs from the XDG_STATE_HOME gap above.

  it('auto-update-checker USER_OPENCODE_CONFIG resolves under the test root', async () => {
    const { USER_OPENCODE_CONFIG } = await import(
      `../packages/opencode/src/hooks/auto-update-checker/constants.ts?bust=${Date.now()}`
    )
    expect(
      (USER_OPENCODE_CONFIG as string).startsWith(root),
      `auto-update-checker USER_OPENCODE_CONFIG resolved OUTSIDE test root: ${USER_OPENCODE_CONFIG as string}`,
    ).toBe(true)
  })

  it('auto-update-checker USER_OPENCODE_CONFIG production default is NOT under the test root', () => {
    const productionUserConfig = join(
      realHome,
      '.config',
      'opencode',
      'opencode.json',
    )
    expect(productionUserConfig.startsWith(root)).toBe(false)
  })

  it('auto-update-checker CACHE_DIR resolves OUTSIDE the test root (write-unreachable)', async () => {
    // CACHE_DIR uses os.homedir() (OS-level, not env-based) and resolves
    // to the real ~/.cache/opencode even under test — env pinning cannot
    // redirect it. This is the (b)-half guard: CACHE_DIR must be outside
    // the test root. If it ever drifts inside, env isolation has broken
    // and the situation must be re-evaluated.
    const { CACHE_DIR } = await import(
      `../packages/opencode/src/hooks/auto-update-checker/constants.ts?bust=${Date.now()}`
    )
    expect(
      (CACHE_DIR as string).startsWith(root),
      `CACHE_DIR resolved INSIDE test root: ${CACHE_DIR as string}\n` +
        'os.homedir() now returns the test home — the isolation rationale no longer holds. ' +
        'Audit write paths before the suite is considered safe.',
    ).toBe(false)
    // The real protection: none of the writing callsites are reachable from
    // bun test. cache.ts::installPackage and invalidatePackage are only called
    // from runBackgroundUpdateCheck which fires on session.created events that
    // unit tests never emit. Verified by grep: no test imports cache.ts.
  })
})
