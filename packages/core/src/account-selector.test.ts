import { describe, expect, it } from 'bun:test'
import {
  AccountManager,
  type AccountSessionIdentity,
  type RateLimitReason,
} from './account-manager.ts'
import {
  AccountSelector,
  type SelectableAccount,
  type SelectionSink,
} from './account-selector.ts'
import type { AccountStorageStore } from './account-storage.ts'
import type {
  AccountModelFamily,
  AccountSelectionStrategy,
  AccountStorageV4,
  CooldownReason,
} from './account-types.ts'
import { HealthScoreTracker, TokenBucketTracker } from './rotation.ts'

describe('issue69 dated quota evidence', () => {
  const start = Date.UTC(2026, 9, 7)
  const long = 65 * 60 * 60 * 1000
  const model = 'gemini-3.8-flash'
  const key = `gemini:${model}`
  function manager(fraction?: number, dated = true, legacy = false) {
    let now = start
    const pool = new AccountManager(
      undefined,
      {
        version: 4,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: 'issue69-refresh',
            addedAt: 1,
            lastUsed: 0,
            ...(legacy ? { rateLimitResetTimes: { [key]: start + long } } : {}),
            ...(fraction !== undefined
              ? {
                  cachedQuota: {
                    gemini: {
                      remainingFraction: fraction,
                      modelCount: 1,
                      resetTime: new Date(start + long).toISOString(),
                    },
                  },
                }
              : {}),
            ...(dated ? { cachedQuotaUpdatedAt: start - 1 } : {}),
          },
        ],
      },
      { now: () => now, store: memoryStore() },
    )
    return {
      pool,
      row: pool.getAccounts()[0]!,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it('unconfirmed refusals cool only the family/model key without escalating failures', () => {
    const { pool, row } = manager()
    row.consecutiveFailures = 4
    row.lastFailureTime = start - 1
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        pool.markRateLimitedWithReason(row, 'gemini', model, 'UNKNOWN'),
      ).toBe(5000)
      expect(row.rateLimitResetTimes).toEqual({ [key]: start + 5000 })
      expect(row.consecutiveFailures).toBe(4)
      expect(row.lastFailureTime).toBe(start - 1)
      expect(row.coolingDownUntil).toBeUndefined()
    }
    expect(
      pool.markRateLimitedWithReason(row, 'gemini', model, 'UNKNOWN', 12_000),
    ).toBe(12_000)
    expect(
      pool.markRateLimitedWithReason(row, 'gemini', model, 'UNKNOWN', 90_000),
    ).toBe(30_000)
    expect(
      pool.markRateLimitedWithReason(
        row,
        'gemini',
        model,
        'RATE_LIMIT_EXCEEDED',
        60_000,
      ),
    ).toBe(60_000)
    expect(row.consecutiveFailures).toBe(5)
  })

  for (const [label, fraction, dated] of [
    ['positive', 1, true],
    ['missing', undefined, true],
    ['undated empty', 0, false],
  ] as const) {
    it(`issue69 uses the ordinary ladder with ${label} evidence`, () => {
      const { pool, row, advance } = manager(fraction, dated)
      expect(
        pool.markRateLimitedWithReason(
          row,
          'gemini',
          model,
          'QUOTA_EXHAUSTED',
          long,
        ),
      ).toBe(60_000)
      expect(row.rateLimitResetTimes[key]).toBe(start + 60_000)
      advance(60_001)
      expect(pool.getCurrentOrNextForFamily('gemini', model)).toBe(row)
    })
  }

  it('issue69 keeps a long reset with a dated empty pool', () => {
    const { pool, row, advance } = manager(0)
    expect(
      pool.markRateLimitedWithReason(
        row,
        'gemini',
        model,
        'QUOTA_EXHAUSTED',
        long,
      ),
    ).toBe(long)
    advance(long - 1)
    expect(pool.getCurrentOrNextForFamily('gemini', model)).toBeNull()
    advance(1)
    expect(pool.getCurrentOrNextForFamily('gemini', model)).toBe(row)
  })

  for (const legacy of [false, true]) {
    it(`issue69 a newer positive reading clears ${legacy ? 'a legacy' : 'a current'} mark immediately`, () => {
      const { pool, row, advance } = manager(undefined, true, legacy)
      if (!legacy) pool.markRateLimited(row, long, 'gemini', model)
      expect(pool.isRateLimited(row, 'gemini', model)).toBe(true)
      advance(1)
      pool.updateQuotaCache(0, {
        gemini: {
          remainingFraction: 0.9,
          modelCount: 1,
          resetTime: new Date(start + long).toISOString(),
        },
      })
      expect(pool.isRateLimited(row, 'gemini', model)).toBe(false)
      expect(pool.getCurrentOrNextForFamily('gemini', model)).toBe(row)
    })
  }

  it('issue69 a later dated empty reading walls through its own reset', () => {
    const { pool, advance, row } = manager(1)
    pool.markRateLimited(row, 60_000, 'gemini', model)
    advance(1)
    pool.updateQuotaCache(0, {
      gemini: {
        remainingFraction: 0,
        modelCount: 1,
        resetTime: new Date(start + long).toISOString(),
      },
    })
    expect(row.rateLimitResetTimes[key]).toBe(start + long)
    expect(pool.getCurrentOrNextForFamily('gemini', model)).toBeNull()
    expect(pool.getMinWaitTimeForFamily('gemini', model)).toBe(long - 1)
  })

  it('issue69 uses the account-specific Argon pool and leaves other pools marked', () => {
    const { pool, row, advance } = manager(0)
    const argon = 'gemini-4-argon-medium'
    row.cachedQuota = {
      gemini: { remainingFraction: 1, modelCount: 1 },
      'gemini-argon': { remainingFraction: 0, modelCount: 1 },
    }
    expect(
      pool.markRateLimitedWithReason(
        row,
        'gemini',
        argon,
        'QUOTA_EXHAUSTED',
        long,
      ),
    ).toBe(long)
    pool.markRateLimited(row, long, 'claude', 'claude-sonnet-5-5-low')
    pool.markRateLimited(row, long, 'gemini', model)
    advance(1)
    pool.updateQuotaCache(0, {
      gemini: { remainingFraction: 1, modelCount: 1 },
      'gemini-argon': { remainingFraction: 0, modelCount: 1 },
    })
    expect(pool.isRateLimited(row, 'gemini', model)).toBe(false)
    expect(pool.isRateLimited(row, 'gemini', argon)).toBe(true)
    expect(pool.isRateLimited(row, 'claude', 'claude-sonnet-5-5-low')).toBe(
      true,
    )
    pool.updateQuotaCache(0, {
      gemini: { remainingFraction: 1, modelCount: 1 },
    })
    expect(pool.isRateLimited(row, 'gemini', argon)).toBe(false)
    expect(
      pool.markRateLimitedWithReason(
        row,
        'gemini',
        argon,
        'QUOTA_EXHAUSTED',
        long,
      ),
    ).toBe(300_000)
  })
})

// ---------------------------------------------------------------------------
// Selection oracle
//
// One fixed scenario (clock, random sequence and pid all fixed) drives every
// selection, wait, toast, usage, cooldown, access and removal operation and
// records each observable output plus the selection state after each phase.
// `ORACLE_EXPECTED` below was recorded by running this scenario against the
// pool-file AccountManager at d0d3182a, before its selection state moved into
// AccountSelector; it is a fixed literal, not computed by the code under test.
// ---------------------------------------------------------------------------

const ORACLE_START = Date.UTC(2026, 9, 7, 12)
const MODEL = 'gemini-2.5-pro'
const FLASH = 'gemini-2.5-flash'
const TTL = 10 * 60 * 1000
const PID = 7

/** Six accounts in distinct states; account 3 is disabled. */
function oraclePool(): AccountStorageV4 {
  const t = ORACLE_START
  return {
    version: 4,
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 1 },
    accounts: [
      {
        refreshToken: 'r0',
        email: 'zero@example.test',
        addedAt: 10,
        lastUsed: 1_000,
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.9, modelCount: 1 },
          gemini: { remainingFraction: 0.8, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: t - 1_000,
      },
      {
        refreshToken: 'r1',
        email: 'one@example.test',
        addedAt: 11,
        lastUsed: 2_000,
        rateLimitResetTimes: { claude: t + 30_000 },
        cachedQuota: {
          gemini: {
            remainingFraction: 0.05,
            modelCount: 1,
            resetTime: new Date(t + 90_000).toISOString(),
          },
        },
        cachedQuotaUpdatedAt: t - 1_000,
      },
      {
        refreshToken: 'r2',
        addedAt: 12,
        lastUsed: 500,
        coolingDownUntil: t + 5_000,
        cooldownReason: 'network-error',
      },
      { refreshToken: 'r3', addedAt: 13, lastUsed: 0, enabled: false },
      {
        refreshToken: 'r4',
        addedAt: 14,
        lastUsed: 0,
        rateLimitResetTimes: { [`gemini-antigravity:${MODEL}`]: t + 10_000 },
      },
      {
        refreshToken: 'r5',
        email: 'five@example.test',
        addedAt: 15,
        lastUsed: 300,
        rateLimitResetTimes: { 'gemini-cli': t + 20_000 },
        // A quota reading older than the TTL: soft-quota checks ignore it, so
        // this nearly exhausted account stays selectable.
        cachedQuota: { gemini: { remainingFraction: 0.01, modelCount: 1 } },
        cachedQuotaUpdatedAt: t - 60 * 60 * 1000,
      },
    ],
  }
}

