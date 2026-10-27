/** @jsxImportSource @opentui/solid */

/**
 * Full-frame captures of the OpenCode 1 sidebar at the widths the host
 * sidebar actually has (32, 38 and 48 columns). Each scenario renders with a
 * fixed clock so the reset countdowns and reading ages are deterministic.
 *
 * Every quota window must stay on one line at every width, the window names
 * must be the plain group headers, a reading whose reset time has already
 * passed must not be shown as the current figure, and a session without a
 * route must not render a placeholder row.
 *
 * Set AGY_PRINT_FRAMES=1 to print every captured frame.
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
  type SidebarAccountState,
  type SidebarStateV1,
} from './sidebar-state'
import { createSidebarController, SidebarPanel } from './tui'
import type { TuiLogger } from './tui/file-logger'
import {
  type AntigravityAuthTuiPrefs,
  DEFAULT_PREFS,
  PLUGIN_KEY,
  TUI_PREFS_FILE_ENV,
} from './tui-preferences'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0)
const WIDTHS = [32, 38, 48] as const
const COLLAPSED_WIDTHS = [20, 26, 27, 28, 29, 30, 31, 32, 38, 48] as const

const NOOP_LOGGER: TuiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getLogPath: () => undefined,
}

interface Fixture {
  statePath: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agy-tui-narrow-'))
  const statePath = join(root, 'sidebar-state.json')
  const prefsPath = join(root, 'tui-preferences.jsonc')
  const savedSidebar = process.env[SIDEBAR_STATE_ENV]
  const savedTuiLog = process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE
  const savedPrefs = process.env[TUI_PREFS_FILE_ENV]
  process.env[SIDEBAR_STATE_ENV] = statePath
  process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE = join(root, 'tui.log')
  process.env[TUI_PREFS_FILE_ENV] = prefsPath
  mkdirSync(root, { recursive: true })
  writeFileSync(
    prefsPath,
    JSON.stringify({
      [PLUGIN_KEY]: {
        ...DEFAULT_PREFS,
        header: { ...DEFAULT_PREFS.header, showVersion: false },
      },
    }),
    'utf-8',
  )
  return {
    statePath,
    cleanup: () => {
      if (savedSidebar !== undefined)
        process.env[SIDEBAR_STATE_ENV] = savedSidebar
      else delete process.env[SIDEBAR_STATE_ENV]
      if (savedTuiLog !== undefined)
        process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE = savedTuiLog
      else delete process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE
      if (savedPrefs !== undefined) process.env[TUI_PREFS_FILE_ENV] = savedPrefs
      else delete process.env[TUI_PREFS_FILE_ENV]
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function state(partial: Partial<SidebarStateV1>): SidebarStateV1 {
  return {
    ...DEFAULT_SIDEBAR_STATE,
    checkedAt: NOW,
    routingAuthoritative: true,
    ...partial,
    version: SIDEBAR_STATE_VERSION,
  }
}

// Read two minutes ago; every reset is still ahead.
function freshAccount(): SidebarAccountState {
  const checkedAt = NOW - 2 * MINUTE
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 100,
    current: true,
    quota: {
      gemini: {
        remainingPercent: 62,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 95,
            resetAt: NOW + 2 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 62,
            resetAt: NOW + 3 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 48,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 100,
            resetAt: NOW + 5 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 48,
            resetAt: NOW + 6 * DAY,
            checkedAt,
          },
        ],
      },
    },
  }
}

// The reported state: read 41 hours ago; the Gemini 5h, Other 5h and Other
// 7d resets have all passed since, only the Gemini 7d reset is still ahead.
function staleAccount(): SidebarAccountState {
  const checkedAt = NOW - 41 * HOUR
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 70,
    current: false,
    quota: {
      gemini: {
        remainingPercent: 9,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 95,
            resetAt: checkedAt + 3 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 9,
            resetAt: NOW + 5 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 0,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 100,
            resetAt: checkedAt + 4 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 0,
            resetAt: checkedAt + 20 * HOUR,
            checkedAt,
          },
        ],
      },
    },
  }
}

// A vault-served row: `vault-` id, never current, email kept for machine
// consumers only, and an older pool stored without per-window readings.
function vaultAccount(): SidebarAccountState {
  const checkedAt = NOW - 3 * HOUR
  return {
    id: 'vault-acct-0',
    label: 'Account 1',
    email: 'vault-user@example.test',
    enabled: true,
    health: 100,
    current: false,
    quota: {
      gemini: {
        remainingPercent: 40,
        checkedAt,
        windows: [
          {
            window: 'weekly',
            remainingPercent: 40,
            resetAt: NOW + 4 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 75,
        resetAt: NOW + 45 * MINUTE,
        checkedAt,
      },
    },
  }
}

function secondFreshAccount(): SidebarAccountState {
  const account = freshAccount()
  account.id = 'acct-1'
  account.label = 'Account 2'
  const gemini = account.quota.gemini
  const other = account.quota['non-gemini']
  if (gemini) {
    gemini.remainingPercent = 71
    const weekly = gemini.windows?.find((window) => window.window === 'weekly')
    if (weekly) weekly.remainingPercent = 71
  }
  if (other) {
    other.remainingPercent = 40
    const weekly = other.windows?.find((window) => window.window === 'weekly')
    if (weekly) weekly.remainingPercent = 40
  }
  return account
}

function emptyAccount(): SidebarAccountState {
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 100,
    current: true,
    quota: {},
  }
}

const ROUTE = {
  accountId: 'acct-0',
  modelFamily: 'claude' as const,
  headerStyle: 'antigravity' as const,
  strategy: 'round-robin' as const,
  updatedAt: NOW - MINUTE,
}

async function capture(
  fixture: Fixture,
  payload: SidebarStateV1,
  width: number,
  sessionId?: string,
  overrides: Partial<AntigravityAuthTuiPrefs> = {},
): Promise<string> {
  writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')
  const controller = createSidebarController({
    ...DEFAULT_PREFS,
    ...overrides,
    header: { ...DEFAULT_PREFS.header, showVersion: false },
    appearance: { ...DEFAULT_PREFS.appearance, ...overrides.appearance },
  })
  const setup = await testRender(
    () => (
      <SidebarPanel
        controller={controller}
        logger={NOOP_LOGGER}
        stateFile={fixture.statePath}
        now={() => NOW}
        sessionId={sessionId}
      />
    ),
    { width, height: 32 },
  )
  try {
    await setup.flush()
    await setup.flush()
    return trimFrame(setup.captureCharFrame())
  } finally {
    setup.renderer.destroy()
  }
}

type SpanFrame = {
  lines: Array<{ spans: Array<{ fg: unknown; text: string }> }>
}

async function captureWithSpans(
  fixture: Fixture,
  payload: SidebarStateV1,
  width: number,
  overrides: Partial<AntigravityAuthTuiPrefs> = {},
): Promise<{ frame: string; spans: SpanFrame }> {
  writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')
  const controller = createSidebarController({
    ...DEFAULT_PREFS,
    ...overrides,
    header: { ...DEFAULT_PREFS.header, showVersion: false },
    appearance: { ...DEFAULT_PREFS.appearance, ...overrides.appearance },
  })
  const setup = await testRender(
    () => (
      <SidebarPanel
        controller={controller}
        logger={NOOP_LOGGER}
        stateFile={fixture.statePath}
        now={() => NOW}
      />
    ),
    { width, height: 32 },
  )
  try {
    await setup.flush()
    await setup.flush()
    return {
      frame: trimFrame(setup.captureCharFrame()),
      spans: setup.captureSpans(),
    }
  } finally {
    setup.renderer.destroy()
  }
}

function trimFrame(frame: string): string {
  const lines = frame.split('\n').map((line) => line.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function show(label: string, width: number, frame: string): void {
  if (process.env.AGY_PRINT_FRAMES !== '1') return
  console.log(`\n=== ${label} @ ${width} cols ===\n${frame}\n`)
}

// The test renderer leaves the panel border out of the character frame, so
// each frame line is the panel's text with its padding.
function contentLines(frame: string): string[] {
  return frame
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// A window row is one line holding its name, its bar and its figure. A row
// that wrapped leaves a fragment of the figure ("left", "%", "le") or of a
// reset or age ("ago") on a following line, indented to the column where the
// wrapped text started. Every real line starts at the panel's padding.
function expectNoWrappedFragments(frame: string): void {
  for (const line of frame.split('\n')) {
    if (line.trim().length === 0) continue
    expect(line).toMatch(/^ {1,2}\S/)
  }
  for (const line of contentLines(frame)) {
    expect(line).not.toMatch(/^(left|le|ft|%|\d+%?|ago|resets.*)$/)
  }
}

function lineWith(frame: string, pattern: RegExp): string | undefined {
  return contentLines(frame).find((line) => pattern.test(line))
}

function expectPlainGroupNames(frame: string): void {
  expect(frame).toContain('Gemini')
  expect(frame).toContain('Other models')
  expect(frame).not.toMatch(/\bGm\b/)
  expect(frame).not.toMatch(/\bNG\b/)
}

describe('OpenCode 1 sidebar in a narrow sidebar', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  for (const width of WIDTHS) {
    it(`fresh readings fit one line per window at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [freshAccount()] }),
        width,
      )
      show('fresh', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^Account 1\b.*\bactive$/)).toBeDefined()
      expect(frame).not.toContain('checked')
      expect(frame).not.toContain('health')
      const windows = frame
        .split('\n')
        .filter((line) => /^\s*(5h|7d) /.test(line))
      expect(windows.map((line) => line.trim().slice(0, 2))).toEqual([
        '5h',
        '7d',
        '5h',
        '7d',
      ])
      expect(new Set(windows.map((line) => line.search(/\S/))).size).toBe(1)
      for (const [figure, reset] of [
        ['95% left', '2h'],
        ['62% left', '3d'],
        ['100% left', '5h'],
        ['48% left', '6d'],
      ] as const) {
        const row = lineWith(frame, new RegExp(`\\b${figure}\\b`))
        expect(row).toBeDefined()
        expect(row).toMatch(/^(5h|7d) /)
        expect(row).toMatch(new RegExp(`${reset}$`))
      }
    })

    it(`a free account shows weekly windows without inventing a 5h window at ${width} columns`, async () => {
      const account = freshAccount()
      account.label = 'Free Account'
      for (const group of Object.values(account.quota)) {
        group.windows = group.windows?.filter(
          (window) => window.window === 'weekly',
        )
      }
      const frame = await capture(
        fixture,
        state({ accounts: [account] }),
        width,
      )
      expect(frame).toContain('Free Account')
      expectPlainGroupNames(frame)
      expectNoWrappedFragments(frame)
      expect(frame).not.toContain('5h')
      expect(lineWith(frame, /^7d .*62% left\s+3d$/)).toBeDefined()
      expect(lineWith(frame, /^7d .*48% left\s+6d$/)).toBeDefined()
    })

    it(`a reading whose reset passed is not shown as current at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [staleAccount()] }),
        width,
      )
      show('stale (41h old, three resets passed)', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      // Three of four windows reset after the reading; their stored figures
      // (95%, 100% and 0% left) are history, not the quota now.
      expect(frame).not.toContain('95% left')
      expect(frame).not.toContain('100% left')
      expect(lineWith(frame, /(^|\s)0% left/)).toBeUndefined()
      expect(
        contentLines(frame).filter((line) =>
          /^(5h|7d) reset since last check$/.test(line),
        ),
      ).toHaveLength(3)
      // The one window whose reset is still ahead keeps its figure and reset.
      expect(lineWith(frame, /^7d .*\b9% left\s+5d$/)).toBeDefined()
      // The reading age appears once for the account, never per row.
      expect(frame.split('checked 1d17h ago')).toHaveLength(2)
      expect(frame).not.toContain('health')
    })

    it(`a vault account renders its readings at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [vaultAccount()] }),
        width,
      )
      show('vault account', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(frame).not.toContain('vault-user@example.test')
      expect(lineWith(frame, /^Account 1\b.*\bidle$/)).toBeDefined()
      expect(lineWith(frame, /^7d .*\b40% left\s+4d$/)).toBeDefined()
      expect(lineWith(frame, /\b75% left\s+45m$/)).toBeDefined()
      expect(frame.split('checked 3h ago')).toHaveLength(2)
    })

    it(`an account without quota readings shows one dim line at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [emptyAccount()] }),
        width,
      )
      show('empty quota', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame.split('no quota reading yet')).toHaveLength(2)
      expect(frame).not.toMatch(/\bGm\b|\bNG\b/)
    })

    it(`a session with a route shows it on whole lines at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({
          accounts: [freshAccount()],
          activeRouting: { 'ses-a': ROUTE },
        }),
        width,
        'ses-a',
      )
      show('session with route', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame).toContain('Routing')
      expect(frame).toContain('round-robin')
      expect(lineWith(frame, /\bclaude\b.*\bantigravity\b/)).toBeDefined()
      expect(frame).not.toContain('No request yet')
    })

    it(`a session without a route shows no placeholder at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({
          accounts: [freshAccount()],
          activeRouting: { 'ses-b': ROUTE },
        }),
        width,
        'ses-a',
      )
      show('session without route', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame).not.toContain('Route ')
      expect(frame).not.toContain('—')
      expect(frame).toContain('No request yet')
    })
  }

  for (const width of [20, 26, 32, 38, 48]) {
    it(`fits two-unit resets and reading age at ${width} columns`, async () => {
      const checkedAt = NOW - 41 * HOUR
      const account = freshAccount()
      account.quota = {
        gemini: {
          remainingPercent: 62,
          checkedAt,
          windows: [
            {
              window: '5h',
              remainingPercent: 95,
              resetAt: NOW + 23 * HOUR + 59 * MINUTE,
              checkedAt,
            },
            {
              window: 'weekly',
              remainingPercent: 62,
              resetAt: NOW + 3 * DAY + 23 * HOUR,
              checkedAt,
            },
          ],
        },
      }
      const frame = await capture(
        fixture,
        state({ accounts: [account] }),
        width,
      )
      show('two-unit resets and age', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame.split('checked 1d17h ago')).toHaveLength(2)
      for (const line of frame.split('\n'))
        expect(line.length).toBeLessThanOrEqual(width)
      for (const [figure, reset] of [
        ['95% left', '23h59m'],
        ['62% left', '3d23h'],
      ] as const) {
        const row = lineWith(frame, new RegExp(`\\b${figure}\\b`))
        expect(row).toBeDefined()
        if (width === 20) expect(row).not.toContain(reset)
        else expect(row).toMatch(new RegExp(`\\s${reset}$`))
      }
    })
  }

  it('shrinks the bar to fit before dropping the reset column', async () => {
    const wide = { appearance: { ...DEFAULT_PREFS.appearance, barWidth: 40 } }
    const payload = state({ accounts: [freshAccount()] })
    // The panel pads its content by one cell on each side, so 32 columns
    // leave 30: `5h `, a 14-cell bar and a space, `95% left`, then the
    // right-aligned `2h`.
    const roomy = await capture(fixture, payload, 32, undefined, wide)
    show('fresh, bar width 40', 32, roomy)
    const roomyRow = lineWith(roomy, /^5h .*95% left/)
    expect(roomyRow).toMatch(/^5h █{13}░ 95% left\s+2h$/)
    // 20 columns leave 18: a bar of at least four cells no longer fits next
    // to the reset, so the reset goes and the bar takes the room.
    const narrow = await capture(fixture, payload, 20, undefined, wide)
    show('fresh, bar width 40', 20, narrow)
    expectNoWrappedFragments(narrow)
    expect(lineWith(narrow, /^5h .*95% left/)).toMatch(/^5h █{5} 95% left$/)
    expect(lineWith(narrow, /^7d .*62% left/)).toMatch(/^7d █{3}░{2} 62% left$/)
  })
})

// A recent reading whose Gemini weekly reset arrived after it was taken.
function passedResetAccount(): SidebarAccountState {
  const account = freshAccount()
  const gemini = account.quota.gemini?.windows?.find(
    (window) => window.window === 'weekly',
  )
  if (gemini) gemini.resetAt = NOW - MINUTE
  return account
}

// OpenCode 1.18.35 fixes the sidebar at 42 columns with 2+2 cells of padding;
// the sidebar_content wrapper adds one more right-padding cell, leaving 37
// nominal content cells. It auto-shows only when the terminal is wider than
// 120 columns, so 20/26-column frames below are harness stress widths, not
// normal layouts. Source: packages/tui/src/routes/session/sidebar.tsx:28-37,48-86
// and routes/session/index.tsx:255-276 at OpenCode 1.18.35.
describe('OpenCode 1 collapsed sidebar row in a narrow sidebar', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  const collapsedPrefs = { collapsed: true, rememberCollapsed: true }
  const freshText = 'Ge 7d 62% · Ot 7d 48% left'
  const secondText = 'Ge 7d 71% · Ot 7d 40% left'
  const staleText = 'Ge 7d 9% · Ot 7d 0% left'
  const emptyText = 'no quota reading yet'
  const statusDot = ' ●'

  it('combines different limiting windows for both groups in one collapsed row', async () => {
    const account = freshAccount()
    account.quota['non-gemini']!.windows![0]!.remainingPercent = 40
    const frame = await capture(
      fixture,
      state({ accounts: [account] }),
      80,
      undefined,
      collapsedPrefs,
    )
    expect(frame).toContain('Ge 7d 62% · Ot 5h 40% left')
    expect(frame).toContain('●')
    expect(frame).not.toContain('Gemini 7d 62% left')
    expect(frame).not.toContain('Other 5h 40% left')
  })

  async function collapsedRows(
    accounts: SidebarAccountState[],
    width: number,
    label: string,
  ): Promise<string[]> {
    const frame = await capture(
      fixture,
      state({ accounts }),
      width,
      undefined,
      collapsedPrefs,
    )
    show(`collapsed ${label}`, width, frame)
    expectNoWrappedFragments(frame)
    const rows = contentLines(frame).filter(
      (line) =>
        /Account \d+|Ge 7d|no quota reading yet|left [●⊘]|— [●⊘]/.test(line) ||
        line.startsWith('… '),
    )
    expect(rows).toHaveLength(accounts.length)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(width - 2)
    return rows
  }

  function expectSharedRow(
    row: string,
    label: string,
    text: string,
    width: number,
  ): void {
    const innerWidth = width - 2
    if (text.length > innerWidth) {
      expect(row).toMatch(new RegExp(`^${label}\\s+●$`))
      return
    }
    expect(row).toContain(text)
    if (text.length + statusDot.length <= innerWidth)
      expect(row.endsWith('●')).toBe(true)
    else expect(row).toBe(text)
    if (text === freshText || text === secondText) {
      if (width === 32) expect(row).toMatch(/^…\s/)
      if (width === 38) expect(row).toMatch(/^Accoun…\s/)
      if (width === 48) expect(row).toMatch(/^Account \d+\s/)
    }
  }

  for (const width of COLLAPSED_WIDTHS) {
    it(`uses the exact shared narrow form or the label fallback at ${width} columns`, async () => {
      const rows = await collapsedRows([freshAccount()], width, 'fresh')
      expectSharedRow(rows[0] ?? '', 'Account 1', freshText, width)
    })

    it(`keeps the shared figure when a reset passed at ${width} columns`, async () => {
      const rows = await collapsedRows(
        [passedResetAccount()],
        width,
        'passed reset',
      )
      expectSharedRow(rows[0] ?? '', 'Account 1', freshText, width)
    })

    it(`uses the shared stale reading at ${width} columns`, async () => {
      const rows = await collapsedRows([staleAccount()], width, 'stale')
      expectSharedRow(rows[0] ?? '', 'Account 1', staleText, width)
    })

    it(`uses the shared empty-quota text at ${width} columns`, async () => {
      const rows = await collapsedRows([emptyAccount()], width, 'empty')
      expectSharedRow(rows[0] ?? '', 'Account 1', emptyText, width)
    })

    it(`renders one shared row per account at ${width} columns`, async () => {
      const rows = await collapsedRows(
        [freshAccount(), secondFreshAccount()],
        width,
        'several accounts',
      )
      expectSharedRow(rows[0] ?? '', 'Account 1', freshText, width)
      expectSharedRow(rows[1] ?? '', 'Account 2', secondText, width)
    })
  }

  it('shows the shared line at its 26-cell boundary and only the label just below', async () => {
    const tooNarrow = await collapsedRows(
      [freshAccount()],
      27,
      'below shared-line boundary',
    )
    expect(tooNarrow[0]).toMatch(/^Account 1\s+●$/)

    const justFits = await collapsedRows(
      [freshAccount()],
      28,
      'shared-line boundary',
    )
    expect(justFits[0]).toBe(freshText)
  })

  it('keeps the status dot and the minimum label only when the measured width allows both', async () => {
    const withoutLabel = await collapsedRows(
      [freshAccount()],
      31,
      'quota and status dot without label',
    )
    expect(withoutLabel[0]).toBe(`${freshText}${statusDot}`)

    const minimumLabel = await collapsedRows(
      [freshAccount()],
      32,
      'minimum label with quota and status dot',
    )
    expect(minimumLabel[0]).toBe(`… ${freshText}${statusDot}`)
  })

  it('dims the entire shared line when the shared stale helper marks it old', async () => {
    const fresh = await captureWithSpans(
      fixture,
      state({ accounts: [freshAccount()] }),
      32,
      collapsedPrefs,
    )
    const stale = await captureWithSpans(
      fixture,
      state({ accounts: [staleAccount()] }),
      32,
      collapsedPrefs,
    )
    show('fresh color reference', 32, fresh.frame)
    show('stale reading is dimmed', 32, stale.frame)
    const foreground = (spans: SpanFrame, text: string) =>
      spans.lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes(text))?.fg
    const freshColor = foreground(fresh.spans, freshText)
    const staleColor = foreground(stale.spans, staleText)
    expect(freshColor).toBeDefined()
    expect(staleColor).toBeDefined()
    expect(staleColor).not.toEqual(freshColor)
  })
})
