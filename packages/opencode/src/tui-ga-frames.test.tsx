/** @jsxImportSource @opentui/solid */

/**
 * Full-frame captures of the OpenCode 2 (GA) sidebar at 20, 26, 32, 38 and
 * 48 columns. The GA sidebar draws the same frame as the OpenCode 1 sidebar
 * (`tui/sidebar-frame.tsx`): the bordered panel, the `▼`/`▶ ANTIGRAVITY`
 * badge with the version at the right, the `Quota` and `Routing` headings,
 * one line per account when collapsed and no health line. It is fed from
 * the location-scoped `state` snapshot instead of the sidebar file. Each
 * scenario renders with a fixed clock so reset countdowns and reading ages
 * are deterministic.
 *
 * Every quota window must stay on one line, the pools must carry the plain
 * group names (`Gemini`, `Other models`), a window whose reset passed after
 * its reading must not show the stored figure, and the reading age appears
 * once per account. Collapsed, each account takes one line: its label, the
 * shared common-auth narrow form and a status dot, the label cut with `…`
 * to make room; when the narrow form does not fit, the label and the dot.
 *
 * Set AGY_PRINT_FRAMES=1 to print every captured frame.
 */

import { describe, expect, it } from 'bun:test'
import { testRender } from '@opentui/solid'

import {
  type GaTheme,
  setupGaTui,
  sidebarThemeFromHost,
} from './ga/tui/host-ga'
import { DEFAULT_QUOTA_APPEARANCE } from './tui/quota-layout'
import { fitRouteParts, routeLineFits } from './tui/route-layout'
import { DEFAULT_FRAME_SETTINGS } from './tui/sidebar-frame'
import { DEFAULT_PREFS } from './tui-preferences'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0)
const WIDTHS = [20, 26, 32, 38, 48] as const
const SELECTOR = `sel-${'a'.repeat(32)}`

type Account = Record<string, unknown>

function account(quota: Record<string, unknown>, extra: Account = {}) {
  return {
    selector: SELECTOR,
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 100,
    current: true,
    quota,
    ...extra,
  }
}

// Read two minutes ago; every reset is still ahead.
function freshAccount(): Account {
  const checkedAt = NOW - 2 * MINUTE
  return account({
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
  })
}