/** The fields of a pool row the scenario reads back. */
interface OracleRow {
  index: number
  enabled: boolean
  lastUsed: number
  rateLimitResetTimes: Record<string, number | undefined>
  touchedForQuota: Record<string, number>
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  consecutiveFailures?: number
  email?: string
  verificationRequired?: boolean
  verificationUrl?: string
  accountIneligible?: boolean
}

/** The selection API the scenario drives over rows of type `R`. */
interface OraclePool<R extends OracleRow> {
  readonly healthTracker: HealthScoreTracker
  readonly tokenTracker: TokenBucketTracker
  getAccounts(): R[]
  getCurrentOrNextForFamily(
    family: AccountModelFamily,
    model?: string | null,
    strategy?: AccountSelectionStrategy,
    pidOffsetEnabled?: boolean,
    softQuotaThresholdPercent?: number,
    softQuotaCacheTtlMs?: number,
    identity?: AccountSessionIdentity,
    excludeIndexes?: Set<number>,
  ): R | null
  getNextForFamily(
    family: AccountModelFamily,
    model?: string | null,
    softQuotaThresholdPercent?: number,
    softQuotaCacheTtlMs?: number,
    identity?: AccountSessionIdentity,
    excludeIndexes?: Set<number>,
  ): R | null
  getCurrentAccountForFamily(
    family: AccountModelFamily,
    identity?: AccountSessionIdentity,
  ): R | null
  getActiveIndexByFamily(
    identity?: AccountSessionIdentity,
  ): Record<AccountModelFamily, number>
  markRateLimited(
    account: R,
    retryAfterMs: number,
    family: AccountModelFamily,
    model?: string | null,
  ): void
  markRateLimitedWithReason(
    account: R,
    family: AccountModelFamily,
    model: string | null | undefined,
    reason: RateLimitReason,
    retryAfterMs?: number | null,
    failureTtlMs?: number,
  ): number
  markRequestSuccess(account: R): void
  clearAllRateLimitsForFamily(
    family: AccountModelFamily,
    model?: string | null,
  ): void
  shouldTryOptimisticReset(
    family: AccountModelFamily,
    model?: string | null,
  ): boolean
  getMinWaitTimeForFamily(
    family: AccountModelFamily,
    model?: string | null,
  ): number
  isRateLimited(
    account: R,
    family: AccountModelFamily,
    model?: string | null,
  ): boolean
  shouldShowAccountToast(accountIndex: number, debounceMs?: number): boolean
  markToastShown(accountIndex: number): void
  markSwitched(
    account: R,
    reason: 'rate-limit' | 'initial' | 'rotation',
    family: AccountModelFamily,
    identity?: AccountSessionIdentity,
  ): void
  recordRequest(accountIndex: number, family: AccountModelFamily): void
  markAccountUsed(accountIndex: number): void
  getDailyRequestCounts(accountIndex: number): unknown
  getTotalDailyRequests(family: AccountModelFamily): number
  getDailyRequestSummary(family: AccountModelFamily): unknown
  getSessionSummary(): unknown
  recordSessionUsage(
    accountIndex: number,
    identity?: AccountSessionIdentity,
  ): void
  wasUsedInSession(
    accountIndex: number,
    identity?: AccountSessionIdentity,
  ): boolean
  markAccountCoolingDown(
    account: R,
    cooldownMs: number,
    reason: CooldownReason,
  ): void
  isAccountCoolingDown(account: R): boolean
  getAccountCooldownReason(account: R): CooldownReason | undefined
  isFreshForQuota(account: R, quotaKey: string): boolean
  getFreshAccountsForQuota(
    quotaKey: string,
    family: AccountModelFamily,
    model?: string | null,
  ): R[]
  shouldProactivelyRotate(
    family: AccountModelFamily,
    model: string | null | undefined,
    thresholdPercent: number,
    cacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): boolean
  proactivelyRotateForFamily(
    family: AccountModelFamily,
    model: string | null | undefined,
    softQuotaThresholdPercent: number,
    softQuotaCacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): R | null
  isAccountOverSoftQuota(
    account: R,
    family: AccountModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): boolean
  areAllAccountsOverSoftQuota(
    family: AccountModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): boolean
  getMinWaitTimeForSoftQuota(
    family: AccountModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): number | null
  getOldestQuotaCacheAge(): number | null
  setAccountEnabled(accountIndex: number, enabled: boolean): boolean
  markAccountVerificationRequired(
    accountIndex: number,
    reason?: string,
    verifyUrl?: string,
  ): boolean
  markAccountIneligible(accountIndex: number, reason?: string): boolean
  clearAccountAccessBlocks(
    accountIndex: number,
    enableAccount?: boolean,
  ): boolean
  regenerateAccountFingerprint(accountIndex: number): unknown
  restoreAccountFingerprint(accountIndex: number, historyIndex: number): unknown
  getAccountFingerprintHistory(accountIndex: number): unknown[]
  removeAccount(account: R): boolean
  getAccountCount(): number
  getTotalAccountCount(): number
}

type Output = Array<[string, unknown]>

/**
 * Runs the scenario and returns every observable output in order.
 * `advance` moves the clock that both the pool and its trackers read.
 */
