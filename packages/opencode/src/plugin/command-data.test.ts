/**
 * Tests for the privacy-safe `CommandDataService` used by the
 * `/antigravity-quota` (and future `/antigravity-account`) data-first dialogs.
 *
 * Traps pinned here:
 *   1. Opening the dialog is cache-only — `listAccounts()` performs ZERO
 *      `refreshAccount` calls. Only the user-driven Refresh action goes
 *      through the quota manager; if opening starts fetching we have a
 *      regression of the original two-mode flow.
 *   2. Quota persistence keys by REFRESH TOKEN, not index — a concurrent
 *      OAuth login can renumber the flat `accounts[]` array between read
 *      and write, so writing by index would target the wrong account.
 *   3. Serialized `CommandAccountRow[]` carries no `email` field; the
 *      row is the projection that crosses the PII firewall into the
 *      dialog payload, and a leaked email is a security regression.
 *   4. After `refreshQuota()` the source-of-truth snapshot must show
 *      the refreshed `cachedQuota` AND a bumped `cachedQuotaUpdatedAt`,
 *      AND the post-write sidebar must carry the new percentages.
 *
 * The tests stub out the quota manager + live account-manager view so
 * we can pin the exact read/write sequence without standing up the
 * production quota fetch path.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AccountMetadataV3,
  AccountQuotaResult,
  AccountStorageV4,
  QuotaGroup,
  QuotaGroupSummary,
  QuotaManager,
} from '@cortexkit/antigravity-auth-core'
import { AccountStorageUnreadableError } from '@cortexkit/antigravity-auth-core'

import {
  drainSidebarWrites,
  readSidebarState,
  SIDEBAR_STATE_ENV,
  SIDEBAR_STATE_VERSION,
  type SidebarStateV1,
} from '../sidebar-state'

import {
  type CommandAccountRow,
  type CommandDataAccountManagerView,
  type CommandDataService,
  type CommandDataServiceOptions,
  type CommandDataStorage,
  createCommandDataService,
} from './command-data'

interface QuotaGroupFixture {
  gemini?: { remainingFraction?: number; resetTime?: string }
  'non-gemini'?: { remainingFraction?: number; resetTime?: string }
}

interface AccountFixture {
  email: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled: boolean
  label?: string
  cachedQuota?: QuotaGroupFixture
  cachedQuotaUpdatedAt?: number
  accountIneligible?: boolean
}

function makeAccountFixture(
  overrides: Partial<AccountFixture> & { refreshToken: string },
): AccountFixture {
  return {
    email: `${overrides.refreshToken}@example.test`,
    addedAt: 0,
    lastUsed: 0,
    enabled: true,
    ...overrides,
  }
}

interface Harness {
  service: CommandDataService
  quotaCallLog: Array<{ refreshToken: string; force: boolean }>
  stateFile: string
  // For asserting post-refresh storage state.
  storage: AccountStorageV4
  // For asserting what the quota manager was asked to refresh.
  quotaRefreshRequests: AccountMetadataV3[]
  // For asserting save lifecycle.
  saveCalls: number
  // Live view, for asserting post-update state.
  liveView: AccountFixture[]
  activeIndex: number
}

function makeHarness(options: {
  accounts: AccountFixture[]
  activeIndex?: number
  refreshResults?: Map<string, AccountQuotaResult>
  now?: () => number
  /** When true, also wire a storage adapter (defaults to true). */
  withStorage?: boolean
  /**
   * When provided, replace the default storage adapter with one that
   * rejects every `mutate` call with the supplied error. Used to assert
   * the locked-storage error path the production adapter (which calls
   * `mutateAccountStorage`) can hit on a corrupt file or a lock that
   * fails to acquire.
   */
  rejectStorageWith?: Error
  afterQuotaRefresh?: (liveView: AccountFixture[]) => void
  beforeStorageCommit?: (liveView: AccountFixture[]) => void
}): Harness {
  const stateFile = join(dir, 'sidebar-state.json')
  process.env[SIDEBAR_STATE_ENV] = stateFile

  const storage: AccountStorageV4 = {
    version: 4,
    activeIndex: options.activeIndex ?? 0,
    activeIndexByFamily: {
      claude: options.activeIndex ?? 0,
      gemini: options.activeIndex ?? 0,
    },
    accounts: options.accounts.map((entry) => ({
      email: entry.email,
      refreshToken: entry.refreshToken,
      projectId: entry.projectId,
      managedProjectId: entry.managedProjectId,
      addedAt: entry.addedAt,
      lastUsed: entry.lastUsed,
      enabled: entry.enabled,
      label: entry.label,
      cachedQuota: entry.cachedQuota as
        | Record<
            string,
            {
              remainingFraction?: number
              resetTime?: string
              modelCount: number
            }
          >
        | undefined,
      cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
      accountIneligible: entry.accountIneligible,
    })),
  }

  const quotaCallLog: Array<{ refreshToken: string; force: boolean }> = []
  const quotaRefreshRequests: AccountMetadataV3[] = []
  const quotaManager: QuotaManager = {
    refreshAccount: mock(async (account: AccountMetadataV3) => {
      quotaCallLog.push({ refreshToken: account.refreshToken, force: true })
      const result = options.refreshResults?.get(account.refreshToken)
      if (!result) {
        return {
          index: 0,
          status: 'error' as const,
          error: `no stubbed result for ${account.refreshToken.slice(0, 6)}`,
        }
      }
      return result
    }),
    refreshAccounts: mock(
      async (accounts: AccountMetadataV3[], refreshOptions) => {
        quotaRefreshRequests.push(...accounts)
        const results: AccountQuotaResult[] = accounts.map((account) => {
          quotaCallLog.push({
            refreshToken: account.refreshToken,
            force: refreshOptions?.force === true,
          })
          return (
            options.refreshResults?.get(account.refreshToken) ?? {
              index: accounts.indexOf(account),
              status: 'error' as const,
              error: `no stubbed result for ${account.refreshToken.slice(0, 6)}`,
            }
          )
        })
        options.afterQuotaRefresh?.(liveView)
        return results
      },
    ),
    getCached: mock(() => undefined),
    getBackoffUntil: mock(() => 0),
    hashedLogLabel: mock(() => 'stub'),
    dispose: mock(async () => {}),
    classifyQuotaGroup: mock(() => null),
    aggregateQuota: mock(() => ({ groups: {}, modelCount: 0 })),
    aggregateGeminiCliQuota: mock(() => ({ models: [], error: undefined })),
  }

  const liveView: AccountFixture[] = [...options.accounts]
  const saveCalls = { count: 0 }
  const activeIndex = options.activeIndex ?? 0
  let liveCurrentIndex = activeIndex

  const accountManagerView: CommandDataAccountManagerView = {
    getAccounts() {
      return liveView.map((entry, index) => ({
        index,
        refreshToken: entry.refreshToken,
        label: entry.label,
        enabled: entry.enabled,
        active: index === liveCurrentIndex,
        cachedQuota: entry.cachedQuota as
          | Partial<Record<QuotaGroup, QuotaGroupSummary>>
          | undefined,
        cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
        accountIneligible: entry.accountIneligible,
      }))
    },
    getAccountsForQuotaCheck() {
      return liveView.map((entry) => ({
        email: entry.email,
        refreshToken: entry.refreshToken,
        projectId: entry.projectId,
        managedProjectId: entry.managedProjectId,
        addedAt: entry.addedAt,
        lastUsed: entry.lastUsed,
        enabled: entry.enabled,
      }))
    },
    updateQuotaCache(
      index: number,
      groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>,
    ) {
      const account = liveView[index]
      if (!account) return
      account.cachedQuota = groups as QuotaGroupFixture | undefined
      account.cachedQuotaUpdatedAt = Date.now()
    },
    requestSaveToDisk() {
      saveCalls.count += 1
    },
    async flushSaveToDisk() {
      // Tests do not model the debounced-save lifecycle; the harness's
      // storage adapter already mirrors the in-memory state on every
      // mutation, so a flush is a no-op for test purposes.
    },
    activeIndex() {
      return liveCurrentIndex
    },
    setAccountEnabled(index: number, enabled: boolean): boolean {
      const account = liveView[index]
      if (!account) return false
      if (enabled && account.accountIneligible) return false
      if (account.enabled === enabled) return false
      account.enabled = enabled
      return true
    },
    setAccountCurrent(index: number): boolean {
      if (index < 0 || index >= liveView.length) return false
      liveCurrentIndex = index
      return true
    },
    removeAccountByIndex(index: number): boolean {
      if (index < 0 || index >= liveView.length) return false
      liveView.splice(index, 1)
      if (liveCurrentIndex >= liveView.length) {
        liveCurrentIndex = Math.max(0, liveView.length - 1)
      }
      return true
    },
    getRefreshTokenAt(index: number): string | undefined {
      return liveView[index]?.refreshToken
    },
  }

  const cmdStorage: CommandDataStorage | undefined =
    options.withStorage === false
      ? undefined
      : options.rejectStorageWith
        ? {
            // Mirrors the production adapter's failure mode — the
            // locked `mutateAccountStorage` write rejected with the
            // supplied error. The data service must observe the
            // rejection (the production adapter returns the promise,
            // not `void`), surface the error to the dialog, and leave
            // the live view untouched.
            mutate: () => Promise.reject(options.rejectStorageWith),
          }
        : {
            mutate: (mutator) => {
              const next = mutator(storage)
              if (next instanceof Promise) {
                return next.then((resolved) => {
                  if (resolved) {
                    storage.accounts = resolved.accounts
                    storage.activeIndex = resolved.activeIndex
                    storage.activeIndexByFamily = resolved.activeIndexByFamily
                  }
                  return undefined
                })
              }
              if (next) {
                options.beforeStorageCommit?.(liveView)
                storage.accounts = next.accounts
                storage.activeIndex = next.activeIndex
                storage.activeIndexByFamily = next.activeIndexByFamily
              }
              // Mirror the production adapter: return the promise
              // rather than discarding it with `void`. A test
              // adapter that swallows the rejection would mask the
              // very failure mode the production wiring must catch.
              return Promise.resolve(undefined)
            },
          }

  const serviceOptions: CommandDataServiceOptions = {
    accountManagerView,
    quotaManager,
    sidebarStateFile: stateFile,
    now: options.now ?? (() => 1_700_000_000_000),
    ...(cmdStorage ? { storage: cmdStorage } : {}),
  }

  const service = createCommandDataService(serviceOptions)

  return {
    service,
    quotaCallLog,
    stateFile,
    storage,
    quotaRefreshRequests,
    saveCalls: saveCalls.count as unknown as never as number,
    liveView,
    activeIndex,
  }
}

