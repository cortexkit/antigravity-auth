import { describe, expect, it } from 'bun:test'

import { getConfigDir as getStorageConfigDir } from '../packages/opencode/src/plugin/storage.ts'
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