// Read 41 hours ago; the Gemini 5h, Other 5h and Other 7d resets have all
// passed since, only the Gemini 7d reset is still ahead.
function staleAccount(): Account {
  const checkedAt = NOW - 41 * HOUR
  return account(
    {
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
    { health: 70, current: false },
  )
}

// An account served from the vault, so never the local current account. Its
// Gemini pool has per-window readings; its other pool was stored in the older
// single-reading form, without windows.
function vaultAccount(): Account {
  const checkedAt = NOW - 3 * HOUR
  return account(
    {
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
    { current: false },
  )
}

function emptyAccount(): Account {
  return account({})
}

const ROUTE = {
  accountId: 'acct-0',
  modelFamily: 'claude',
  headerStyle: 'antigravity',
  strategy: 'round-robin',
  updatedAt: NOW - MINUTE,
}

// The same account with the Argon pool its reading reports.
function argonAccount(): Account {
  const base = freshAccount() as { quota: Record<string, unknown> }
  const checkedAt = NOW - 2 * MINUTE
  return account({
    ...base.quota,
    'gemini-argon': {
      remainingPercent: 30,
      checkedAt,
      windows: [
        {
          window: 'weekly',
          remainingPercent: 30,
          resetAt: NOW + 2 * DAY,
          checkedAt,
        },
      ],
    },
  })
}

// A second local account, with lower figures and not the current one.
function secondAccount(): Account {
  const checkedAt = NOW - 2 * MINUTE
  return account(
    {
      gemini: {
        remainingPercent: 71,
        checkedAt,
        windows: [
          {
            window: 'weekly',
            remainingPercent: 71,
            resetAt: NOW + 3 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 40,
        checkedAt,
        windows: [
          {
            window: 'weekly',
            remainingPercent: 40,
            resetAt: NOW + 6 * DAY,
            checkedAt,
          },
        ],
      },
    },
    {
      selector: `sel-${'b'.repeat(32)}`,
      id: 'acct-1',
      label: 'Account 2',
      current: false,
    },
  )
}

interface SnapshotExtra {
  route?: unknown
  selectionStrategy?: string
  checkedAt?: number | null
  quotaBackoffUntil?: number | null
}

function snapshot(accounts: Account[], extra: SnapshotExtra = {}) {
  return {
    output: {
      version: 1,
      kind: 'snapshot',
      generation: 'gen-1',
      scope: { kind: 'session', sessionID: 'ses_a' },
      reset: 'initial',
      cursor: 0,
      dropped: 0,
      more: false,
      notifications: [],
      readSeq: 1,
      accountsStatus: { kind: 'complete' },
      accounts,
      route: extra.route ?? null,
      status: {
        checkedAt: extra.checkedAt === undefined ? NOW : extra.checkedAt,
        quotaBackoffUntil: extra.quotaBackoffUntil ?? null,
        routingAuthoritative: true,
      },
      settings: {
        selectionStrategy: extra.selectionStrategy ?? 'hybrid',
        killswitch: { enabled: false, minimumRemainingPercent: 10 },
        logLevel: 'info',
        dump: { enabled: false },
      },
    },
  }
}

// A vault location whose vault serves no accounts: the `state` answer holds
// an empty roster and no reading time.
function vaultRefusal() {
  return snapshot([], { selectionStrategy: 'vault', checkedAt: null })
}

/** A fake of the host's plugin storage that outlives one setup. */
function memoryStorage(initial: Record<string, unknown> = {}) {
  const stores = new Map<string, Record<string, unknown>>(
    Object.entries(initial).map(([key, value]) => [
      key,
      structuredClone(value) as Record<string, unknown>,
    ]),
  )
  return {
    stores,
    store<Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>] {
      if (!stores.has(key))
        stores.set(
          key,
          structuredClone(options.initial) as Record<string, unknown>,
        )
      const value = stores.get(key) as Value
      return [value, async (mutation) => mutation(value)] as const
    },
  }
}

function fakeContext(
  answer: unknown,
  extra: { theme?: GaTheme; storage?: unknown } = {},
) {
  let claim: { render: (input: { sessionID: string }) => unknown } | undefined
  const claimed = Promise.withResolvers<NonNullable<typeof claim>>()
  const context = {
    ...extra,
    location: { directory: '/work/a' },
    client: { rpc: { call: async () => answer } },
    ui: {
      dialog: {
        set: () => undefined,
        clear: () => undefined,
        alert: async () => undefined,
        confirm: async () => false,
        prompt: async () => undefined,
        select: async () => undefined,
      },
      toast: { show: () => undefined },
      router: {
        current: () => ({ type: 'session', sessionID: 'ses_a' }) as const,
      },
      slot: (value: typeof claim) => {
        claim = value
        if (value) claimed.resolve(value)
        return () => undefined
      },
    },
  }
  return { context, claimed: claimed.promise }
}

interface CaptureOptions {
  sessionID?: string
  collapsed?: boolean
  version?: string
  theme?: GaTheme
}

async function render(
  answer: unknown,
  width: number,
  options: CaptureOptions & { storage?: unknown } = {},
) {
  const fake = fakeContext(answer, {
    ...(options.theme ? { theme: options.theme } : {}),
    storage:
      options.storage ??
      memoryStorage(
        options.collapsed
          ? { 'antigravity-auth.sidebar': { collapsed: true } }
          : {},
      ),
  })
  const cleanup = setupGaTui(fake.context as never, {
    now: () => NOW,
    schedule: () => () => undefined,
    ...(options.version !== undefined ? { version: options.version } : {}),
  })
  const claim = await fake.claimed
  const setup = await testRender(
    () => claim.render({ sessionID: options.sessionID ?? 'ses_a' }) as never,
    { width, height: 40 },
  )
  await setup.flush()
  await setup.flush()
  return {
    setup,
    frame: () => trimFrame(setup.captureCharFrame()),
    async close() {
      setup.renderer.destroy()
      await cleanup()
    },
  }
}

async function capture(
  answer: unknown,
  width: number,
  options: CaptureOptions = {},
): Promise<string> {
  const view = await render(answer, width, options)
  try {
    return view.frame()
  } finally {
    await view.close()
  }
}

function trimFrame(frame: string): string {
  const lines = frame.split('\n').map((line) => line.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function show(label: string, width: number, frame: string): void {
  if (process.env.AGY_PRINT_FRAMES !== '1') return
  console.log(`\n=== GA ${label} @ ${width} cols ===\n${frame}\n`)
}

function contentLines(frame: string): string[] {
  return frame
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function lineWith(frame: string, pattern: RegExp): string | undefined {
  return contentLines(frame).find((line) => pattern.test(line))
}

// Every real line starts at the panel's padding, one or two cells in, like
// the OpenCode 1 sidebar's. A quota row that wrapped leaves a fragment of
// its figure ("left", "%"), reset or age ("ago") alone on the next line.
function expectFramedLines(frame: string, width: number): void {
  for (const line of frame.split('\n')) {
    if (line.trim().length === 0) continue
    expect(line).toMatch(/^ {1,2}\S/)
    expect(line.length).toBeLessThanOrEqual(width)
  }
  for (const line of contentLines(frame))
    expect(line).not.toMatch(/^(left|le|ft|%|\d+%?|ago|resets.*|\d+[mhd]\S*)$/)
}

function expectPlainGroupNames(frame: string): void {
  expect(contentLines(frame)).toContain('Gemini')
  expect(contentLines(frame)).toContain('Other models')
  expect(frame).not.toMatch(/\bGm\b/)
  expect(frame).not.toMatch(/\bNG\b/)
}

// The expanded frame: the open badge first, then the `Quota` heading.
function expectExpandedFrame(frame: string): void {
  const lines = contentLines(frame)
  expect(lines[0]).toMatch(/^▼ ANTIGRAVITY\b/)
  expect(lines[1]).toBe('Quota')
  expect(lines).toContain('Routing')
  expect(frame).not.toContain('health')
}

const FRESH_TEXT = 'Ge 7d 62% · Ot 7d 48% left'
const SECOND_TEXT = 'Ge 7d 71% · Ot 7d 40% left'
const STATUS_DOT = ' ●'

// One collapsed account row within the padded width. When the shared narrow
// form fits, the row holds it, followed by the status dot when that fits
// too; when it does not fit, the row is the label and the dot.
function expectCollapsedRow(
  row: string | undefined,
  label: string,
  text: string,
  width: number,
): void {
  const inner = width - 2
  expect(row).toBeDefined()
  expect((row ?? '').length).toBeLessThanOrEqual(inner)
  if (text.length > inner) {
    expect(row).toMatch(new RegExp(`^${label}\\s+●$`))
    return
  }
  expect(row).toContain(text)
  if (text.length + STATUS_DOT.length <= inner)
    expect(row?.endsWith('●')).toBe(true)
  else expect(row).toBe(text)
}

describe('OpenCode 2 sidebar frame', () => {
  it('draws bars and the header with the OpenCode 1 defaults', () => {
    // The GA sidebar has no preferences file, so it draws with a copy of the
    // OpenCode 1 defaults; the copy must not drift.
    expect(DEFAULT_QUOTA_APPEARANCE).toEqual(DEFAULT_PREFS.appearance)
    expect(DEFAULT_FRAME_SETTINGS).toEqual({
      header: DEFAULT_PREFS.header,
      sections: DEFAULT_PREFS.sections,
      appearance: DEFAULT_PREFS.appearance,
    })
  })

  for (const width of WIDTHS) {
    it(`fresh readings fit one line per window at ${width} columns`, async () => {
      const frame = await capture(snapshot([freshAccount()]), width)
      show('fresh', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^Account 1\s+active$/)).toBeDefined()
      expect(frame).not.toContain('checked')
      for (const [figure, reset] of [
        ['95% left', '2h'],
        ['62% left', '3d'],
        ['100% left', '5h'],
        ['48% left', '6d'],
      ] as const) {
        const row = lineWith(frame, new RegExp(`\\b${figure}\\b`))
        expect(row).toBeDefined()
        expect(row).toMatch(/^(5h|7d) /)
        if (width > 20) expect(row).toMatch(new RegExp(`\\s${reset}$`))
      }
      // Before the session's first request, one dim line under the heading.
      expect(lineWith(frame, /^No request yet$/)).toBeDefined()
    })

    it(`a window whose reset passed is not shown as current at ${width} columns`, async () => {
      const frame = await capture(snapshot([staleAccount()]), width)
      show('stale (41h old, three resets passed)', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      expectPlainGroupNames(frame)
      // Three of four windows reset after the reading; their stored figures
      // (95%, 100% and 0% left) describe the window before that reset.
      expect(frame).not.toContain('95% left')
      expect(frame).not.toContain('100% left')
      expect(lineWith(frame, /(^|\s)0% left/)).toBeUndefined()
      expect(
        contentLines(frame).filter((line) => /^(5h|7d) reset since/.test(line)),
      ).toHaveLength(3)
      // The one window whose reset is still ahead keeps its figure.
      expect(lineWith(frame, /^7d .*\b9% left\b/)).toBeDefined()
      // The reading age appears once for the account, never per row.
      expect(frame.split('checked 1d17h ago')).toHaveLength(2)
      expect(lineWith(frame, /^Account 1\b.*\bidle$/)).toBeDefined()
    })

    it(`a vault account renders its readings at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([vaultAccount()], { selectionStrategy: 'vault' }),
        width,
      )
      show('vault account', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^Account 1\b.*\bidle$/)).toBeDefined()
      expect(lineWith(frame, /^7d .*\b40% left\b/)).toBeDefined()
      // The pool stored without per-window readings has no window name.
      expect(lineWith(frame, /^[█░]* ?75% left\b/)).toBeDefined()
      expect(frame.split('checked 3h ago')).toHaveLength(2)
    })

    it(`a vault that serves no accounts waits for quota at ${width} columns`, async () => {
      const frame = await capture(vaultRefusal(), width)
      show('vault refusal', width, frame)
      expectFramedLines(frame, width)
      // Nothing to collapse into: the badge has no arrow and no section shows.
      const lines = contentLines(frame)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^ANTIGRAVITY/)
      expect(lines[1]).toBe('Waiting for quota…')
    })

    it(`an account without quota readings shows one dim line at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([emptyAccount()], { checkedAt: null }),
        width,
      )
      show('no quota yet', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      // OpenCode 1 clips this one dim line at the padded width rather than
      // wrapping it; the shared frame does the same.
      const empty = 'no quota reading yet'.slice(0, width - 2)
      expect(contentLines(frame).filter((line) => line === empty)).toHaveLength(
        1,
      )
      expect(contentLines(frame)).not.toContain('Gemini')
      expect(frame).not.toContain('not checked')
    })

    it(`several accounts each get a block at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount(), secondAccount()]),
        width,
      )
      show('several accounts', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      expect(lineWith(frame, /^Account 1\s+active$/)).toBeDefined()
      expect(lineWith(frame, /^Account 2\s+idle$/)).toBeDefined()
      // A blank line parts the two blocks.
      const lines = frame.split('\n').map((line) => line.trim())
      const second = lines.findIndex((line) => /^Account 2\b/.test(line))
      expect(lines[second - 1]).toBe('')
    })

    it(`an account with the Argon pool shows it as its own group at ${width} columns`, async () => {
      const frame = await capture(snapshot([argonAccount()]), width)
      show('Argon present', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      expectPlainGroupNames(frame)
      const lines = contentLines(frame)
      expect(lines).toContain('Argon')
      expect(lines[lines.indexOf('Argon') + 1]).toMatch(/^7d .*\b30% left\b/)
    })

    it(`a session with a route shows it like OpenCode 1 at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount()], { route: ROUTE }),
        width,
      )
      show('session with route', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      const value = 'round-robin · claude: antigravity'
      if (routeLineFits('Route', value, width - 2))
        expect(lineWith(frame, /^Route\s/)).toMatch(
          new RegExp(`^Route\\s+${value}$`),
        )
      else {
        // One line per part, the strategy last; like OpenCode 1, a part
        // wider than the padded width is clipped there.
        const lines = contentLines(frame)
        const at = lines.indexOf('claude: antigravity'.slice(0, width - 2))
        expect(at).toBeGreaterThan(lines.indexOf('Routing'))
        expect(lines[at + 1]).toBe('round-robin')
      }
      expect(frame).not.toContain('No request yet')
    })

    it(`a session without a route shows the placeholder at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount()], { route: ROUTE }),
        width,
        { sessionID: 'ses_other' },
      )
      show('session without route', width, frame)
      expectFramedLines(frame, width)
      expectExpandedFrame(frame)
      expect(frame).not.toContain('Route ')
      expect(frame).not.toContain('claude')
      expect(lineWith(frame, /^No request yet$/)).toBeDefined()
    })

    it(`collapsed, one account takes one shared narrow line at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount()], { route: ROUTE }),
        width,
        { collapsed: true },
      )
      show('collapsed', width, frame)
      expectFramedLines(frame, width)
      const lines = contentLines(frame)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^▶ ANTIGRAVITY\b/)
      expectCollapsedRow(lines[1], 'Account 1', FRESH_TEXT, width)
    })

    it(`collapsed, several accounts take one line each at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount(), secondAccount()]),
        width,
        { collapsed: true },
      )
      show('collapsed, several accounts', width, frame)
      expectFramedLines(frame, width)
      const lines = contentLines(frame)
      expect(lines).toHaveLength(3)
      expect(lines[0]).toMatch(/^▶ ANTIGRAVITY\b/)
      expectCollapsedRow(lines[1], 'Account 1', FRESH_TEXT, width)
      expectCollapsedRow(lines[2], 'Account 2', SECOND_TEXT, width)
    })

    it(`collapsed, an account without readings uses the shared empty text at ${width} columns`, async () => {
      const frame = await capture(snapshot([emptyAccount()]), width, {
        collapsed: true,
      })
      show('collapsed, no quota yet', width, frame)
      expectFramedLines(frame, width)
      const lines = contentLines(frame)
      expect(lines).toHaveLength(2)
      expectCollapsedRow(lines[1], 'Account 1', 'no quota reading yet', width)
    })

    it(`collapsed, a vault that serves no accounts still waits for quota at ${width} columns`, async () => {
      const frame = await capture(vaultRefusal(), width, { collapsed: true })
      show('collapsed, vault refusal', width, frame)
      expectFramedLines(frame, width)
      expect(contentLines(frame).at(-1)).toBe('Waiting for quota…')
    })
  }

  it('shows the plugin version at the right of the badge', async () => {
    const frame = await capture(snapshot([freshAccount()]), 38, {
      version: '9.8.7',
    })
    show('with version', 38, frame)
    expect(contentLines(frame)[0]).toMatch(/^▼ ANTIGRAVITY\s+v9\.8\.7$/)
    // Without a version the badge stands alone.
    const bare = await capture(snapshot([freshAccount()]), 38)
    expect(contentLines(bare)[0]).toBe('▼ ANTIGRAVITY')
  })

  it('shows LIMITED in place of the version while quota checks are paused', async () => {
    const frame = await capture(
      snapshot([freshAccount()], { quotaBackoffUntil: NOW + 5 * MINUTE }),
      38,
      { version: '9.8.7' },
    )
    show('quota backoff', 38, frame)
    expect(contentLines(frame)[0]).toMatch(/^▼ ANTIGRAVITY\s+LIMITED$/)
    expect(frame).not.toContain('v9.8.7')
    expect(contentLines(frame)).toContain('Health')
    expect(lineWith(frame, /^Quota API\s+backoff 5m$/)).toBeDefined()
  })

  it('shortens long account labels at whole-word boundaries', () => {
    const value = fitRouteParts(
      'Route',
      ['Account team one', 'claude', 'antigravity'],
      20,
    )
    expect(value).toBe('Account team…')
    expect(routeLineFits('Route', value, 20)).toBe(true)
  })
})

describe('OpenCode 2 sidebar collapse', () => {
  it('collapses on a badge click, and a reload keeps it collapsed', async () => {
    const storage = memoryStorage()
    const first = await render(snapshot([freshAccount()]), 38, { storage })
    try {
      expect(contentLines(first.frame())[0]).toBe('▼ ANTIGRAVITY')
      const lines = first.setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('ANTIGRAVITY'))
      await first.setup.mockMouse.click(lines[row]!.indexOf('ANTIGRAVITY'), row)
      await first.setup.flush()
      await first.setup.flush()
      expect(contentLines(first.frame())[0]).toBe('▶ ANTIGRAVITY')
      expect(contentLines(first.frame())).toHaveLength(2)
    } finally {
      await first.close()
    }
    expect(storage.stores.get('antigravity-auth.sidebar')).toEqual({
      collapsed: true,
    })

    // A new setup over the same host storage is a TUI reload.
    const second = await render(snapshot([freshAccount()]), 38, { storage })
    try {
      expect(contentLines(second.frame())[0]).toBe('▶ ANTIGRAVITY')
      const lines = second.setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('ANTIGRAVITY'))
      await second.setup.mockMouse.click(
        lines[row]!.indexOf('ANTIGRAVITY'),
        row,
      )
      await second.setup.flush()
      await second.setup.flush()
      expect(contentLines(second.frame())[0]).toBe('▼ ANTIGRAVITY')
    } finally {
      await second.close()
    }
    expect(storage.stores.get('antigravity-auth.sidebar')).toEqual({
      collapsed: false,
    })
  })

  it('a click on the badge with nothing to show changes nothing', async () => {
    const storage = memoryStorage()
    const view = await render(vaultRefusal(), 38, { storage })
    try {
      const lines = view.setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('ANTIGRAVITY'))
      await view.setup.mockMouse.click(lines[row]!.indexOf('ANTIGRAVITY'), row)
      await view.setup.flush()
      expect(storage.stores.get('antigravity-auth.sidebar')).toEqual({
        collapsed: false,
      })
    } finally {
      await view.close()
    }
  })

  it('without host storage the choice lasts for the session', async () => {
    const view = await render(snapshot([freshAccount()]), 38, {
      storage: undefined as never,
    })
    try {
      const lines = view.setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('ANTIGRAVITY'))
      await view.setup.mockMouse.click(lines[row]!.indexOf('ANTIGRAVITY'), row)
      await view.setup.flush()
      await view.setup.flush()
      expect(contentLines(view.frame())[0]).toBe('▶ ANTIGRAVITY')
    } finally {
      await view.close()
    }
  })
})

// The OpenCode 2 `ResolvedTheme` token shape, as far as the sidebar reads it.
const FULL_THEME = {
  text: {
    base: '#e0e0e0',
    muted: '#808080',
    action: { primary: { base: '#8080ff' } },
    feedback: {
      success: { base: '#00c000' },
      warning: { base: '#e0a000' },
      error: { base: '#e00000' },
    },
  },
  background: { base: '#101010' },
  border: { base: '#404040' },
} satisfies GaTheme

// The test renderer converts hex strings to RGBA and renders the
// `RGBA.toString()` form; compute that string from a hex value.
function rgba(hex: string): string {
  const cleaned = hex.replace('#', '')
  const channel = (at: number) =>
    (parseInt(cleaned.slice(at, at + 2), 16) / 255).toFixed(2)
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, 1.00)`
}