async function readSidebar(stateFile: string): Promise<SidebarStateV1> {
  await drainSidebarWrites()
  return readSidebarState(stateFile)
}

let dir: string

describe('createCommandDataService', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-command-data-'))
  })

  afterEach(() => {
    delete process.env[SIDEBAR_STATE_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  it('listAccounts() returns privacy-safe rows without ever calling the quota manager', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Primary',
          cachedQuota: {
            'non-gemini': {
              remainingFraction: 0.4,
              resetTime: new Date(0).toISOString(),
            },
            gemini: { remainingFraction: 0.7 },
          },
        }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Backup',
          enabled: false,
          cachedQuota: {
            gemini: { remainingFraction: 0.15 },
          },
        }),
      ],
    })

    const rows = await harness.service.listAccounts()

    expect(harness.quotaCallLog).toEqual([])
    expect(rows).toHaveLength(2)

    // Privacy: no email or stored profile label in any row.
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('refresh-a@example.test')
    expect(serialized).not.toContain('refresh-b@example.test')
    expect(serialized).not.toContain('Primary')
    expect(serialized).not.toContain('Backup')
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('email')
    }

    expect(rows[0]).toMatchObject({
      id: 'acct-0',
      index: 0,
      label: 'Account 1',
      enabled: true,
      current: true,
    })
    expect(rows[0]?.quota).toEqual([
      {
        key: 'gemini',
        label: 'Gemini',
        remainingPercent: 70,
        resetAt: undefined,
      },
      {
        key: 'non-gemini',
        label: 'Non-Gemini',
        remainingPercent: 40,
        resetAt: 0,
      },
    ])
    expect(rows[1]).toMatchObject({
      id: 'acct-1',
      index: 1,
      label: 'Account 2',
      enabled: false,
      current: false,
    })
  })

  it('listAccounts() is a pure cache read — opening performs zero refresh calls', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'A',
          cachedQuota: {
            'non-gemini': { remainingFraction: 0.5 },
          },
        }),
      ],
    })

    // Open the dialog three times in a row — each opening is a separate
    // listAccounts call and none should ever perform a refresh.
    for (let i = 0; i < 3; i += 1) {
      const rows = await harness.service.listAccounts()
      expect(rows).toHaveLength(1)
    }
    expect(harness.quotaCallLog).toEqual([])
  })

  it('refreshQuota() fetches every account, including an uncached new account, through the shared quota manager', async () => {
    const baseAccount = (
      refreshToken: string,
      groups: Record<string, { remainingFraction: number; resetTime?: string }>,
      index: number,
    ): AccountQuotaResult => ({
      index,
      status: 'ok',
      quota: { groups, modelCount: Object.keys(groups).length },
      updatedAccount: {
        refreshToken,
        addedAt: 0,
        lastUsed: 0,
      },
    })

    const refreshResults = new Map<string, AccountQuotaResult>([
      [
        'refresh-a',
        baseAccount(
          'refresh-a',
          {
            'non-gemini': {
              remainingFraction: 0.8,
              resetTime: new Date(0).toISOString(),
            },
            gemini: {
              remainingFraction: 0.6,
              resetTime: new Date(0).toISOString(),
            },
          },
          0,
        ),
      ],
      [
        'refresh-b',
        baseAccount(
          'refresh-b',
          {
            gemini: {
              remainingFraction: 0.25,
              resetTime: new Date(0).toISOString(),
            },
          },
          1,
        ),
      ],
    ])

    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Alpha',
          cachedQuota: { 'non-gemini': { remainingFraction: 0.1 } },
          cachedQuotaUpdatedAt: 1,
        }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Beta',
        }),
      ],
      refreshResults,
    })

    const rows = await harness.service.refreshQuota()

    // The shared quota manager must have been hit for each enabled account,
    // keyed by refresh token (not index) so concurrent OAuth reordering
    // cannot target the wrong row.
    expect(harness.quotaCallLog.map((call) => call.refreshToken)).toEqual([
      'refresh-a',
      'refresh-b',
    ])
    // refreshAccounts must have been called with `force: true` — opening
    // the quota dialog is cache-only and must not silently force-refresh.
    expect(harness.quotaCallLog.every((call) => call.force === true)).toBe(true)
    // The quota manager saw both refresh tokens in the request payload.
    expect(
      harness.quotaRefreshRequests.map((entry) => entry.refreshToken),
    ).toEqual(['refresh-a', 'refresh-b'])

    // The rows returned by refresh reflect the freshly persisted quota.
    expect(rows[0]?.label).toBe('Account 1')
    expect(
      rows[0]?.quota.find((q) => q.key === 'non-gemini')?.remainingPercent,
    ).toBe(80)
    expect(
      rows[0]?.quota.find((q) => q.key === 'gemini')?.remainingPercent,
    ).toBe(60)

    expect(rows[1]?.label).toBe('Account 2')
    expect(
      rows[1]?.quota.find((q) => q.key === 'gemini')?.remainingPercent,
    ).toBe(25)

    // The serialized rows must not leak the seeded email.
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('@example.test')
  })

  it('refreshQuota() persists refreshed cachedQuota into storage by refresh token', async () => {
    let now = 1_700_000_000_000
    const refreshResults = new Map<string, AccountQuotaResult>([
      [
        'refresh-a',
        {
          index: 0,
          status: 'ok',
          quota: {
            groups: {
              'non-gemini': {
                remainingFraction: 0.7,
                resetTime: new Date(0).toISOString(),
                modelCount: 1,
              },
            },
            modelCount: 1,
          },
          updatedAccount: {
            refreshToken: 'refresh-a',
            addedAt: 0,
            lastUsed: 0,
          },
        },
      ],
    ])

    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Alpha',
          cachedQuota: { 'non-gemini': { remainingFraction: 0.1 } },
          cachedQuotaUpdatedAt: 1,
        }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Beta',
          cachedQuota: { gemini: { remainingFraction: 0.05 } },
          cachedQuotaUpdatedAt: 1,
        }),
      ],
      refreshResults,
      now: () => {
        now += 1
        return now
      },
    })

    await harness.service.refreshQuota()

    // The source-of-truth snapshot must show the refreshed percentage
    // AND a bumped cachedQuotaUpdatedAt for the refreshed account.
    expect(
      harness.storage.accounts[0]?.cachedQuota?.['non-gemini']
        ?.remainingFraction,
    ).toBe(0.7)
    expect(harness.storage.accounts[0]?.cachedQuotaUpdatedAt).toBeGreaterThan(1)
    // The non-refreshed account's cached state must remain untouched.
    expect(
      harness.storage.accounts[1]?.cachedQuota?.gemini?.remainingFraction,
    ).toBe(0.05)
  })

  it('refreshQuota() writes a label-only sidebar snapshot carrying the fresh percentages', async () => {
    const refreshResults = new Map<string, AccountQuotaResult>([
      [
        'refresh-a',
        {
          index: 0,
          status: 'ok',
          quota: {
            groups: {
              'non-gemini': {
                remainingFraction: 0.9,
                resetTime: new Date(0).toISOString(),
                modelCount: 1,
              },
            },
            modelCount: 1,
          },
          updatedAccount: {
            refreshToken: 'refresh-a',
            addedAt: 0,
            lastUsed: 0,
          },
        },
      ],
    ])

    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Alpha',
          cachedQuota: { 'non-gemini': { remainingFraction: 0.1 } },
          cachedQuotaUpdatedAt: 1,
        }),
      ],
      refreshResults,
    })

    await harness.service.refreshQuota()

    const state = await readSidebar(harness.stateFile)
    expect(state.version).toBe(SIDEBAR_STATE_VERSION)
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]?.label).toBe('Account 1')
    expect(state.accounts[0]?.quota['non-gemini']?.remainingPercent).toBe(90)
    // Sidebar must NOT carry email even though the source account does.
    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain('@example.test')
  })

  it('refreshQuota() tolerates an empty account pool and writes a clean sidebar', async () => {
    const harness = makeHarness({
      accounts: [],
    })

    const rows = await harness.service.refreshQuota()

    expect(rows).toEqual([])
    expect(harness.quotaCallLog).toEqual([])

    const state = await readSidebar(harness.stateFile)
    expect(state.version).toBe(SIDEBAR_STATE_VERSION)
    expect(state.accounts).toEqual([])
  })

  it('keeps the row contract stable when quota fetch returns an error result', async () => {
    const refreshResults = new Map<string, AccountQuotaResult>([
      [
        'refresh-a',
        {
          index: 0,
          status: 'error',
          error: 'upstream 503',
        },
      ],
    ])

    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Alpha',
          cachedQuota: { 'non-gemini': { remainingFraction: 0.4 } },
          cachedQuotaUpdatedAt: 100,
        }),
      ],
      refreshResults,
    })

    const rows = await harness.service.refreshQuota()

    expect(rows).toHaveLength(1)
    // Error result keeps the cached percentage — never silently drops it.
    expect(
      rows[0]?.quota.find((q) => q.key === 'non-gemini')?.remainingPercent,
    ).toBe(40)
  })

  it('toggleAccountEnabled() flips the flag and persists through the locked mutator', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Beta',
          enabled: false,
        }),
      ],
    })

    // Toggle Alpha (enabled → disabled).
    const afterAlpha = await harness.service.toggleAccountEnabled(0)
    expect(afterAlpha).not.toBeNull()
    expect(afterAlpha?.[0]?.enabled).toBe(false)
    expect(afterAlpha?.[1]?.enabled).toBe(false)
    // Persisted to storage keyed by refresh token, NOT by index.
    expect(harness.storage.accounts[0]?.enabled).toBe(false)
    expect(harness.storage.accounts[1]?.enabled).toBe(false)

    // Toggle Beta (disabled → enabled). Re-keying by refresh token is
    // what makes this safe under concurrent OAuth reordering.
    const afterBeta = await harness.service.toggleAccountEnabled(1)
    expect(afterBeta?.[1]?.enabled).toBe(true)
    expect(harness.storage.accounts[1]?.enabled).toBe(true)
  })

  it('toggleAccountEnabled() rejects out-of-range indices without touching storage', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
    })

    const before = harness.storage.accounts[0]?.enabled
    const result = await harness.service.toggleAccountEnabled(99)
    expect(result).toBeNull()
    expect(harness.storage.accounts[0]?.enabled).toBe(before)
  })

  it('toggleAccountEnabled() returns privacy-safe rows (no email leakage)', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
    })
    const rows = await harness.service.toggleAccountEnabled(0)
    expect(rows).not.toBeNull()
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('refresh-a@example.test')
    for (const row of rows ?? []) {
      expect(Object.keys(row)).not.toContain('email')
    }
  })

  it('setCurrentAccount() pins the index across both families and persists under the lock', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({ refreshToken: 'refresh-b', label: 'Beta' }),
      ],
      activeIndex: 0,
    })

    const rows = await harness.service.setCurrentAccount(1)
    expect(rows).not.toBeNull()
    // Live view: the row at index 1 is now `current: true`.
    expect(rows?.[1]?.current).toBe(true)
    expect(rows?.[0]?.current).toBe(false)
    // Storage: activeIndex + activeIndexByFamily point at 1.
    expect(harness.storage.activeIndex).toBe(1)
    expect(harness.storage.activeIndexByFamily?.claude).toBe(1)
    expect(harness.storage.activeIndexByFamily?.gemini).toBe(1)
  })

  it('setCurrentAccount() returns null for an out-of-range index', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
    })

    const result = await harness.service.setCurrentAccount(42)
    expect(result).toBeNull()
    // Storage was untouched — activeIndex stays at the harness default.
    expect(harness.storage.activeIndex).toBe(0)
  })

  it('removeAccount() drops the target by refresh token and renumbers the flat array', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({ refreshToken: 'refresh-b', label: 'Beta' }),
        makeAccountFixture({ refreshToken: 'refresh-c', label: 'Gamma' }),
      ],
      activeIndex: 0,
    })

    const rows = await harness.service.removeAccount(1)
    expect(rows).not.toBeNull()
    // Two accounts remain; the deleted one is gone, the rest renumbered.
    expect(rows).toHaveLength(2)
    expect(rows?.[0]?.id).toBe('acct-0')
    expect(rows?.[0]?.label).toBe('Account 1')
    expect(rows?.[1]?.id).toBe('acct-1')
    expect(rows?.[1]?.label).toBe('Account 2')
    // Storage reflects the same removal (replace semantics, not merge).
    expect(harness.storage.accounts).toHaveLength(2)
    expect(harness.storage.accounts.map((a) => a.refreshToken)).toEqual([
      'refresh-a',
      'refresh-c',
    ])
    // CLI menu semantics: active index resets to 0 after removal.
    expect(harness.storage.activeIndex).toBe(0)
    expect(harness.storage.activeIndexByFamily).toEqual({
      claude: 0,
      gemini: 0,
    })
  })

  it('removeAccount() returns null when the index is out of range', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
    })

    const before = harness.storage.accounts.length
    const result = await harness.service.removeAccount(99)
    expect(result).toBeNull()
    expect(harness.storage.accounts).toHaveLength(before)
  })

  it('removeAccount() returns privacy-safe rows after the renumber', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({ refreshToken: 'refresh-b', label: 'Beta' }),
      ],
    })

    const rows = await harness.service.removeAccount(0)
    expect(rows).not.toBeNull()
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('refresh-a@example.test')
    expect(serialized).not.toContain('refresh-b@example.test')
    for (const row of rows ?? []) {
      expect(Object.keys(row)).not.toContain('email')
    }
  })

  it('setCurrentAccount() runs through the locked mutator without contacting the quota manager', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
    })

    await harness.service.setCurrentAccount(0)
    expect(harness.quotaCallLog).toEqual([])
  })

  it('removeAccount() runs through the locked mutator without contacting the quota manager', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
    })

    await harness.service.removeAccount(0)
    expect(harness.quotaCallLog).toEqual([])
  })

  // ============================================================================
  // MUST-1 / SHOULD-3 — locked-storage failure path
  //
  // The production `mutate` adapter in plugin/index.ts:308-314 calls
  // `mutateAccountStorage(...)`, which rejects with
  // AccountStorageUnreadableError when the file is corrupt or with a
  // lock-contention error when another writer holds the file. The
  // dialog action must:
  //
  //   - observe the rejection (the adapter MUST return the promise,
  //     not discard it),
  //   - skip the live AccountManager mutation (a failed write must
  //     NOT leave the runtime inconsistent with disk),
  //   - propagate the error so the apply layer can toast the message.
  // ============================================================================

  it('removeAccount() throws and leaves the live view untouched when the locked write fails', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({ refreshToken: 'refresh-b', label: 'Beta' }),
      ],
      rejectStorageWith: new AccountStorageUnreadableError('corrupt', {
        path: '/tmp/accounts.json',
        reason: 'invalid-shape',
        detail: 'unexpected',
        backupPath: null,
      }),
    })

    const before = harness.storage.accounts.length
    expect(() => harness.service.removeAccount(0)).toThrow(
      AccountStorageUnreadableError,
    )
    // Live view untouched — the runtime stays consistent with the
    // still-on-disk file when the write fails.
    expect(harness.liveView).toHaveLength(2)
    // Storage unchanged too — the lock-held write rejected before
    // its callback could land.
    expect(harness.storage.accounts).toHaveLength(before)
  })

  it('toggleAccountEnabled() throws and leaves the live view untouched when the locked write fails', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
      ],
      rejectStorageWith: new AccountStorageUnreadableError('corrupt', {
        path: '/tmp/accounts.json',
        reason: 'invalid-shape',
        detail: 'unexpected',
        backupPath: null,
      }),
    })

    expect(() => harness.service.toggleAccountEnabled(0)).toThrow(
      AccountStorageUnreadableError,
    )
    // Live flag unchanged.
    expect(harness.liveView[0]?.enabled).toBe(true)
    // Storage flag unchanged.
    expect(harness.storage.accounts[0]?.enabled).toBe(true)
  })

  it('setCurrentAccount() throws and leaves the live view untouched when the locked write fails', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({ refreshToken: 'refresh-b', label: 'Beta' }),
      ],
      activeIndex: 0,
      rejectStorageWith: new Error('lock contention'),
    })

    expect(() => harness.service.setCurrentAccount(1)).toThrow()
    // Active cursor unchanged — the live AccountManager did not see a
    // matching markSwitched call when the disk write failed.
    // The harness tracks this via `activeIndex()`.
    expect(harness.storage.activeIndex).toBe(0)
  })

  // ============================================================================
  // SHOULD-2 — setCurrentAccount() must write the storage index by
  // REFRESH TOKEN, not by the caller's live index. Concurrent OAuth
  // can renumber the flat array between read and write, so writing
  // `index` would target the wrong account after restart.
  // ============================================================================

  it('rejects re-enabling an ineligible account without changing disk or memory', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-ineligible',
          enabled: false,
          accountIneligible: true,
        }),
      ],
    })

    await expect(harness.service.toggleAccountEnabled(0)).rejects.toThrow(
      'ineligible',
    )
    expect(harness.storage.accounts[0]?.enabled).toBe(false)
    expect(harness.liveView[0]?.enabled).toBe(false)
  })

  it('compensates the disk write when eligibility changes before the live apply', async () => {
    const account = makeAccountFixture({
      refreshToken: 'token-a',
      enabled: false,
      accountIneligible: false,
    })
    const harness = makeHarness({
      accounts: [account],
      beforeStorageCommit(live) {
        const target = live[0]
        if (target) target.accountIneligible = true
      },
    })

    await expect(harness.service.toggleAccountEnabled(0)).rejects.toThrow(
      'The account changed while the operation was being applied',
    )

    expect(harness.liveView[0]?.enabled).toBe(false)
    expect(harness.storage.accounts[0]?.enabled).toBe(false)
  })

  it('re-resolves the live account by refresh token after an awaited storage mutation', async () => {
    let injected = false
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a' }),
        makeAccountFixture({ refreshToken: 'refresh-b' }),
      ],
      beforeStorageCommit: (liveView) => {
        if (injected) return
        injected = true
        liveView.unshift(makeAccountFixture({ refreshToken: 'refresh-new' }))
      },
    })

    await harness.service.removeAccount(0)

    expect(harness.storage.accounts.map((entry) => entry.refreshToken)).toEqual(
      ['refresh-b'],
    )
    expect(harness.liveView.map((entry) => entry.refreshToken)).toEqual([
      'refresh-new',
      'refresh-b',
    ])
  })

  it('does not apply a removed account quota result to the account now at its old index', async () => {
    const refreshResults = new Map<string, AccountQuotaResult>([
      [
        'refresh-a',
        {
          index: 0,
          status: 'ok',
          quota: {
            groups: {
              'non-gemini': { remainingFraction: 0.1, modelCount: 1 },
            },
            modelCount: 1,
          },
          updatedAccount: {
            refreshToken: 'refresh-a',
            addedAt: 0,
            lastUsed: 0,
          },
        },
      ],
    ])
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a' }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          cachedQuota: { 'non-gemini': { remainingFraction: 0.8 } },
        }),
      ],
      refreshResults,
      afterQuotaRefresh: (liveView) => {
        liveView.shift()
      },
    })

    await harness.service.refreshQuota()

    expect(harness.liveView[0]?.refreshToken).toBe('refresh-b')
    expect(
      harness.liveView[0]?.cachedQuota?.['non-gemini']?.remainingFraction,
    ).toBe(0.8)
  })

  it('projects non-Gemini quota into command rows and sidebar state', async () => {
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          cachedQuota: { 'non-gemini': { remainingFraction: 0.42 } },
        }),
      ],
    })

    const rows = await harness.service.refreshQuota()
    expect(rows[0]?.quota).toContainEqual({
      key: 'non-gemini',
      label: 'Non-Gemini',
      remainingPercent: 42,
      resetAt: undefined,
    })
    const state = await readSidebar(harness.stateFile)
    expect(state.accounts[0]?.quota['non-gemini']?.remainingPercent).toBe(42)
  })

  it('setCurrentAccount() writes the token-indexed position, not the caller-supplied live index', async () => {
    // Simulate concurrent OAuth add: the storage now holds an extra
    // account at index 0 that the live view did not see. The target
    // account is the live-view index 0 (`refresh-b`) but the storage
    // index 1.
    const harness = makeHarness({
      accounts: [
        makeAccountFixture({ refreshToken: 'refresh-a', label: 'Alpha' }),
        makeAccountFixture({ refreshToken: 'refresh-b', label: 'Beta' }),
      ],
    })

    // Inject a phantom account at storage index 0 to mimic the
    // concurrent-OAuth-add scenario.
    harness.storage.accounts = [
      {
        email: 'phantom@example.test',
        refreshToken: 'refresh-phantom',
        addedAt: 0,
        lastUsed: 0,
        enabled: true,
      },
      ...harness.storage.accounts,
    ]

    // Call with live index 1 → Beta. Storage index for Beta is 1,
    // but the caller's clamp must follow the storage lookup, not the
    // live index. Writing activeIndex = 1 here would still target Beta
    // because the storage shifted by one — but if the test instead
    // called with live index 0 (Alpha) while the storage shifted Alpha
    // to index 1, a naive clamp would write 0 (= phantom) instead of
    // 1 (= Alpha).
    await harness.service.setCurrentAccount(0)
    expect(harness.storage.activeIndex).toBe(1)
    expect(harness.storage.activeIndexByFamily?.claude).toBe(1)
    expect(harness.storage.activeIndexByFamily?.gemini).toBe(1)
  })
})

// Keep `mock` import alive for symmetry with sibling suites.
void mock

// Surface the row type so future Tasks 10/11 can build on the same shape.
export type { CommandAccountRow }