function runOracle<R extends OracleRow>(
  pool: OraclePool<R>,
  advance: (ms: number) => void,
  diagnostics: string[],
): Output {
  const out: Output = []
  const at = (index: number): R => {
    const row = pool.getAccounts()[index]
    if (row === undefined) throw new Error(`no row ${index}`)
    return row
  }
  const idx = (row: { index: number } | null) =>
    row === null ? null : row.index
  const root: AccountSessionIdentity = { id: 'root' }
  const child: AccountSessionIdentity = { id: 'child', parentId: 'root' }
  const offset: AccountSessionIdentity = { id: 'offset' }
  const sessions: AccountSessionIdentity[] = []
  const state = (label: string) => {
    out.push([
      `${label}: state`,
      {
        active: pool.getActiveIndexByFamily(),
        pins: sessions.map((session) => [
          session.id,
          pool.getActiveIndexByFamily(session),
        ]),
        rows: pool.getAccounts().map((row) => ({
          index: row.index,
          enabled: row.enabled,
          lastUsed: row.lastUsed,
          limits: Object.fromEntries(
            Object.entries(row.rateLimitResetTimes).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
          touched: Object.fromEntries(
            Object.entries(row.touchedForQuota).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
          cooldown: [row.coolingDownUntil ?? null, row.cooldownReason ?? null],
          failures: row.consecutiveFailures ?? null,
          verification: [
            row.verificationRequired ?? null,
            row.verificationUrl ?? null,
            row.accountIneligible ?? null,
          ],
        })),
        health: [0, 1, 2, 3, 4, 5].map((i) => pool.healthTracker.getScore(i)),
        tokens: [0, 1, 2, 3, 4, 5].map((i) => pool.tokenTracker.getTokens(i)),
        diagnostics: diagnostics.splice(0),
      },
    ])
  }
  const select = (
    label: string,
    ...args: Parameters<OraclePool<R>['getCurrentOrNextForFamily']>
  ) => {
    out.push([label, idx(pool.getCurrentOrNextForFamily(...args))])
  }

  // Sticky, with an account rate-limited and with a caller exclusion.
  select('sticky claude', 'claude')
  pool.markRateLimited(at(0), 60_000, 'claude')
  select('sticky claude after limit', 'claude')
  const claudeNow = pool.getActiveIndexByFamily().claude
  select(
    'sticky claude excluding current',
    'claude',
    null,
    'sticky',
    false,
    100,
    TTL,
    undefined,
    new Set([claudeNow]),
  )
  // Round-robin over model-specific and family-wide limits.
  out.push([
    'round-robin gemini model',
    [1, 2, 3, 4].map(() =>
      idx(pool.getCurrentOrNextForFamily('gemini', MODEL, 'round-robin')),
    ),
  ])
  out.push([
    'round-robin gemini family',
    [1, 2, 3].map(() =>
      idx(pool.getCurrentOrNextForFamily('gemini', null, 'round-robin')),
    ),
  ])
  state('after round-robin')

  // Hybrid with health and token differences, session and parent isolation.
  pool.healthTracker.recordFailure(0)
  pool.healthTracker.recordFailure(0)
  pool.tokenTracker.consume(1, 5)
  sessions.push(root, child)
  select('hybrid root', 'gemini', MODEL, 'hybrid', false, 100, TTL, root)
  select('hybrid child', 'gemini', MODEL, 'hybrid', false, 100, TTL, child)
  select(
    'hybrid global excluding 0 and 1',
    'gemini',
    MODEL,
    'hybrid',
    false,
    100,
    TTL,
    undefined,
    new Set([0, 1]),
  )
  state('after hybrid')

  // Exact session pinning until the pinned account becomes unavailable.
  select('root pinned', 'gemini', MODEL, 'sticky', false, 100, TTL, root)
  const pinned = pool.getCurrentAccountForFamily('gemini', root)
  if (pinned === null) throw new Error('root has no pin')
  pool.markRateLimited(pinned, 5_000, 'gemini', MODEL)
  select(
    'root after its pin is limited',
    'gemini',
    MODEL,
    'sticky',
    false,
    100,
    TTL,
    root,
  )
  select('child sticky', 'gemini', MODEL, 'sticky', false, 100, TTL, child)
  state('after pinning')

  // PID offset, once per session and family.
  sessions.push(offset)
  select('pid offset session', 'gemini', null, 'sticky', true, 100, TTL, offset)
  select(
    'pid offset session again',
    'gemini',
    null,
    'sticky',
    true,
    100,
    TTL,
    offset,
  )
  select('pid offset global', 'claude', null, 'sticky', true)
  state('after pid offset')

  // Soft quota: over-threshold accounts are skipped, cold ones pass.
  select('soft quota sticky', 'gemini', FLASH, 'sticky', false, 50, TTL)
  select(
    'soft quota round-robin',
    'gemini',
    FLASH,
    'round-robin',
    false,
    50,
    TTL,
  )
  out.push([
    'all over soft quota',
    [
      pool.areAllAccountsOverSoftQuota('gemini', 50, TTL, FLASH),
      pool.areAllAccountsOverSoftQuota('gemini', 1, TTL, FLASH),
      pool.areAllAccountsOverSoftQuota('claude', 100, TTL),
    ],
  ])
  out.push([
    'soft quota waits',
    [
      pool.getMinWaitTimeForSoftQuota('gemini', 50, TTL, FLASH),
      pool.getMinWaitTimeForSoftQuota('gemini', 1, TTL, FLASH),
      pool.getMinWaitTimeForSoftQuota('gemini', 1, TTL),
      pool.getMinWaitTimeForSoftQuota('claude', 1, TTL),
      pool.getMinWaitTimeForSoftQuota('claude', 100, TTL),
    ],
  ])
  out.push([
    'over soft quota',
    pool
      .getAccounts()
      .map((row) => pool.isAccountOverSoftQuota(row, 'gemini', 50, TTL, FLASH)),
  ])
  out.push(['oldest quota age', pool.getOldestQuotaCacheAge()])

  out.push([
    'waits',
    [
      pool.getMinWaitTimeForFamily('claude'),
      pool.getMinWaitTimeForFamily('gemini', MODEL),
    ],
  ])
  out.push([
    'rate limits',
    pool
      .getAccounts()
      .map((row) => [
        pool.isRateLimited(row, 'gemini', MODEL),
        pool.isRateLimited(row, 'claude'),
      ]),
  ])

  // Toast debounce.
  out.push(['toast 1', pool.shouldShowAccountToast(1)])
  pool.markToastShown(1)
  advance(1_000)
  out.push([
    'toast after shown',
    [
      pool.shouldShowAccountToast(1),
      pool.shouldShowAccountToast(2),
      pool.shouldShowAccountToast(1, 500),
    ],
  ])

  // Backoff with consecutive failures, then a success.
  out.push([
    'backoff',
    [
      pool.markRateLimitedWithReason(
        at(4),
        'claude',
        null,
        'MODEL_CAPACITY_EXHAUSTED',
        null,
      ),
      pool.markRateLimitedWithReason(
        at(4),
        'claude',
        null,
        'QUOTA_EXHAUSTED',
        null,
      ),
      pool.markRateLimitedWithReason(
        at(5),
        'gemini',
        MODEL,
        'RATE_LIMIT_EXCEEDED',
        4_000,
      ),
    ],
  ])
  state('after backoff')
  pool.markRequestSuccess(at(4))

  // Usage and session statistics.
  pool.recordRequest(0, 'claude')
  pool.recordRequest(0, 'claude')
  pool.recordRequest(4, 'gemini')
  pool.markAccountUsed(2)
  out.push([
    'daily counts',
    [
      pool.getDailyRequestCounts(0),
      pool.getDailyRequestCounts(4),
      pool.getDailyRequestCounts(3),
    ],
  ])
  out.push([
    'daily totals',
    [
      pool.getTotalDailyRequests('claude'),
      pool.getTotalDailyRequests('gemini'),
    ],
  ])
  out.push(['daily summary', pool.getDailyRequestSummary('claude')])
  out.push(['session summary', pool.getSessionSummary()])
  pool.recordSessionUsage(2, root)
  pool.recordSessionUsage(5)
  out.push([
    'session usage',
    [
      pool.wasUsedInSession(2, root),
      pool.wasUsedInSession(2),
      pool.wasUsedInSession(5),
    ],
  ])
  out.push([
    'next prefers session-used',
    idx(pool.getNextForFamily('gemini', null, 100, TTL, root)),
  ])
  state('after usage')

  // Cooldown set, read, and expired by the clock.
  pool.markAccountCoolingDown(at(4), 2_000, 'auth-failure')
  out.push([
    'cooling',
    [pool.isAccountCoolingDown(at(4)), pool.getAccountCooldownReason(at(4))],
  ])
  advance(3_000)
  out.push([
    'cooling later',
    [
      pool.isAccountCoolingDown(at(4)),
      pool.getAccountCooldownReason(at(2)),
      pool.getAccountCount(),
      pool.getTotalAccountCount(),
    ],
  ])
  advance(2_000)
  out.push(['cooling 2 expired', pool.isAccountCoolingDown(at(2))])

  // Quota freshness and proactive rotation.
  out.push([
    'fresh',
    [
      pool.isFreshForQuota(at(0), 'claude'),
      pool.isFreshForQuota(at(4), 'claude'),
      pool.getFreshAccountsForQuota('claude', 'claude').map(idx),
      pool
        .getFreshAccountsForQuota(
          `gemini-antigravity:${MODEL}`,
          'gemini',
          MODEL,
        )
        .map(idx),
    ],
  ])
  out.push([
    'should rotate',
    [
      pool.shouldProactivelyRotate('gemini', MODEL, 50, TTL, root),
      pool.shouldProactivelyRotate('gemini', FLASH, 90, TTL),
      pool.shouldProactivelyRotate('claude', null, 95, TTL),
    ],
  ])
  out.push([
    'proactive rotate',
    [
      idx(pool.proactivelyRotateForFamily('gemini', MODEL, 100, TTL, root)),
      idx(pool.proactivelyRotateForFamily('claude', null, 100, TTL)),
    ],
  ])
  out.push(['optimistic reset', pool.shouldTryOptimisticReset('claude')])
  pool.clearAllRateLimitsForFamily('gemini', MODEL)
  state('after proactive rotation and clearing')

  // Explicit switches, including a child session's.
  pool.markSwitched(at(2), 'rotation', 'claude', child)
  pool.markSwitched(at(0), 'rate-limit', 'gemini')
  state('after switches')

  // Enable flags and access verdicts move the selection off an account.
  const geminiActive = pool.getActiveIndexByFamily().gemini
  out.push([
    'disable gemini active',
    [geminiActive, pool.setAccountEnabled(geminiActive, false)],
  ])
  out.push([
    'access verdicts',
    [
      pool.markAccountVerificationRequired(5, ' verify ', ' https://verify '),
      pool.markAccountIneligible(2, ''),
      pool.setAccountEnabled(2, true),
      pool.clearAccountAccessBlocks(2, true),
      pool.clearAccountAccessBlocks(9),
      pool.setAccountEnabled(9, true),
    ],
  ])
  state('after access verdicts')

  // Fingerprints: the values are random, so only their presence and history.
  out.push([
    'fingerprints',
    [
      pool.regenerateAccountFingerprint(0) !== null,
      pool.getAccountFingerprintHistory(0).length,
      pool.restoreAccountFingerprint(0, 0) !== null,
      pool.getAccountFingerprintHistory(0).length,
      pool.restoreAccountFingerprint(0, 99),
      pool.regenerateAccountFingerprint(9),
    ],
  ])

  // Removal of account 1 remaps pins, cursors and selection.
  out.push(['remove 1', pool.removeAccount(at(1))])
  out.push([
    'rows after removal',
    pool.getAccounts().map((row) => [row.index, row.email ?? null]),
  ])
  out.push([
    'after removal',
    [
      idx(pool.getCurrentAccountForFamily('claude', root)),
      idx(pool.getCurrentAccountForFamily('gemini', child)),
      pool.wasUsedInSession(1, root),
      pool.shouldShowAccountToast(1),
    ],
  ])
  out.push(['session summary after removal', pool.getSessionSummary()])
  select('sticky claude after removal', 'claude')
  out.push([
    'round-robin after removal',
    [1, 2, 3].map(() =>
      idx(pool.getCurrentOrNextForFamily('gemini', null, 'round-robin')),
    ),
  ])
  state('after removal')

  // The only enabled account is never blocked by soft quota.
  for (const row of pool.getAccounts()) {
    pool.setAccountEnabled(row.index, row.index === 0)
  }
  pool.clearAllRateLimitsForFamily('gemini', FLASH)
  out.push([
    'single enabled',
    [
      idx(
        pool.getCurrentOrNextForFamily(
          'gemini',
          FLASH,
          'sticky',
          false,
          1,
          TTL,
        ),
      ),
      pool.isAccountOverSoftQuota(at(0), 'gemini', 1, TTL, FLASH),
      pool.getMinWaitTimeForSoftQuota('gemini', 1, TTL, FLASH),
      pool.areAllAccountsOverSoftQuota('gemini', 1, TTL, FLASH),
    ],
  ])
  state('single enabled')
  return out
}

/** A deterministic random sequence. */
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function memoryStore(): AccountStorageStore {
  let state: AccountStorageV4 | null = null
  return {
    load: async () => state,
    saveMerged: async (_path, next) => {
      state = next
      return next
    },
    mutate: async (_path, fn) => {
      const current = state ?? { version: 4, accounts: [], activeIndex: 0 }
      state = (await fn(current)) ?? current
      return state
    },
    clear: async () => {
      state = null
    },
  }
}

/** Runs the scenario through a pool-file AccountManager. */
async function runManagerOracle(): Promise<Output> {
  let clock = ORACLE_START
  const now = () => clock
  const diagnostics: string[] = []
  const manager = new AccountManager(undefined, oraclePool(), {
    store: memoryStore(),
    now,
    random: seededRandom(42),
    pid: PID,
    healthTracker: new HealthScoreTracker({}, now),
    tokenTracker: new TokenBucketTracker({}, now),
    onDiagnostic: (message) => diagnostics.push(message),
  })
  try {
    return runOracle(
      manager,
      (ms) => {
        clock += ms
      },
      diagnostics,
    )
  } finally {
    await manager.dispose()
  }
}

/**
 * Fixed-clock selection transcript for a single account/family/model quota pool.
 * Legacy style keys remain in the rows as inert persisted data.
 */
// biome-ignore format: a recorded literal, one output per line
const ORACLE_EXPECTED: Output = [
  ["sticky claude",0],
  ["sticky claude after limit",4],
  ["sticky claude excluding current",5],
  ["round-robin gemini model",[1,4,5,0]],
  ["round-robin gemini family",[1,4,5]],
  ["after round-robin: state",{"active":{"claude":5,"gemini":5},"pins":[],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":0,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[70,70,70,70,70,70],"tokens":[50,50,50,50,50,50],"diagnostics":[]}],
  ["hybrid root",4],
  ["hybrid child",5],
  ["hybrid global excluding 0 and 1",4],
  ["after hybrid: state",{"active":{"claude":5,"gemini":4},"pins":[["root",{"claude":-1,"gemini":4}],["child",{"claude":-1,"gemini":5}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45,50,50,50,50],"diagnostics":[]}],
  ["root pinned",4],
  ["root after its pin is limited",5],
  ["child sticky",5],
  ["after pinning: state",{"active":{"claude":5,"gemini":5},"pins":[["root",{"claude":-1,"gemini":5}],["child",{"claude":-1,"gemini":5}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45,50,50,50,50],"diagnostics":[]}],
  ["pid offset session",4],
  ["pid offset session again",4],
  ["pid offset global",4],
  ["after pid offset: state",{"active":{"claude":4,"gemini":4},"pins":[["root",{"claude":-1,"gemini":5}],["child",{"claude":-1,"gemini":5}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45,50,50,50,50],"diagnostics":["Applying PID account offset","Applying PID account offset"]}],
  ["soft quota sticky",4],
  ["soft quota round-robin",0],
  ["all over soft quota",[false,false,false]],
  ["soft quota waits",[0,0,0,0,0]],
  ["over soft quota",[false,true,false,false,false,false]],
  ["oldest quota age",null],
  ["waits",[0,0]],
  ["rate limits",[[false,true],[false,true],[false,false],[false,false],[true,false],[false,false]]],
  ["toast 1",true],
  ["toast after shown",[false,true,true]],
  ["backoff",[47469.227691181004,300000,4000]],
  ["after backoff: state",{"active":{"claude":4,"gemini":0},"pins":[["root",{"claude":-1,"gemini":5}],["child",{"claude":-1,"gemini":5}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":2,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000,"gemini:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":1,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.1,50,50,50,50],"diagnostics":[]}],
  ["daily counts",[{"date":"2026-10-07","claude":2,"gemini":0},{"date":"2026-10-07","claude":0,"gemini":1},null]],
  ["daily totals",[2,1]],
  ["daily summary",[{"index":0,"email":"zero@example.test","count":2}]],
  ["session summary",{"durationMinutes":0,"totalClaude":2,"totalGemini":1,"requestsPerHour":10800,"accountsUsed":2,"perAccount":[{"index":0,"email":"zero@example.test","claude":2,"gemini":0},{"index":4,"claude":0,"gemini":1}]}],
  ["session usage",[true,false,true]],
  ["next prefers session-used",1],
  ["after usage: state",{"active":{"claude":4,"gemini":0},"pins":[["root",{"claude":-1,"gemini":5}],["child",{"claude":-1,"gemini":5}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000,"gemini:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":1,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.1,50,50,50,50],"diagnostics":[]}],
  ["cooling",[true,"auth-failure"]],
  ["cooling later",[false,"network-error",5,6]],
  ["cooling 2 expired",false],
  ["fresh",[true,true,[2],[0,1,2,4,5]]],
  ["should rotate",[false,true,false]],
  ["proactive rotate",[2,5]],
  ["optimistic reset",false],
  ["after proactive rotation and clearing: state",{"active":{"claude":5,"gemini":2},"pins":[["root",{"claude":-1,"gemini":2}],["child",{"claude":-1,"gemini":5}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"gemini:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["after switches: state",{"active":{"claude":5,"gemini":0},"pins":[["root",{"claude":-1,"gemini":2}],["child",{"claude":2,"gemini":5}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"gemini:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["disable gemini active",[0,true]],
  ["access verdicts",[true,true,false,true,false,false]],
  ["after access verdicts: state",{"active":{"claude":1,"gemini":1},"pins":[["root",{"claude":-1,"gemini":2}],["child",{"claude":2,"gemini":5}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":false,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"gemini:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[false,null,false]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":false,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[true,"https://verify",null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["fingerprints",[true,1,true,2,null,null]],
  ["remove 1",true],
  ["rows after removal",[[0,"zero@example.test"],[1,null],[2,null],[3,null],[4,"five@example.test"]]],
  ["after removal",[null,null,true,true]],
  ["session summary after removal",{"durationMinutes":0,"totalClaude":2,"totalGemini":1,"requestsPerHour":1800,"accountsUsed":2,"perAccount":[{"index":0,"email":"zero@example.test","claude":2,"gemini":0},{"index":3,"claude":0,"gemini":1}]}],
  ["sticky claude after removal",1],
  ["round-robin after removal",[1,3,1]],
  ["after removal: state",{"active":{"claude":1,"gemini":1},"pins":[["root",{"claude":-1,"gemini":1}],["child",{"claude":1,"gemini":4}],["offset",{"claude":-1,"gemini":3}]],"rows":[{"index":0,"enabled":false,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"claude":1791374406000,"gemini":1791374406000,"gemini:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[false,null,false]},{"index":2,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374406000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":false,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[true,"https://verify",null]}],"health":[30,70,70,70,70,70],"tokens":[50,50,50,50,50,50],"diagnostics":[]}],
  ["single enabled",[0,false,0,false]],
  ["single enabled: state",{"active":{"claude":0,"gemini":0},"pins":[["root",{"claude":-1,"gemini":1}],["child",{"claude":1,"gemini":4}],["offset",{"claude":-1,"gemini":3}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini:gemini-2.5-flash":1791374406000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":false,"lastUsed":1791374401000,"limits":{},"touched":{"claude":1791374406000,"gemini":1791374406000,"gemini:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[false,null,false]},{"index":2,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini":1791374406000,"gemini:gemini-2.5-flash":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":false,"lastUsed":1791374400000,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini":1791374400000,"gemini:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[true,"https://verify",null]}],"health":[30,70,70,70,70,70],"tokens":[50,50,50,50,50,50],"diagnostics":[]}],
]

const ORACLE_FINGERPRINT = {
  deviceId: 'device-oracle',
  sessionToken: 'session-oracle',
  userAgent: 'antigravity-cli/test',
  apiClient: 'antigravity-cli',
  clientMetadata: { ideType: 'IDE', platform: 'darwin', pluginType: 'GEMINI' },
  createdAt: 1,
}

/**
 * The oracle pool as bare selector rows: the same selection metadata the
 * manager loads, with no credential, project or ref field.
 */
function oracleRows(): SelectableAccount[] {
  return oraclePool().accounts.map((stored, index) => ({
    index,
    enabled: stored.enabled !== false,
    lastUsed: stored.lastUsed,
    rateLimitResetTimes: { ...stored.rateLimitResetTimes },
    coolingDownUntil: stored.coolingDownUntil,
    cooldownReason: stored.cooldownReason,
    touchedForQuota: {},
    cachedQuota: stored.cachedQuota,
    cachedQuotaUpdatedAt: stored.cachedQuotaUpdatedAt,
    email: stored.email,
    fingerprint: { ...ORACLE_FINGERPRINT },
    fingerprintHistory: [],
  }))
}

/** Runs the scenario through a bare selector over `oracleRows()`. */
function runSelectorOracle(sink: SelectionSink<SelectableAccount> = {}) {
  let clock = ORACLE_START
  const now = () => clock
  const diagnostics: string[] = []
  const selector = new AccountSelector<SelectableAccount>({
    sink: {
      ...sink,
      stale: (_row, label) =>
        diagnostics.push(
          `Account ${label} ignored: the account is no longer loaded`,
        ),
    },
    now,
    random: seededRandom(42),
    pid: PID,
    healthTracker: new HealthScoreTracker({}, now),
    tokenTracker: new TokenBucketTracker({}, now),
    onDiagnostic: (message) => diagnostics.push(message),
  })
  selector.resetAccounts(oracleRows(), { claude: 0, gemini: 1 })
  const out = runOracle(
    selector,
    (ms) => {
      clock += ms
    },
    diagnostics,
  )
  return { out, selector }
}

const CREDENTIAL_KEYS = [
  'parts',
  'refreshToken',
  'access',
  'accessToken',
  'expires',
  'projectId',
  'managedProjectId',
  'ref',
]

describe('selection oracle', () => {
  it('the pool-file manager reproduces the recorded outputs', async () => {
    expect(await runManagerOracle()).toEqual(ORACLE_EXPECTED)
  })

  it('a bare selector over credential-free rows reproduces them too', () => {
    const output = runSelectorOracle().out
    expect(output).toEqual(ORACLE_EXPECTED)
    const entry = (label: string) =>
      output.find(([name]) => name === label)?.[1]
    expect(entry('after removal')).toEqual([null, null, true, true])
    expect(
      (entry('after removal: state') as { tokens: number[] }).tokens[1],
    ).toBe(50)
    expect(
      (
        entry('session summary after removal') as {
          perAccount: Array<{
            index: number
            email?: string
            claude: number
            gemini: number
          }>
        }
      ).perAccount[1],
    ).toEqual({ index: 3, claude: 0, gemini: 1 })
  })
})

describe('AccountSelector over credential-free rows', () => {
  it('holds, snapshots and reports rows that carry no credential', () => {
    const reported: unknown[] = []
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        reported.push([name, ...args])
    const { selector } = runSelectorOracle({
      rateLimit: record('rateLimit'),
      cooldown: record('cooldown'),
      switched: record('switched'),
      lastUsed: record('lastUsed'),
      selection: record('selection'),
      usage: record('usage'),
      enabled: record('enabled'),
      accessVerdict: record('accessVerdict'),
      fingerprint: record('fingerprint'),
    })
    const rows = [...selector.getAccounts(), ...selector.getAccountsSnapshot()]
    expect(rows.length).toBeGreaterThan(0)
    expect(reported.length).toBeGreaterThan(0)
    for (const row of rows) {
      for (const key of CREDENTIAL_KEYS)
        expect(Object.hasOwn(row, key)).toBe(false)
    }
    for (const call of reported) {
      for (const key of CREDENTIAL_KEYS) {
        expect(JSON.stringify(call)).not.toContain(`"${key}"`)
      }
    }
    // A snapshot copies the rows and their rate-limit maps.
    const [live] = selector.getAccounts()
    const [copy] = selector.getAccountsSnapshot()
    expect(copy).toEqual(live)
    expect(copy).not.toBe(live)
    expect(copy?.rateLimitResetTimes).not.toBe(live?.rateLimitResetTimes)
  })
})

/**
 * A vault roster row: genuine route and credential metadata plus the
 * selection fields, and nothing a send could authenticate with.
 */
interface VaultRow extends SelectableAccount {
  readonly routeId: string
  readonly credentialId: string
  readonly accountIdentity: string
}

/** A vault row's identity: its route, credential and account together. */
const vaultKey = (row: VaultRow) =>
  JSON.stringify([row.routeId, row.credentialId, row.accountIdentity])

function vaultRow(
  routeId: string,
  overrides: Partial<VaultRow> = {},
): VaultRow {
  return {
    routeId,
    credentialId: `cred-${routeId}`,
    accountIdentity: `acct-${routeId}`,
    index: 0,
    enabled: true,
    lastUsed: 0,
    rateLimitResetTimes: {},
    touchedForQuota: {},
    ...overrides,
  }
}

describe('AccountSelector membership', () => {
  const start = Date.UTC(2026, 9, 7, 12)
  const session: AccountSessionIdentity = { id: 'session' }

  function vaultPool() {
    const now = () => start
    const stale: string[] = []
    const reported: Array<[string, VaultRow]> = []
    const selector = new AccountSelector<VaultRow>({
      now,
      healthTracker: new HealthScoreTracker({}, now),
      tokenTracker: new TokenBucketTracker({}, now),
      sink: {
        rateLimit: (row) => reported.push(['rateLimit', row]),
        switched: (row) => reported.push(['switched', row]),
        selection: (_family, row) => {
          if (row !== null) reported.push(['selection', row])
        },
        stale: (row, label) => stale.push(`${row.routeId} ${label}`),
      },
    })
    const rows = [vaultRow('a'), vaultRow('b'), vaultRow('c')]
    selector.replaceAccounts(rows, { keyOf: vaultKey })
    const [a, b, c] = rows
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('three rows expected')
    }
    return { selector, stale, reported, a, b, c }
  }

  it('keeps a vault row, its pins and trackers while route, credential and account match', () => {
    const { selector, b } = vaultPool()
    selector.markSwitched(b, 'rotation', 'gemini', session)
    selector.markTouchedForQuota(b, 'gemini-antigravity')
    selector.healthTracker.recordFailure(1)
    selector.tokenTracker.consume(1, 4)
    const score = selector.healthTracker.getScore(1)

    // A newer roster read, reordered; served record versions are send
    // attribution and are not part of a row.
    const { added, removed } = selector.replaceAccounts(
      [vaultRow('c'), vaultRow('b'), vaultRow('a')],
      { keyOf: vaultKey },
    )

    expect(added).toEqual([])
    expect(removed).toEqual([])
    expect(selector.getAccounts()[1]).toBe(b)
    expect(selector.getCurrentAccountForFamily('gemini', session)).toBe(b)
    expect(b.touchedForQuota['gemini-antigravity']).toBe(start)
    expect(selector.healthTracker.getScore(1)).toBe(score)
    expect(selector.tokenTracker.getTokens(1)).toBe(46)
  })

  it('admits another credential or account on the same route as a new member', () => {
    for (const change of [
      { credentialId: 'cred-b2' },
      { accountIdentity: 'acct-b2' },
    ]) {
      const { selector, b } = vaultPool()
      selector.markSwitched(b, 'rotation', 'gemini', session)
      selector.markSwitched(b, 'rotation', 'claude')
      selector.recordSessionUsage(1, session)
      selector.markToastShown(1)
      selector.healthTracker.recordFailure(1)
      selector.tokenTracker.consume(1, 4)
      const successor = vaultRow('b', change)

      const { added, removed } = selector.replaceAccounts(
        [vaultRow('a'), successor, vaultRow('c')],
        { keyOf: vaultKey },
      )

      expect(added).toEqual([successor])
      expect(removed).toEqual([b])
      expect(selector.getAccounts()[1]).toBe(successor)
      // Nothing of b passes to the row that took its index.
      expect(selector.getCurrentAccountForFamily('gemini', session)).toBeNull()
      expect(selector.getActiveIndexByFamily().claude).toBe(-1)
      expect(selector.wasUsedInSession(1, session)).toBe(false)
      expect(selector.shouldShowAccountToast(1)).toBe(true)
      expect(selector.healthTracker.getScore(1)).toBe(
        new HealthScoreTracker().getScore(1),
      )
      expect(selector.tokenTracker.getTokens(1)).toBe(50)
    }
  })

  it('refreshes a kept row from its roster row without keeping stale metadata', () => {
    const { selector, b } = vaultPool()
    b.enabled = false
    b.coolingDownUntil = start + 60_000
    b.cooldownReason = 'network-error'
    b.cachedQuota = { gemini: { remainingFraction: 0.1, modelCount: 1 } }
    b.cachedQuotaUpdatedAt = start - 1_000
    b.verificationRequired = true
    b.lastUsed = start
    b.consecutiveFailures = 2
    selector.markTouchedForQuota(b, 'claude')
    selector.markRateLimited(b, 30_000, 'claude')

    selector.replaceAccounts(
      [
        vaultRow('a'),
        vaultRow('b', {
          enabled: true,
          lastUsed: start - 5_000,
          email: 'b@example.test',
          rateLimitResetTimes: { 'gemini-cli': start + 10_000 },
          cachedQuota: { gemini: { remainingFraction: 0.9, modelCount: 1 } },
          cachedQuotaUpdatedAt: start,
        }),
        vaultRow('c'),
      ],
      { keyOf: vaultKey },
    )

    expect(selector.getAccounts()[1]).toBe(b)
    expect(b.enabled).toBe(true)
    expect(b.email).toBe('b@example.test')
    expect(b.cachedQuota?.gemini?.remainingFraction).toBe(0.9)
    expect(b.cachedQuotaUpdatedAt).toBe(start)
    for (const key of [
      'coolingDownUntil',
      'cooldownReason',
      'verificationRequired',
    ]) {
      expect(Object.hasOwn(b, key)).toBe(false)
    }
    // In-memory bookkeeping and newer local observations stay.
    expect(b.lastUsed).toBe(start)
    expect(b.consecutiveFailures).toBe(2)
    expect(b.touchedForQuota.claude).toBe(start)
    expect(b.rateLimitResetTimes).toEqual({
      claude: start + 30_000,
      'gemini-cli': start + 10_000,
    })
  })

  it('never applies a transition about a removed row to the row at its old index', () => {
    const { selector, stale, reported, a, b, c } = vaultPool()
    selector.markSwitched(a, 'rotation', 'claude')
    selector.replaceAccounts([vaultRow('a'), vaultRow('c')], {
      keyOf: vaultKey,
    })
    reported.length = 0

    selector.markSwitched(b, 'rate-limit', 'claude', session)
    selector.markRateLimited(b, 1_000, 'claude')
    selector.markAccountCoolingDown(b, 1_000, 'auth-failure')
    selector.setEnabledInMemory(b, false)

    expect(selector.getActiveIndexByFamily()).toEqual({ claude: 0, gemini: -1 })
    expect(selector.getActiveIndexByFamily(session).claude).toBe(-1)
    expect(c.index).toBe(1)
    expect(c.enabled).toBe(true)
    expect(c.rateLimitResetTimes).toEqual({})
    expect(reported).toEqual([])
    expect(stale).toEqual(['b switch', 'b state change'])
    expect(selector.removeAccount(b)).toBe(false)
  })

  it('matches rows by object identity when given the rows as keys', () => {
    const now = () => start
    const selector = new AccountSelector<SelectableAccount>({ now })
    const rows = oracleRows().slice(0, 3)
    selector.resetAccounts(rows, { claude: 2, gemini: 0 })
    const [r0, r1, r2] = rows
    if (r0 === undefined || r1 === undefined || r2 === undefined) {
      throw new Error('three rows expected')
    }
    selector.markSwitched(r1, 'rotation', 'gemini', session)
    selector.healthTracker.recordFailure(1)
    const score = selector.healthTracker.getScore(1)
    // A structurally equal copy is a different member under object keys.
    const copy = { ...r0, touchedForQuota: {} }

    const { added, removed } = selector.replaceAccounts([r2, r1, copy], {
      keyOf: (row) => row,
    })

    expect(selector.getAccounts()).toEqual([r2, r1, copy])
    expect(added).toEqual([copy])
    expect(removed).toEqual([r0])
    expect(selector.getCurrentAccountForFamily('gemini', session)).toBe(r1)
    expect(selector.healthTracker.getScore(1)).toBe(score)
    // Both selections followed their rows: r2 to 0, r1 (a root pin) to 1.
    expect(selector.getActiveIndexByFamily()).toEqual({ claude: 0, gemini: 1 })
  })

  it('keeps independent selectors independent and never reindexes a shared tracker', () => {
    const first = new AccountSelector<SelectableAccount>()
    const second = new AccountSelector<SelectableAccount>()
    first.healthTracker.recordFailure(0)
    expect(second.healthTracker).not.toBe(first.healthTracker)
    expect(second.healthTracker.getScore(0)).toBeGreaterThan(
      first.healthTracker.getScore(0),
    )

    const shared = new HealthScoreTracker()
    shared.recordFailure(0)
    const score = shared.getScore(0)
    const borrowing = new AccountSelector<SelectableAccount>({
      healthTracker: () => shared,
    })
    const rows = oracleRows().slice(0, 2)
    borrowing.resetAccounts(rows)
    borrowing.replaceAccounts([...rows].reverse(), { keyOf: (row) => row })
    expect(borrowing.healthTracker).toBe(shared)
    expect(shared.getScore(0)).toBe(score)
  })
})

describe('gemini-argon quota routing', () => {
  const ARGON_NOW = Date.UTC(2026, 9, 21, 12)
  const ARGON_TTL = 10 * 60 * 1000
  const ARGON_MODEL = 'gemini-4-argon-medium'
  const FLASH_MODEL = 'gemini-3.8-flash-medium'
  const ARGON_RESET = new Date(ARGON_NOW + 7 * 24 * 60 * 60_000).toISOString()

  function argonRow(
    index: number,
    cachedQuota: SelectableAccount['cachedQuota'],
  ): SelectableAccount {
    return {
      index,
      enabled: true,
      lastUsed: 0,
      rateLimitResetTimes: {},
      touchedForQuota: {},
      cachedQuota,
      cachedQuotaUpdatedAt: ARGON_NOW,
    }
  }

  function freshGemini(fraction: number) {
    return {
      gemini: {
        remainingFraction: fraction,
        modelCount: 2,
        resetTime: ARGON_RESET,
      },
      'non-gemini': {
        remainingFraction: 0.9,
        modelCount: 1,
        resetTime: ARGON_RESET,
      },
    }
  }

  const withArgon = () => ({
    ...freshGemini(1),
    'gemini-argon': {
      remainingFraction: 1,
      modelCount: 1,
      resetTime: ARGON_RESET,
    },
  })

  for (const strategy of ['sticky', 'round-robin', 'hybrid'] as const) {
    it(`Argon preference: ${strategy} tries a dated reporting account before a non-reporter`, () => {
      const selector = new AccountSelector({ now: () => ARGON_NOW })
      const free = argonRow(0, freshGemini(1))
      const pro = argonRow(1, withArgon())
      free.lastUsed = ARGON_NOW - 3_600_000
      pro.lastUsed = ARGON_NOW
      selector.resetAccounts([free, pro], { gemini: 0, claude: 0 })
      // Hybrid's score and global stickiness both favour the free account;
      // capability is a candidate-group preference, not a score bonus.
      expect(
        selector.getCurrentOrNextForFamily('gemini', ARGON_MODEL, strategy)
          ?.index,
      ).toBe(1)
    })
  }

  it('Argon preference: hybrid still scores within the reporting group', () => {
    const selector = new AccountSelector({ now: () => ARGON_NOW })
    const rows = [
      argonRow(0, freshGemini(1)),
      argonRow(1, withArgon()),
      argonRow(2, withArgon()),
    ]
    rows[0]!.lastUsed = ARGON_NOW - 3_600_000
    rows[1]!.lastUsed = ARGON_NOW
    rows[2]!.lastUsed = ARGON_NOW - 3_600_000
    selector.resetAccounts(rows, { gemini: 0, claude: 0 })
    expect(
      selector.getCurrentOrNextForFamily('gemini', ARGON_MODEL, 'hybrid')
        ?.index,
    ).toBe(2)
  })

  it('Argon preference: unknown quota remains a fallback and undated pools do not lead', () => {
    const selector = new AccountSelector({ now: () => ARGON_NOW })
    const unknown = argonRow(0, undefined)
    const undated = argonRow(1, withArgon())
    delete undated.cachedQuotaUpdatedAt
    const pro = argonRow(2, withArgon())
    selector.resetAccounts([unknown, undated, pro], { gemini: 0, claude: 0 })
    expect(
      selector.getCurrentOrNextForFamily('gemini', ARGON_MODEL)?.index,
    ).toBe(2)
    pro.coolingDownUntil = ARGON_NOW + 60_000
    // Selecting Pro advanced the existing cursor. With Pro unavailable, the
    // undated row comes next, then the account with no quota reading at all.
    expect(selector.getNextForFamily('gemini', ARGON_MODEL)?.index).toBe(1)
    expect(selector.getNextForFamily('gemini', ARGON_MODEL)?.index).toBe(0)
  })

  it('Argon preference: non-Argon models and pools without reporters retain their order', () => {
    for (const strategy of ['sticky', 'round-robin', 'hybrid'] as const) {
      for (const model of [ARGON_MODEL, FLASH_MODEL, 'claude-sonnet-5-5-low']) {
        const selector = new AccountSelector({ now: () => ARGON_NOW })
        selector.resetAccounts(
          [
            argonRow(0, freshGemini(1)),
            argonRow(1, model === ARGON_MODEL ? undefined : withArgon()),
          ],
          { gemini: 0, claude: 0 },
        )
        const family = model.includes('claude') ? 'claude' : 'gemini'
        expect(
          selector.getCurrentOrNextForFamily(family, model, strategy)?.index,
        ).toBe(0)
      }
    }
  })

  it('Argon preference: existing session pins remain until explicitly excluded', () => {
    const selector = new AccountSelector({ now: () => ARGON_NOW })
    selector.resetAccounts([
      argonRow(0, freshGemini(1)),
      argonRow(1, withArgon()),
    ])
    const session = { id: 'pinned-free' }
    expect(
      selector.getCurrentOrNextForFamily(
        'gemini',
        FLASH_MODEL,
        'sticky',
        false,
        100,
        ARGON_TTL,
        session,
      )?.index,
    ).toBe(0)
    expect(
      selector.getCurrentOrNextForFamily(
        'gemini',
        ARGON_MODEL,
        'hybrid',
        false,
        100,
        ARGON_TTL,
        session,
      )?.index,
    ).toBe(0)
    expect(
      selector.getCurrentOrNextForFamily(
        'gemini',
        ARGON_MODEL,
        'hybrid',
        false,
        100,
        ARGON_TTL,
        session,
        new Set([0]),
      )?.index,
    ).toBe(1)
  })

  it('skips an argon-exhausted Pro account for argon but serves gemini from it', () => {
    const selector = new AccountSelector<SelectableAccount>({
      now: () => ARGON_NOW,
    })
    selector.resetAccounts([
      // Paid Pro account: Argon weekly allowance exhausted, Gemini fresh.
      argonRow(0, {
        ...freshGemini(0.9),
        'gemini-argon': {
          remainingFraction: 0,
          modelCount: 1,
          resetTime: ARGON_RESET,
        },
      }),
      argonRow(1, freshGemini(0.9)),
    ])
    const [pro] = selector.getAccounts()
    if (!pro) throw new Error('missing Pro row')
    // The Argon request sees the exhausted Argon pool and skips the account.
    expect(
      selector.isAccountOverSoftQuota(
        pro,
        'gemini',
        50,
        ARGON_TTL,
        ARGON_MODEL,
      ),
    ).toBe(true)
    // The same account still serves an ordinary Gemini request.
    expect(
      selector.isAccountOverSoftQuota(
        pro,
        'gemini',
        50,
        ARGON_TTL,
        FLASH_MODEL,
      ),
    ).toBe(false)
    // Selection routes the Argon request to the other account.
    expect(
      selector.getNextForFamily('gemini', ARGON_MODEL, 50, ARGON_TTL)?.index,
    ).toBe(1)
  })

  it('counts argon against the gemini pool on accounts without the argon bucket', () => {
    const selector = new AccountSelector<SelectableAccount>({
      now: () => ARGON_NOW,
    })
    // Ultra-shaped account (Ultra plans report no Argon bucket, so the
    // request cannot see an Argon pool here): exhausted Gemini pool.
    const exhausted = argonRow(0, freshGemini(0))
    const fresh = argonRow(1, freshGemini(0.9))
    selector.resetAccounts([exhausted, fresh])
    // Exactly as before the Argon pool existed: the request is judged on
    // the ordinary Gemini pool.
    expect(
      selector.isAccountOverSoftQuota(
        exhausted,
        'gemini',
        50,
        ARGON_TTL,
        ARGON_MODEL,
      ),
    ).toBe(true)
    expect(
      selector.isAccountOverSoftQuota(
        fresh,
        'gemini',
        50,
        ARGON_TTL,
        ARGON_MODEL,
      ),
    ).toBe(false)
    expect(
      selector.getNextForFamily('gemini', ARGON_MODEL, 50, ARGON_TTL)?.index,
    ).toBe(1)
  })
})

describe('AccountSelector getMinWaitTimeForFamily regression tests', () => {
  const NOW = 1_700_000_000_000

  it('default call ignores coolingDownUntil (legacy quota-only semantics)', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        coolingDownUntil: NOW + 5_000,
        touchedForQuota: {},
      },
    ])
    expect(selector.getMinWaitTimeForFamily('gemini')).toBe(0)
    expect(selector.getMinWaitTimeForFamily('claude')).toBe(0)
  })

  it('includes coolingDownUntil in getMinWaitTimeForFamily when opt-in includeCooldown is true', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        coolingDownUntil: NOW + 5_000,
        touchedForQuota: {},
      },
    ])
    expect(selector.getMinWaitTimeForFamily('gemini', null, null, true)).toBe(
      5_000,
    )
    expect(selector.getMinWaitTimeForFamily('claude', null, null, true)).toBe(
      5_000,
    )
  })

  it('calculates max of cooldown and rate-limits per account then min across eligible when includeCooldown is true', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {
          gemini: NOW + 2_000,
          'gemini:gemini-3-pro': NOW + 7_000,
        },
        coolingDownUntil: NOW + 4_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { gemini: NOW + 3_000 },
        coolingDownUntil: NOW + 6_000,
        touchedForQuota: {},
      },
    ])
    // Account 0: max(2000, 7000, 4000) = 7000
    // Account 1: max(3000, 0, 6000) = 6000
    // Pool min: min(7000, 6000) = 6000
    expect(
      selector.getMinWaitTimeForFamily('gemini', 'gemini-3-pro', null, true),
    ).toBe(6_000)
  })

  it('strictly excludes disabled, ineligible and verificationRequired accounts when eligibleIndexes is provided', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: false,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 1_000 },
        coolingDownUntil: NOW + 1_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        accountIneligible: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 2_000 },
        coolingDownUntil: NOW + 2_000,
        touchedForQuota: {},
      },
      {
        index: 2,
        enabled: true,
        verificationRequired: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 3_000 },
        coolingDownUntil: NOW + 3_000,
        touchedForQuota: {},
      },
      {
        index: 3,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 9_000 },
        coolingDownUntil: NOW + 9_000,
        touchedForQuota: {},
      },
    ])
    const eligible = new Set([0, 1, 2, 3])
    expect(
      selector.getMinWaitTimeForFamily('claude', null, eligible, true),
    ).toBe(9_000)
  })

  it('reports zero wait when at least one eligible account is usable immediately', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 10_000 },
        coolingDownUntil: NOW + 10_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
    ])
    expect(selector.getMinWaitTimeForFamily('claude')).toBe(0)
  })

  it('reports zero wait when no eligible accounts exist in pool', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: false,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 10_000 },
        touchedForQuota: {},
      },
    ])
    expect(selector.getMinWaitTimeForFamily('claude')).toBe(0)
  })

  it('honors eligibleIndexes to exclude killed short timers from pool wait', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 1_000 },
        coolingDownUntil: NOW + 1_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 8_000 },
        coolingDownUntil: NOW + 8_000,
        touchedForQuota: {},
      },
    ])
    // Without eligibleIndexes filter, min is 1000
    expect(selector.getMinWaitTimeForFamily('claude', null, null, true)).toBe(
      1_000,
    )
    // When account 0 is killed/excluded by killswitch (eligible set only contains index 1), min is 8000
    const eligibleOnly1 = new Set([1])
    expect(
      selector.getMinWaitTimeForFamily('claude', null, eligibleOnly1, true),
    ).toBe(8_000)
  })

  it('forwards eligibleIndexes and includeCooldown accurately through AccountManager wrapper', async () => {
    const memory = memoryStore()
    const manager = new AccountManager(
      undefined,
      {
        version: 4,
        accounts: [
          {
            refreshToken: 'r1',
            projectId: 'p1',
            addedAt: 1,
            lastUsed: 0,
            rateLimitResetTimes: { claude: NOW + 1_000 },
            coolingDownUntil: NOW + 4_000,
          },
          {
            refreshToken: 'r2',
            projectId: 'p2',
            addedAt: 1,
            lastUsed: 0,
            rateLimitResetTimes: { claude: NOW + 8_000 },
            coolingDownUntil: NOW + 6_000,
          },
          {
            refreshToken: 'r3',
            projectId: 'p3',
            addedAt: 1,
            lastUsed: 0,
            rateLimitResetTimes: { claude: NOW + 2_000 },
            coolingDownUntil: NOW + 2_000,
            accountIneligible: true,
          },
        ],
        activeIndex: 0,
      },
      {
        store: memory,
        now: () => NOW,
      },
    )

    try {
      // 1. Default (no eligibleIndexes, includeCooldown = false):
      // Considers only rate limits for enabled accounts: min(1000, 8000, 2000) = 1000
      expect(manager.getMinWaitTimeForFamily('claude')).toBe(1_000)

      // 2. includeCooldown = true (no eligibleIndexes):
      // Account 2 has accountIneligible: true and is excluded consistently.
      // Account 0: max(rateLimit: 1000, cooldown: 4000) = 4000
      // Account 1: max(rateLimit: 8000, cooldown: 6000) = 8000
      // Pool min: min(4000, 8000) = 4000
      expect(manager.getMinWaitTimeForFamily('claude', null, null, true)).toBe(
        4_000,
      )

      // 3. eligibleIndexes provided (Set([0, 1, 2])):
      // accountIneligible: true on account 2 causes it to be excluded when eligibleIndexes is passed.
      // Pool min across {0, 1}: min(account 0: 4000, account 1: 8000) = 4000
      expect(
        manager.getMinWaitTimeForFamily(
          'claude',
          null,
          new Set([0, 1, 2]),
          true,
        ),
      ).toBe(4_000)

      // 4. eligibleIndexes restricting to index 1 only:
      // Pool min across {1}: 8000
      expect(
        manager.getMinWaitTimeForFamily('claude', null, new Set([1]), true),
      ).toBe(8_000)
    } finally {
      await manager.dispose()
    }
  })

  it('reports zero wait when an explicit empty eligibility set is passed', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 5_000 },
        coolingDownUntil: NOW + 5_000,
        touchedForQuota: {},
      },
    ])
    expect(
      selector.getMinWaitTimeForFamily('claude', null, new Set(), true),
    ).toBe(0)
  })

  it('treats null and undefined eligibleIndexes equivalently and excludes ineligible/verificationRequired rows in both', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        accountIneligible: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 1_000 },
        coolingDownUntil: NOW + 1_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        verificationRequired: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 2_000 },
        coolingDownUntil: NOW + 2_000,
        touchedForQuota: {},
      },
      {
        index: 2,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 5_000 },
        coolingDownUntil: NOW + 7_000,
        touchedForQuota: {},
      },
    ])
    // With undefined: ineligible rows (0 and 1) excluded, leaving index 2
    expect(
      selector.getMinWaitTimeForFamily('claude', null, undefined, false),
    ).toBe(5_000)
    expect(
      selector.getMinWaitTimeForFamily('claude', null, undefined, true),
    ).toBe(7_000)

    // With null: identical behavior
    expect(selector.getMinWaitTimeForFamily('claude', null, null, false)).toBe(
      5_000,
    )
    expect(selector.getMinWaitTimeForFamily('claude', null, null, true)).toBe(
      7_000,
    )
  })

  it('ignores expired cooldowns where coolingDownUntil <= now', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        coolingDownUntil: NOW - 5_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        coolingDownUntil: NOW,
        touchedForQuota: {},
      },
    ])
    expect(selector.getMinWaitTimeForFamily('claude', null, null, true)).toBe(0)
  })

  it('reports zero wait for immediately usable account with filtering and cooldowns enabled', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { claude: NOW + 10_000 },
        coolingDownUntil: NOW + 10_000,
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
    ])
    const eligible = new Set([0, 1])
    expect(
      selector.getMinWaitTimeForFamily('claude', null, eligible, true),
    ).toBe(0)
  })
})