type SpanFrame = {
  lines: Array<{
    spans: Array<{ fg: unknown; bg: unknown; text: string }>
  }>
}

function spanWith(spans: SpanFrame, text: string) {
  for (const line of spans.lines)
    for (const span of line.spans) if (span.text.includes(text)) return span
  return undefined
}

describe('OpenCode 2 sidebar theme', () => {
  it('maps a full host theme onto the OpenCode 1 palette names', () => {
    expect(sidebarThemeFromHost(FULL_THEME)).toEqual({
      text: '#e0e0e0',
      textMuted: '#808080',
      accent: '#8080ff',
      background: '#101010',
      success: '#00c000',
      warning: '#e0a000',
      error: '#e00000',
    })
  })

  it('falls back to sibling tokens, and to the host default with none', () => {
    expect(sidebarThemeFromHost({ text: { muted: '#808080' } })).toEqual({
      text: '#808080',
      textMuted: '#808080',
      accent: '#808080',
      background: undefined,
      success: undefined,
      warning: undefined,
      error: undefined,
    })
    const empty = sidebarThemeFromHost({})
    expect(Object.values(empty).every((color) => color === undefined)).toBe(
      true,
    )
    expect(sidebarThemeFromHost(undefined)).toEqual(empty)
  })

  it('colors the frame from a full host theme', async () => {
    const quota = {
      gemini: { remainingPercent: 20, checkedAt: NOW },
      'non-gemini': { remainingPercent: 80, checkedAt: NOW },
    }
    const view = await render(snapshot([account(quota)]), 40, {
      theme: FULL_THEME,
    })
    try {
      const spans = view.setup.captureSpans() as SpanFrame
      // Tones follow the OpenCode 1 defaults: 80% used or more is an error.
      expect(String(spanWith(spans, '20% left')?.fg)).toBe(rgba('#e00000'))
      expect(String(spanWith(spans, '80% left')?.fg)).toBe(rgba('#00c000'))
      expect(String(spanWith(spans, 'active')?.fg)).toBe(rgba('#00c000'))
      expect(String(spanWith(spans, 'Account 1')?.fg)).toBe(rgba('#e0e0e0'))
      expect(String(spanWith(spans, 'Quota')?.fg)).toBe(rgba('#e0e0e0'))
      expect(String(spanWith(spans, 'Other models')?.fg)).toBe(rgba('#808080'))
      expect(String(spanWith(spans, 'No request yet')?.fg)).toBe(
        rgba('#808080'),
      )
      const badge = spanWith(spans, 'ANTIGRAVITY')
      expect(String(badge?.fg)).toBe(rgba('#101010'))
      expect(String(badge?.bg)).toBe(rgba('#8080ff'))
    } finally {
      await view.close()
    }
  })

  it('draws the same frame uncolored on an empty host theme', async () => {
    const themed = await capture(snapshot([freshAccount()]), 38, {
      theme: FULL_THEME,
    })
    const bare = await capture(snapshot([freshAccount()]), 38, { theme: {} })
    show('empty theme', 38, bare)
    expect(bare).toBe(themed)
    expectExpandedFrame(bare)
  })
})
