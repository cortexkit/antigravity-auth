/** @jsxImportSource @opentui/solid */

/**
 * Reviewer-only render harness for the windows rework. Mirrors the
 * pattern used by `tui.test.tsx` (same `testRender` import, same
 * `SidebarStateV1` shape, same `createSidebarController` factory) so the
 * JSX pragma + Solid transform apply through the project's
 * `@opentui/solid/preload` bunfig configuration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/solid'
import {
  DEFAULT_SIDEBAR_STATE,
  SIDEBAR_STATE_ENV,
  SIDEBAR_STATE_VERSION,
  type SidebarStateV1,
} from './sidebar-state'
import {
  createSidebarController,
  QuotaDialogContent,
  SidebarPanel,
} from './tui'
import type { TuiLogger } from './tui/file-logger'
import {
  type AntigravityAuthTuiPrefs,
  DEFAULT_PREFS,
  PLUGIN_KEY,
  TUI_PREFS_FILE_ENV,
} from './tui-preferences'

interface Fixture {
  statePath: string
  prefsPath: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agy-tui-windows-'))
  const statePath = join(root, 'sidebar-state.json')
  const prefsPath = join(root, 'tui-preferences.jsonc')
  process.env[SIDEBAR_STATE_ENV] = statePath
  process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE = join(root, 'tui.log')
  process.env[TUI_PREFS_FILE_ENV] = prefsPath
  return {
    statePath,
    prefsPath,
    cleanup: () => {
      delete process.env[SIDEBAR_STATE_ENV]
      delete process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE
      delete process.env[TUI_PREFS_FILE_ENV]
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const NOOP_LOGGER: TuiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getLogPath: () => undefined,
}

function writeState(state: Partial<SidebarStateV1>): SidebarStateV1 {
  return {
    ...DEFAULT_SIDEBAR_STATE,
    ...state,
    version: SIDEBAR_STATE_VERSION,
  }
}

function writePrefs(
  prefsPath: string,
  overrides: Partial<AntigravityAuthTuiPrefs>,
): AntigravityAuthTuiPrefs {
  const merged: AntigravityAuthTuiPrefs = {
    ...DEFAULT_PREFS,
    ...overrides,
    header: { ...DEFAULT_PREFS.header, ...(overrides.header ?? {}) },
    sections: { ...DEFAULT_PREFS.sections, ...(overrides.sections ?? {}) },
    appearance: {
      ...DEFAULT_PREFS.appearance,
      ...(overrides.appearance ?? {}),
    },
  }
  const root = { [PLUGIN_KEY]: merged }
  mkdirSync(join(prefsPath, '..'), { recursive: true })
  writeFileSync(prefsPath, JSON.stringify(root), 'utf-8')
  return merged
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

function dumpFrame(label: string, frame: string): string {
  const banner = `=== ${label} ===`
  const bar = '='.repeat(banner.length)
  return [`${bar}`, banner, `${bar}`, frame, `${bar}`].join('\n')
}

describe('windows rework — reviewer frames', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('(a) Pro account — 2 pools × 2 windows (7d + 5h) with aligned gutters', async () => {
    const future = Date.now() + 5 * 60 * 1000
    const future2 = Date.now() + 7 * 24 * 60 * 60 * 1000
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Pro Account',
          enabled: true,
          health: 80,
          current: true,
          quota: {
            gemini: {
              remainingPercent: 92,
              resetAt: future2,
              windows: [
                { window: 'weekly', remainingPercent: 92, resetAt: future2 },
                { window: '5h', remainingPercent: 99, resetAt: future },
              ],
            },
            'non-gemini': {
              remainingPercent: 96,
              resetAt: future2,
              windows: [
                { window: 'weekly', remainingPercent: 99, resetAt: future2 },
                { window: '5h', remainingPercent: 96, resetAt: future },
              ],
            },
          },
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const testSetup = await testRender(
      () => <SidebarPanel logger={NOOP_LOGGER} stateFile={fixture.statePath} />,
      { width: 60, height: 24 },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    console.log(`\n${dumpFrame('(a) Pro Account frame', frame)}`)
    expect(frame).toContain('Pro Account')
    expect(frame).toContain('Gm')
    expect(frame).toContain('NG')
    expect(frame).toContain('7d')
    expect(frame).toContain('5h')
    expect(frame).toContain('Gm 7d')
    expect(frame).toContain('Gm 5h')
    expect(frame).toContain('NG 7d')
    expect(frame).toContain('NG 5h')
    testSetup.renderer.destroy()
  })

  it('(b) Free account — 2 pools × 1 window (weekly only, no fake 5h)', async () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Free Account',
          enabled: true,
          health: 80,
          current: true,
          quota: {
            gemini: {
              remainingPercent: 89,
              resetAt: future,
              windows: [
                { window: 'weekly', remainingPercent: 89, resetAt: future },
              ],
            },
            'non-gemini': {
              remainingPercent: 100,
              windows: [
                { window: 'weekly', remainingPercent: 100, resetAt: future },
              ],
            },
          },
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const testSetup = await testRender(
      () => <SidebarPanel logger={NOOP_LOGGER} stateFile={fixture.statePath} />,
      { width: 60, height: 24 },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    console.log(`\n${dumpFrame('(b) Free Account frame', frame)}`)
    expect(frame).toContain('Free Account')
    expect(frame).toContain('Gm')
    expect(frame).toContain('NG')
    expect(frame).toContain('Gm 7d')
    expect(frame).toContain('NG 7d')
    expect(frame).not.toContain('5h')
    expect(frame).not.toContain('Gm 5h')
    expect(frame).not.toContain('NG 5h')
    testSetup.renderer.destroy()
  })

  it('(c) Collapsed row — pool + binding-window label + used%', async () => {
    const future = Date.now() + 5 * 60 * 1000
    const future2 = Date.now() + 7 * 24 * 60 * 60 * 1000
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Pro Account',
          enabled: true,
          health: 80,
          current: true,
          quota: {
            gemini: {
              remainingPercent: 92,
              resetAt: future2,
              windows: [
                { window: 'weekly', remainingPercent: 92, resetAt: future2 },
                { window: '5h', remainingPercent: 99, resetAt: future },
              ],
            },
            'non-gemini': {
              remainingPercent: 96,
              resetAt: future2,
              windows: [
                { window: 'weekly', remainingPercent: 99, resetAt: future2 },
                { window: '5h', remainingPercent: 96, resetAt: future },
              ],
            },
          },
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const prefs = writePrefs(fixture.prefsPath, {
      collapsed: true,
      rememberCollapsed: true,
    })
    const controller = createSidebarController(prefs)

    const testSetup = await testRender(
      () => (
        <SidebarPanel
          controller={controller}
          logger={NOOP_LOGGER}
          stateFile={fixture.statePath}
        />
      ),
      { width: 80, height: 12 },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    console.log(`\n${dumpFrame('(c) Collapsed row frame', frame)}`)
    // Collapsed row should show binding-window label + used% per pool.
    expect(frame).toContain('Gm 7d:')
    expect(frame).toContain('NG')
    expect(frame).toContain('●')
    expect(frame).toContain('8%')
    expect(frame).toContain('4%')
    testSetup.renderer.destroy()
  })

  it('(d) QuotaDialogContent — modal scope, same per-window rows', async () => {
    const future = Date.now() + 5 * 60 * 1000
    const future2 = Date.now() + 7 * 24 * 60 * 60 * 1000
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Pro Account',
          enabled: true,
          health: 80,
          current: true,
          quota: {
            gemini: {
              remainingPercent: 92,
              resetAt: future2,
              windows: [
                { window: 'weekly', remainingPercent: 92, resetAt: future2 },
                { window: '5h', remainingPercent: 99, resetAt: future },
              ],
            },
            'non-gemini': {
              remainingPercent: 96,
              resetAt: future2,
              windows: [
                { window: 'weekly', remainingPercent: 99, resetAt: future2 },
                { window: '5h', remainingPercent: 96, resetAt: future },
              ],
            },
          },
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const controller = createSidebarController(DEFAULT_PREFS)
    const testSetup = await testRender(
      () => (
        <QuotaDialogContent
          api={
            {
              theme: { current: { text: '#e5e7eb', textMuted: '#6b7280' } },
            } as never
          }
          controller={controller}
          sessionId='session-abc'
        />
      ),
      { width: 80, height: 20 },
    )
    await settle()
    const frame = testSetup.captureCharFrame()
    console.log(`\n${dumpFrame('(d) QuotaDialogContent frame', frame)}`)
    expect(frame).toContain('Antigravity Quota')
    expect(frame).toContain('Pro Account')
    expect(frame).toContain('Gm 7d')
    expect(frame).toContain('Gm 5h')
    expect(frame).toContain('NG 7d')
    expect(frame).toContain('NG 5h')
    testSetup.renderer.destroy()
  })
})