describe('AccountSelector soft-quota scoping and selectable wait tests', () => {
  const NOW = 1_700_000_000_000
  const TTL = 10 * 60 * 1000

  it('exempts sole eligible account from soft quota under killswitch / ineligible / verification / disabled exclusions across all selection strategies', () => {
    const makeAccounts = (): SelectableAccount[] => [
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1, // 90% used >= 80% threshold
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            modelCount: 1,
          },
        },
      },
    ]

    // Exclusion scenarios exempt account 0 from soft quota across all selection strategies:
    const scenarios = [
      {
        name: 'killswitch',
        setup: (accs: SelectableAccount[]) => ({
          accounts: accs,
          excludeIndexes: new Set([1]),
        }),
      },
      {
        name: 'accountIneligible',
        setup: (accs: SelectableAccount[]) => {
          accs[1]!.accountIneligible = true
          return { accounts: accs, excludeIndexes: undefined }
        },
      },
      {
        name: 'verificationRequired',
        setup: (accs: SelectableAccount[]) => {
          accs[1]!.verificationRequired = true
          return { accounts: accs, excludeIndexes: undefined }
        },
      },
      {
        name: 'disabled',
        setup: (accs: SelectableAccount[]) => {
          accs[1]!.enabled = false
          return { accounts: accs, excludeIndexes: undefined }
        },
      },
    ] as const

    const strategies: AccountSelectionStrategy[] = [
      'sticky',
      'round-robin',
      'hybrid',
    ]

    for (const scenario of scenarios) {
      const { accounts, excludeIndexes } = scenario.setup(makeAccounts())
      const baseSelector = new AccountSelector<SelectableAccount>({
        now: () => NOW,
      })
      baseSelector.resetAccounts(accounts)

      // isAccountOverSoftQuota sees only 1 eligible account -> exempt (returns false)
      expect(
        baseSelector.isAccountOverSoftQuota(
          baseSelector.getAccounts()[0]!,
          'gemini',
          80,
          TTL,
          'gemini-3-flash',
          excludeIndexes,
        ),
      ).toBe(false)

      // Cold selection with a fresh selector and session for each strategy:
      for (const strategy of strategies) {
        const freshSelector = new AccountSelector<SelectableAccount>({
          now: () => NOW,
        })
        freshSelector.resetAccounts(accounts)
        const coldSession = { id: `cold-${scenario.name}-${strategy}` }
        expect(
          freshSelector.getCurrentOrNextForFamily(
            'gemini',
            'gemini-3-flash',
            strategy,
            false,
            80,
            TTL,
            coldSession,
            excludeIndexes,
          )?.index,
        ).toBe(0)
      }

      // Pinned selection: pinned to account 0 remains valid; pinned to account 1 falls through
      for (const strategy of strategies) {
        const freshSelector = new AccountSelector<SelectableAccount>({
          now: () => NOW,
        })
        freshSelector.resetAccounts(accounts)
        const pinned0Session = { id: `pinned0-${scenario.name}-${strategy}` }
        freshSelector.markSwitched(
          freshSelector.getAccounts()[0]!,
          'rotation',
          'gemini',
          pinned0Session,
        )
        expect(
          freshSelector.getCurrentOrNextForFamily(
            'gemini',
            'gemini-3-flash',
            strategy,
            false,
            80,
            TTL,
            pinned0Session,
            excludeIndexes,
          )?.index,
        ).toBe(0)

        const pinned1Session = { id: `pinned1-${scenario.name}-${strategy}` }
        freshSelector.markSwitched(
          freshSelector.getAccounts()[1]!,
          'rotation',
          'gemini',
          pinned1Session,
        )
        expect(
          freshSelector.getCurrentOrNextForFamily(
            'gemini',
            'gemini-3-flash',
            strategy,
            false,
            80,
            TTL,
            pinned1Session,
            excludeIndexes,
          )?.index,
        ).toBe(0)
      }
    }

    // areAllAccountsOverSoftQuota and getMinWaitTimeForSoftQuota reflect sole-eligible exemption:
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts(makeAccounts())
    expect(
      selector.areAllAccountsOverSoftQuota(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
        new Set([0]),
      ),
    ).toBe(false)
    expect(
      selector.getMinWaitTimeForSoftQuota(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
        new Set([0]),
      ),
    ).toBe(0)
  })

  it('ignores excluded accounts with short resets or under-threshold quotas in getMinWaitTimeForSoftQuota and getMinSelectableWaitTimeForFamily', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW + 500).toISOString(), // short 500ms reset on excluded account
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW + 5_000).toISOString(), // 5s reset on eligible account
            modelCount: 1,
          },
        },
      },
      {
        index: 2,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW + 10_000).toISOString(), // 10s reset on eligible account
            modelCount: 1,
          },
        },
      },
    ])

    const eligible1And2 = new Set([1, 2])
    // Helper ignores account 0 and returns min between 1 and 2 (5000ms, not 500ms):
    expect(
      selector.getMinWaitTimeForSoftQuota(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
        eligible1And2,
      ),
    ).toBe(5_000)
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
        eligible1And2,
      ),
    ).toBe(5_000)
  })

  it('computes earliest true selectable wait in mixed blocked pool', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        coolingDownUntil: NOW + 2_000,
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.5, // 50% used < 80% threshold -> under soft quota
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1, // 90% used >= 80% threshold -> over soft quota
            resetTime: new Date(NOW + 3_600_000).toISOString(), // 1h reset
            modelCount: 1,
          },
        },
      },
    ])

    // Account 0 selectable wait: max(hard: 0, cooldown: 2000, soft: 0) = 2000
    // Account 1 selectable wait: max(hard: 0, cooldown: 0, soft: 3600000) = 3600000
    // True earliest selectable wait is 2000ms:
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBe(2_000)
  })

  it('handles 10s hard rate-limit with 1h soft reset vs 1s soft reset correctly', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {
          gemini: NOW + 10_000,
          'gemini:gemini-3-flash': NOW + 10_000,
        },
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW + 3_600_000).toISOString(), // 1h soft reset
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW + 1_000).toISOString(), // 1s soft reset
            modelCount: 1,
          },
        },
      },
    ])

    // Account 0 wait: max(hard: 10000, soft: 3600000) = 3600000
    // Account 1 wait: max(hard: 0, soft: 1000) = 1000
    // Earliest selectable wait is 1000ms:
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBe(1_000)
  })

  it('distinguishes empty / ready / sole / unknown / stale cases in getMinSelectableWaitTimeForFamily', () => {
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })

    // 1. empty: 0 eligible accounts
    selector.resetAccounts([])
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBeNull()

    // 2. ready: eligible account usable immediately (0 wait)
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
    ])
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBe(0)

    // 3. sole: sole eligible account over soft quota threshold is exempt, returns its hard wait
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: { gemini: NOW + 4_000 },
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1, // >80% used, but sole eligible
            resetTime: new Date(NOW + 3_600_000).toISOString(),
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: false,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
    ])
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBe(4_000)

    // 4. unknown: multi-account pool over soft quota with no resetTime data
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            // no resetTime
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            // no resetTime
            modelCount: 1,
          },
        },
      },
    ])
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBeNull()

    // 5. stale: multi-account pool over soft quota with resetTime in the past
    selector.resetAccounts([
      {
        index: 0,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW - 1_000).toISOString(), // in the past
            modelCount: 1,
          },
        },
      },
      {
        index: 1,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
        cachedQuotaUpdatedAt: NOW,
        cachedQuota: {
          gemini: {
            remainingFraction: 0.1,
            resetTime: new Date(NOW - 5_000).toISOString(), // in the past
            modelCount: 1,
          },
        },
      },
    ])
    expect(
      selector.getMinSelectableWaitTimeForFamily(
        'gemini',
        80,
        TTL,
        'gemini-3-flash',
      ),
    ).toBeNull()
  })

  it('strictly excludes accountIneligible and verificationRequired accounts across sticky / roundrobin / hybrid / pinned / proactive selection', () => {
    const makeAccounts = (): SelectableAccount[] => [
      {
        index: 0,
        enabled: true,
        accountIneligible: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
      {
        index: 1,
        enabled: true,
        verificationRequired: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
      {
        index: 2,
        enabled: true,
        lastUsed: 0,
        rateLimitResetTimes: {},
        touchedForQuota: {},
      },
    ]

    const strategies: AccountSelectionStrategy[] = [
      'sticky',
      'round-robin',
      'hybrid',
    ]

    // 1. Cold selection: fresh selector and session for EACH strategy asserts real strategy filtering branches
    for (const strategy of strategies) {
      const selector = new AccountSelector<SelectableAccount>({
        now: () => NOW,
      })
      selector.resetAccounts(makeAccounts())
      const coldSession = { id: `cold-session-${strategy}` }
      expect(
        selector.getCurrentAccountForFamily('gemini', coldSession),
      ).toBeNull()
      expect(
        selector.getCurrentOrNextForFamily(
          'gemini',
          'gemini-3-flash',
          strategy,
          false,
          100,
          TTL,
          coldSession,
        )?.index,
      ).toBe(2)
    }

    // 2. Pinned session verification: pinned ineligible accounts are rejected and fall through to strategy; pinned eligible account is returned
    for (const strategy of strategies) {
      const selector = new AccountSelector<SelectableAccount>({
        now: () => NOW,
      })
      selector.resetAccounts(makeAccounts())

      // Ineligible pinned session falls through to strategy:
      const pinnedIneligible = { id: `pinned-ineligible-${strategy}` }
      selector.markSwitched(
        selector.getAccounts()[0]!,
        'rotation',
        'gemini',
        pinnedIneligible,
      )
      expect(
        selector.getCurrentAccountForFamily('gemini', pinnedIneligible),
      ).toBeNull()
      expect(
        selector.getCurrentOrNextForFamily(
          'gemini',
          'gemini-3-flash',
          strategy,
          false,
          100,
          TTL,
          pinnedIneligible,
        )?.index,
      ).toBe(2)

      // VerificationRequired pinned session falls through to strategy:
      const pinnedVerification = { id: `pinned-verification-${strategy}` }
      selector.markSwitched(
        selector.getAccounts()[1]!,
        'rotation',
        'gemini',
        pinnedVerification,
      )
      expect(
        selector.getCurrentAccountForFamily('gemini', pinnedVerification),
      ).toBeNull()
      expect(
        selector.getCurrentOrNextForFamily(
          'gemini',
          'gemini-3-flash',
          strategy,
          false,
          100,
          TTL,
          pinnedVerification,
        )?.index,
      ).toBe(2)

      // Eligible pinned session is served:
      const pinnedEligible = { id: `pinned-eligible-${strategy}` }
      selector.markSwitched(
        selector.getAccounts()[2]!,
        'rotation',
        'gemini',
        pinnedEligible,
      )
      expect(
        selector.getCurrentAccountForFamily('gemini', pinnedEligible)?.index,
      ).toBe(2)
      expect(
        selector.getCurrentOrNextForFamily(
          'gemini',
          'gemini-3-flash',
          strategy,
          false,
          100,
          TTL,
          pinnedEligible,
        )?.index,
      ).toBe(2)
    }

    // 3. Proactive rotation skips accounts 0 and 1:
    const selector = new AccountSelector<SelectableAccount>({ now: () => NOW })
    selector.resetAccounts(makeAccounts())
    const rotateSession = { id: 'rotate-session' }
    selector.markSwitched(
      selector.getAccounts()[2]!,
      'rotation',
      'gemini',
      rotateSession,
    )
    expect(
      selector.proactivelyRotateForFamily(
        'gemini',
        'gemini-3-flash',
        100,
        TTL,
        rotateSession,
      ),
    ).toBeNull()
  })
})
