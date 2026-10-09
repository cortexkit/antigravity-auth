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
  HeaderStyle,
} from './account-types.ts'
import { HealthScoreTracker, TokenBucketTracker } from './rotation.ts'

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
    headerStyle?: HeaderStyle,
    pidOffsetEnabled?: boolean,
    softQuotaThresholdPercent?: number,
    softQuotaCacheTtlMs?: number,
    identity?: AccountSessionIdentity,
    excludeIndexes?: Set<number>,
  ): R | null
  getNextForFamily(
    family: AccountModelFamily,
    model?: string | null,
    headerStyle?: HeaderStyle,
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
    headerStyle?: HeaderStyle,
    model?: string | null,
  ): void
  markRateLimitedWithReason(
    account: R,
    family: AccountModelFamily,
    headerStyle: HeaderStyle,
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
    headerStyle?: HeaderStyle,
    strict?: boolean,
  ): number
  getAvailableHeaderStyle(
    account: R,
    family: AccountModelFamily,
    model?: string | null,
  ): HeaderStyle | null
  isRateLimitedForHeaderStyle(
    account: R,
    family: AccountModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null,
  ): boolean
  hasOtherAccountWithAntigravityAvailable(
    currentAccountIndex: number,
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
    headerStyle: HeaderStyle,
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
    'antigravity',
    false,
    100,
    TTL,
    undefined,
    new Set([claudeNow]),
  )
  // Round-robin over per-model and per-header-style limits.
  out.push([
    'round-robin gemini model',
    [1, 2, 3, 4].map(() =>
      idx(
        pool.getCurrentOrNextForFamily(
          'gemini',
          MODEL,
          'round-robin',
          'antigravity',
        ),
      ),
    ),
  ])
  out.push([
    'round-robin gemini cli',
    [1, 2, 3].map(() =>
      idx(
        pool.getCurrentOrNextForFamily(
          'gemini',
          null,
          'round-robin',
          'gemini-cli',
        ),
      ),
    ),
  ])
  state('after round-robin')

  // Hybrid with health and token differences, session and parent isolation.
  pool.healthTracker.recordFailure(0)
  pool.healthTracker.recordFailure(0)
  pool.tokenTracker.consume(1, 5)
  sessions.push(root, child)
  select(
    'hybrid root',
    'gemini',
    MODEL,
    'hybrid',
    'gemini-cli',
    false,
    100,
    TTL,
    root,
  )
  select(
    'hybrid child',
    'gemini',
    MODEL,
    'hybrid',
    'gemini-cli',
    false,
    100,
    TTL,
    child,
  )
  select(
    'hybrid global excluding 0 and 1',
    'gemini',
    MODEL,
    'hybrid',
    'gemini-cli',
    false,
    100,
    TTL,
    undefined,
    new Set([0, 1]),
  )
  state('after hybrid')

  // Exact session pinning until the pinned account becomes unavailable.
  select(
    'root pinned',
    'gemini',
    MODEL,
    'sticky',
    'gemini-cli',
    false,
    100,
    TTL,
    root,
  )
  const pinned = pool.getCurrentAccountForFamily('gemini', root)
  if (pinned === null) throw new Error('root has no pin')
  pool.markRateLimited(pinned, 5_000, 'gemini', 'gemini-cli', MODEL)
  select(
    'root after its pin is limited',
    'gemini',
    MODEL,
    'sticky',
    'gemini-cli',
    false,
    100,
    TTL,
    root,
  )
  select(
    'child sticky',
    'gemini',
    MODEL,
    'sticky',
    'gemini-cli',
    false,
    100,
    TTL,
    child,
  )
  state('after pinning')

  // PID offset, once per session and family.
  sessions.push(offset)
  select(
    'pid offset session',
    'gemini',
    null,
    'sticky',
    'antigravity',
    true,
    100,
    TTL,
    offset,
  )
  select(
    'pid offset session again',
    'gemini',
    null,
    'sticky',
    'antigravity',
    true,
    100,
    TTL,
    offset,
  )
  select('pid offset global', 'claude', null, 'sticky', 'antigravity', true)
  state('after pid offset')

  // Soft quota: over-threshold accounts are skipped, cold ones pass.
  select(
    'soft quota sticky',
    'gemini',
    FLASH,
    'sticky',
    'antigravity',
    false,
    50,
    TTL,
  )
  select(
    'soft quota round-robin',
    'gemini',
    FLASH,
    'round-robin',
    'antigravity',
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

  // Waits, header styles and the antigravity fallback check.
  out.push([
    'waits',
    [
      pool.getMinWaitTimeForFamily('claude'),
      pool.getMinWaitTimeForFamily('gemini', MODEL),
      pool.getMinWaitTimeForFamily('gemini', MODEL, 'gemini-cli', true),
      pool.getMinWaitTimeForFamily('gemini', null, 'antigravity', true),
    ],
  ])
  out.push([
    'header styles',
    pool
      .getAccounts()
      .map((row) => [
        pool.getAvailableHeaderStyle(row, 'gemini', MODEL),
        pool.getAvailableHeaderStyle(row, 'claude'),
        pool.isRateLimitedForHeaderStyle(row, 'gemini', 'antigravity', MODEL),
      ]),
  ])
  out.push([
    'other antigravity',
    [0, 1, 2, 3, 4, 5].map((i) =>
      pool.hasOtherAccountWithAntigravityAvailable(i, 'gemini', MODEL),
    ),
  ])
  out.push([
    'other antigravity claude',
    pool.hasOtherAccountWithAntigravityAvailable(0, 'claude'),
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
        'antigravity',
        null,
        'MODEL_CAPACITY_EXHAUSTED',
        null,
      ),
      pool.markRateLimitedWithReason(
        at(4),
        'claude',
        'antigravity',
        null,
        'QUOTA_EXHAUSTED',
        null,
      ),
      pool.markRateLimitedWithReason(
        at(5),
        'gemini',
        'gemini-cli',
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
    idx(pool.getNextForFamily('gemini', null, 'antigravity', 100, TTL, root)),
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
      idx(
        pool.proactivelyRotateForFamily(
          'gemini',
          MODEL,
          'antigravity',
          100,
          TTL,
          root,
        ),
      ),
      idx(
        pool.proactivelyRotateForFamily(
          'claude',
          null,
          'antigravity',
          100,
          TTL,
        ),
      ),
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
          'antigravity',
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
 * The outputs recorded from the pool-file AccountManager at commit
 * d0d3182a, before its selection state moved into AccountSelector.
 */
// biome-ignore format: a recorded literal, one output per line
const ORACLE_EXPECTED: Output = [
  ["sticky claude",0],
  ["sticky claude after limit",4],
  ["sticky claude excluding current",5],
  ["round-robin gemini model",[1,5,0,1]],
  ["round-robin gemini cli",[4,0,1]],
  ["after round-robin: state",{"active":{"claude":5,"gemini":1},"pins":[],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":2000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":0,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini-cli":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[70,70,70,70,70,70],"tokens":[50,50,50,50,50,50],"diagnostics":[]}],
  ["hybrid root",4],
  ["hybrid child",1],
  ["hybrid global excluding 0 and 1",4],
  ["after hybrid: state",{"active":{"claude":5,"gemini":4},"pins":[["root",{"claude":-1,"gemini":4}],["child",{"claude":-1,"gemini":1}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000},"touched":{"claude":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45,50,50,50,50],"diagnostics":[]}],
  ["root pinned",4],
  ["root after its pin is limited",0],
  ["child sticky",1],
  ["after pinning: state",{"active":{"claude":5,"gemini":0},"pins":[["root",{"claude":-1,"gemini":0}],["child",{"claude":-1,"gemini":1}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini-cli:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45,50,50,50,50],"diagnostics":[]}],
  ["pid offset session",4],
  ["pid offset session again",4],
  ["pid offset global",4],
  ["after pid offset: state",{"active":{"claude":4,"gemini":4},"pins":[["root",{"claude":-1,"gemini":0}],["child",{"claude":-1,"gemini":1}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini-cli:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45,50,50,50,50],"diagnostics":["Applying PID account offset","Applying PID account offset"]}],
  ["soft quota sticky",4],
  ["soft quota round-robin",0],
  ["all over soft quota",[false,false,false]],
  ["soft quota waits",[0,0,0,0,0]],
  ["over soft quota",[false,true,false,false,false,false]],
  ["oldest quota age",null],
  ["waits",[0,0,0,0]],
  ["header styles",[["antigravity",null,false],["antigravity",null,false],["antigravity","antigravity",false],["antigravity","antigravity",false],[null,"antigravity",true],["antigravity","antigravity",false]]],
  ["other antigravity",[true,true,true,true,true,true]],
  ["other antigravity claude",false],
  ["toast 1",true],
  ["toast after shown",[false,true,true]],
  ["backoff",[47469.227691181004,300000,4000]],
  ["after backoff: state",{"active":{"claude":4,"gemini":0},"pins":[["root",{"claude":-1,"gemini":0}],["child",{"claude":-1,"gemini":1}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":500,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini-cli:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":2,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000,"gemini-cli:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":1,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.1,50,50,50,50],"diagnostics":[]}],
  ["daily counts",[{"date":"2026-10-07","claude":2,"gemini":0},{"date":"2026-10-07","claude":0,"gemini":1},null]],
  ["daily totals",[2,1]],
  ["daily summary",[{"index":0,"email":"zero@example.test","count":2}]],
  ["session summary",{"durationMinutes":0,"totalClaude":2,"totalGemini":1,"requestsPerHour":10800,"accountsUsed":2,"perAccount":[{"index":0,"email":"zero@example.test","claude":2,"gemini":0},{"index":4,"claude":0,"gemini":1}]}],
  ["session usage",[true,false,true]],
  ["next prefers session-used",1],
  ["after usage: state",{"active":{"claude":4,"gemini":0},"pins":[["root",{"claude":-1,"gemini":0}],["child",{"claude":-1,"gemini":1}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{},"cooldown":[1791374405000,"network-error"],"failures":null,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":null,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000,"gemini-antigravity:gemini-2.5-pro":1791374410000,"gemini-cli:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000,"gemini-cli:gemini-2.5-pro":1791374405000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":1,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.1,50,50,50,50],"diagnostics":[]}],
  ["cooling",[true,"auth-failure"]],
  ["cooling later",[false,"network-error",5,6]],
  ["cooling 2 expired",false],
  ["fresh",[true,true,[2],[2,4]]],
  ["should rotate",[false,true,false]],
  ["proactive rotate",[2,5]],
  ["optimistic reset",false],
  ["after proactive rotation and clearing: state",{"active":{"claude":5,"gemini":2},"pins":[["root",{"claude":-1,"gemini":2}],["child",{"claude":-1,"gemini":1}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["after switches: state",{"active":{"claude":5,"gemini":0},"pins":[["root",{"claude":-1,"gemini":2}],["child",{"claude":2,"gemini":1}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":true,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["disable gemini active",[0,true]],
  ["access verdicts",[true,true,false,true,false,false]],
  ["after access verdicts: state",{"active":{"claude":1,"gemini":1},"pins":[["root",{"claude":-1,"gemini":2}],["child",{"claude":2,"gemini":1}],["offset",{"claude":-1,"gemini":4}]],"rows":[{"index":0,"enabled":false,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374400000,"limits":{"claude":1791374430000},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":2,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"gemini-antigravity:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[false,null,false]},{"index":3,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":5,"enabled":false,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[true,"https://verify",null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["fingerprints",[true,1,true,2,null,null]],
  ["remove 1",true],
  ["rows after removal",[[0,"zero@example.test"],[1,null],[2,null],[3,null],[4,"five@example.test"]]],
  ["after removal",[null,null,true,false]],
  ["session summary after removal",{"durationMinutes":0,"totalClaude":2,"totalGemini":1,"requestsPerHour":1800,"accountsUsed":2,"perAccount":[{"index":0,"email":"zero@example.test","claude":2,"gemini":0},{"index":4,"email":"five@example.test","claude":0,"gemini":1}]}],
  ["sticky claude after removal",1],
  ["round-robin after removal",[1,3,1]],
  ["after removal: state",{"active":{"claude":1,"gemini":1},"pins":[["root",{"claude":-1,"gemini":1}],["child",{"claude":1,"gemini":-1}],["offset",{"claude":-1,"gemini":3}]],"rows":[{"index":0,"enabled":false,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":true,"lastUsed":1791374401000,"limits":{},"touched":{"claude":1791374406000,"gemini-antigravity":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[false,null,false]},{"index":2,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374701000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374406000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":false,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[true,"https://verify",null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
  ["single enabled",[0,false,0,false]],
  ["single enabled: state",{"active":{"claude":0,"gemini":0},"pins":[["root",{"claude":-1,"gemini":1}],["child",{"claude":1,"gemini":-1}],["offset",{"claude":-1,"gemini":3}]],"rows":[{"index":0,"enabled":true,"lastUsed":1791374401000,"limits":{"claude":1791374460000},"touched":{"claude":1791374400000,"gemini-antigravity:gemini-2.5-flash":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":1,"enabled":false,"lastUsed":1791374401000,"limits":{},"touched":{"claude":1791374406000,"gemini-antigravity":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374406000},"cooldown":[null,null],"failures":0,"verification":[false,null,false]},{"index":2,"enabled":false,"lastUsed":0,"limits":{},"touched":{},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":3,"enabled":false,"lastUsed":1791374401000,"limits":{"claude":1791374701000},"touched":{"claude":1791374400000,"gemini-antigravity":1791374406000,"gemini-antigravity:gemini-2.5-flash":1791374400000,"gemini-cli":1791374400000,"gemini-cli:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[null,null,null]},{"index":4,"enabled":false,"lastUsed":300,"limits":{"gemini-cli":1791374420000},"touched":{"claude":1791374406000,"gemini-antigravity:gemini-2.5-pro":1791374400000},"cooldown":[null,null],"failures":0,"verification":[true,"https://verify",null]}],"health":[30,70,70,70,70,70],"tokens":[50,45.6,50,50,50,50],"diagnostics":[]}],
]

/**
 * The recorded outputs with the corrections made when selection state moved
 * into AccountSelector. Before that move, removing a row left three kinds of index-keyed state where the
 * removed row had been, so they applied to the row that moved into its
 * place: its token balance (owned trackers were not reindexed on removal),
 * its toast debounce, and its session request counts. Removal now moves
 * that state with its row, as a reload always did. Nothing else differs.
 */
function oracleWithRemovalCorrections(): Output {
  const corrected: Output = structuredClone(ORACLE_EXPECTED)
  const entry = (label: string): [string, unknown] => {
    const found = corrected.find(([name]) => name === label)
    if (found === undefined) throw new Error(`no oracle entry ${label}`)
    return found
  }
  // The removed row 1 had shown the last toast; the row now at 1 has not.
  const afterRemoval = entry('after removal')[1] as unknown[]
  afterRemoval[3] = true
  // Row 4's request moves with it to index 3; row 3 has no email.
  const summary = entry('session summary after removal')[1] as {
    perAccount: Array<{ index: number; email?: string }>
  }
  const moved = summary.perAccount[1]
  if (moved === undefined) throw new Error('no second per-account entry')
  moved.index = 3
  delete moved.email
  // The removed row 1's spent tokens are dropped, not given to row 2.
  for (const label of ['after removal: state', 'single enabled: state']) {
    const state = entry(label)[1] as { tokens: number[] }
    state.tokens[1] = 50
  }
  return corrected
}

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
    expect(await runManagerOracle()).toEqual(oracleWithRemovalCorrections())
  })

  it('a bare selector over credential-free rows reproduces them too', () => {
    expect(runSelectorOracle().out).toEqual(oracleWithRemovalCorrections())
  })

  it('corrects only the removal entries of the recorded outputs', () => {
    const corrected = oracleWithRemovalCorrections()
    const changed = corrected
      .filter(
        ([, value], index) =>
          JSON.stringify(value) !== JSON.stringify(ORACLE_EXPECTED[index]?.[1]),
      )
      .map(([label]) => label)
    expect(changed).toEqual([
      'after removal',
      'session summary after removal',
      'after removal: state',
      'single enabled: state',
    ])
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
