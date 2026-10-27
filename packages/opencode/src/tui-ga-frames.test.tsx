/** @jsxImportSource @opentui/solid */

/**
 * Full-frame captures of the OpenCode 2 (GA) sidebar at 20, 26, 32, 38 and
 * 48 columns. The GA sidebar draws quota with the same layout code as the
 * OpenCode 1 sidebar (`tui/quota-layout.tsx`), fed from the location-scoped
 * `state` snapshot instead of the sidebar file. Each scenario renders with a
 * fixed clock so reset countdowns and reading ages are deterministic.
 *
 * Every quota window must stay on one line, the pools must carry the plain
 * group names (`Gemini`, `Other models`), a window whose reset passed after
 * its reading must not show the stored figure, and the reading age appears
 * once per account. The GA sidebar has no collapsed mode, so there is no
 * collapsed-row case here.
 *
 * Set AGY_PRINT_FRAMES=1 to print every captured frame.
 */

import { describe, expect, it } from 'bun:test'
import { testRender } from '@opentui/solid'

import { setupGaTui } from './ga/tui/host-ga'
import { DEFAULT_QUOTA_APPEARANCE } from './tui/quota-layout'
import { fitRouteParts, routeLineFits } from './tui/route-layout'
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

function snapshot(
  accounts: Account[],
  extra: { route?: unknown; selectionStrategy?: string } = {},
) {
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
        checkedAt: NOW,
        quotaBackoffUntil: null,
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

function fakeContext(answer: unknown) {
  let claim: { render: (input: { sessionID: string }) => unknown } | undefined
  const claimed = Promise.withResolvers<NonNullable<typeof claim>>()
  const context = {
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

async function capture(
  answer: unknown,
  width: number,
  sessionID = 'ses_a',
): Promise<string> {
  const fake = fakeContext(answer)
  const cleanup = setupGaTui(fake.context as never, {
    now: () => NOW,
    schedule: () => () => undefined,
  })
  const claim = await fake.claimed
  const setup = await testRender(() => claim.render({ sessionID }) as never, {
    width,
    height: 40,
  })
  try {
    await setup.flush()
    await setup.flush()
    return trimFrame(setup.captureCharFrame())
  } finally {
    setup.renderer.destroy()
    await cleanup()
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

// A quota row that wrapped leaves a fragment of its figure ("left", "%"),
// reset or age ("ago") alone on the next line.
function expectNoWrappedFragments(frame: string): void {
  for (const line of frame.split('\n'))
    expect(line.length).toBeLessThanOrEqual(200)
  for (const line of contentLines(frame))
    expect(line).not.toMatch(/^(left|le|ft|%|\d+%?|ago|resets.*|\d+[mhd]\S*)$/)
}

function expectPlainGroupNames(frame: string): void {
  expect(contentLines(frame)).toContain('Gemini')
  expect(contentLines(frame)).toContain('Other models')
  expect(frame).not.toMatch(/\bGm\b/)
  expect(frame).not.toMatch(/\bNG\b/)
}

describe('OpenCode 2 sidebar quota layout', () => {
  it('draws bars with the OpenCode 1 default appearance', () => {
    // The GA sidebar has no preferences file, so it draws with a copy of the
    // OpenCode 1 default appearance; the copy must not drift.
    expect(DEFAULT_QUOTA_APPEARANCE).toEqual(DEFAULT_PREFS.appearance)
  })
  for (const width of WIDTHS) {
    it(`fresh readings fit one line per window at ${width} columns`, async () => {
      const frame = await capture(snapshot([freshAccount()]), width)
      show('fresh', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^Account 1\s+active$/)).toBeDefined()
      expect(frame).not.toContain('checked')
      expect(lineWith(frame, /^health 100$/)).toBeDefined()
      for (const [figure, reset] of [
        ['95% left', '2h'],
        ['62% left', '3d'],
        ['100% left', '5h'],
        ['48% left', '6d'],
      ] as const) {
        const row = lineWith(frame, new RegExp(`\\b${figure}\\b`))
        expect(row).toBeDefined()
        expect(row).toMatch(/^(5h|7d) /)
        expect(row).toMatch(new RegExp(`\\s${reset}$`))
      }
    })

    it(`a window whose reset passed is not shown as current at ${width} columns`, async () => {
      const frame = await capture(snapshot([staleAccount()]), width)
      show('stale (41h old, three resets passed)', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      // Three of four windows reset after the reading; their stored figures
      // (95%, 100% and 0% left) describe the window before that reset.
      expect(frame).not.toContain('95% left')
      expect(frame).not.toContain('100% left')
      expect(lineWith(frame, /(^|\s)0% left/)).toBeUndefined()
      expect(
        contentLines(frame).filter((line) => /^(5h|7d) reset since/.test(line)),
      ).toHaveLength(3)
      // The one window whose reset is still ahead keeps its figure and reset.
      expect(lineWith(frame, /^7d .*\b9% left\s+5d$/)).toBeDefined()
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
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^Account 1\b.*\bidle$/)).toBeDefined()
      // At 20 columns a named row has no room for a bar of at least four
      // cells next to the three-cell `45m` reset column, so the reset goes.
      expect(
        lineWith(
          frame,
          width === 20 ? /^7d [█░]+ 40% left$/ : /^7d .*\b40% left\s+4d$/,
        ),
      ).toBeDefined()
      // The pool stored without per-window readings has no window name.
      expect(lineWith(frame, /^[█░]* ?75% left\s+45m$/)).toBeDefined()
      expect(frame.split('checked 3h ago')).toHaveLength(2)
    })

    it(`an account without quota readings shows one dim line at ${width} columns`, async () => {
      const frame = await capture(snapshot([emptyAccount()]), width)
      show('empty quota', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame.split('no quota reading yet')).toHaveLength(2)
      expect(frame).not.toMatch(/\bGm\b|\bNG\b/)
      expect(contentLines(frame)).not.toContain('Gemini')
    })

    it(`a session with a route keeps its route line at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount()], { route: ROUTE }),
        width,
      )
      show('session with route', width, frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^7d .*\b48% left\s+6d$/)).toBeDefined()
      const routeLine = lineWith(frame, /^Route /)
      expect(routeLine).toBeDefined()
      expect(routeLine?.length).toBeLessThanOrEqual(width)
      expect(routeLine).toBe(
        width < 26
          ? 'Route Account 1'
          : width < 38
            ? 'Route Account 1 · claude'
            : 'Route Account 1 · claude · antigravity',
      )
    })

    it(`a session without a route shows no route line at ${width} columns`, async () => {
      const frame = await capture(
        snapshot([freshAccount()], { route: ROUTE }),
        width,
        'ses_other',
      )
      show('session without route', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(frame).not.toContain('Route')
    })
  }

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
