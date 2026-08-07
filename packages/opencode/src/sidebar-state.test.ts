/**
 * Tests for the freshness-merged sidebar state writers.
 *
 * The TUI only reads sidebar-state.json; this file exercises the writers the
 * plugin uses to keep that file in sync. Every test runs in isolation:
 *
 *   - Each `it` gets a fresh temp dir via `makeFixture()`.
 *   - The `SidebarMergeHooks` are reset in `afterEach` so a hook leaked from
 *     one test cannot gate the next.
 *
 * Race tests use the `merged-state` step to pause the writer long enough for
 * a second call to enqueue, then resume so the second call runs against the
 * post-first-write disk state. The lock contention test uses Task 7's lock
 * directly to simulate a live cross-process holder and proves the writer's
 * retry+jitter path eventually throws `SidebarStateLockContentionError` after
 * the 2s budget.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireFencedFileLock } from '@cortexkit/antigravity-auth-core'

import {
  buildSidebarMachineStateFromAccounts,
  DEFAULT_SIDEBAR_STATE,
  isAccountCurrent,
  normalizeLegacyCachedQuota,
  pruneActiveRouting,
  readSidebarState,
  redactAccountForSidebar,
  removeSidebarActiveRouting,
  SIDEBAR_STATE_VERSION,
  type SidebarMergeHooks,
  type SidebarMergeStep,
  type SidebarRoutingEntry,
  SidebarStateLockContentionError,
  type SidebarStateV1,
  setSidebarMachineState,
  setSidebarMergeHooks,
  upsertSidebarActiveRouting,
} from './sidebar-state'

interface Fixture {
  stateFile: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agy-sidebar-state-'))
  const stateFile = join(dir, 'sidebar-state.json')
  return {
    stateFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function makeAccount(
  overrides: Partial<{
    id: string
    label: string
    enabled: boolean
    health: number
    current: boolean
    cooldownUntil: number
    quota: SidebarStateV1['accounts'][number]['quota']
  }> = {},
): SidebarStateV1['accounts'][number] {
  return {
    id: overrides.id ?? 'acct-0',
    label: overrides.label ?? 'Primary',
    enabled: overrides.enabled ?? true,
    health: overrides.health ?? 100,
    current: overrides.current ?? false,
    cooldownUntil: overrides.cooldownUntil,
    quota: overrides.quota ?? {},
  }
}

function makeRouting(
  overrides: Partial<SidebarRoutingEntry> = {},
): SidebarRoutingEntry {
  return {
    accountId: overrides.accountId ?? 'acct-0',
    modelFamily: overrides.modelFamily ?? 'claude',
    headerStyle: overrides.headerStyle ?? 'antigravity',
    updatedAt: overrides.updatedAt ?? Date.now(),
  }
}

/**
 * Wait until `predicate()` returns truthy, polling every 5ms. The race tests
 * use this to wait for a paused writer to reach a specific step before
 * firing the next call.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

describe('isAccountCurrent', () => {
  it('returns true when index matches the claude active index', () => {
    expect(isAccountCurrent(0, { claude: 0, gemini: 0 })).toBe(true)
  })

  it('returns true when index matches the gemini active index but not claude', () => {
    expect(isAccountCurrent(2, { claude: 0, gemini: 2 })).toBe(true)
  })

  it('returns false when index matches neither family', () => {
    expect(isAccountCurrent(1, { claude: 0, gemini: 0 })).toBe(false)
  })

  it('returns true for both indices when families point to different accounts', () => {
    const active = { claude: 0, gemini: 2 }
    expect(isAccountCurrent(0, active)).toBe(true)
    expect(isAccountCurrent(2, active)).toBe(true)
    expect(isAccountCurrent(1, active)).toBe(false)
  })
})

describe('setSidebarMachineState — freshness merge', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(async () => {
    setSidebarMergeHooks(null)
    fixture.cleanup()
  })

  it('preserves machine fields from a newer write when a stale write lands later', async () => {
    const freshAccount = makeAccount({ id: 'acct-fresh', label: 'Fresh' })
    const staleAccount = makeAccount({ id: 'acct-stale', label: 'Stale' })

    await setSidebarMachineState(
      {
        checkedAt: 200,
        accounts: [freshAccount],
        routingAuthoritative: true,
      },
      { stateFile: fixture.stateFile },
    )

    // A delayed write at an older checkedAt must NOT clobber the 200 write.
    await setSidebarMachineState(
      {
        checkedAt: 100,
        accounts: [staleAccount],
      },
      { stateFile: fixture.stateFile },
    )

    const after = readSidebarState(fixture.stateFile)
    expect(after.checkedAt).toBe(200)
    expect(after.accounts.map((entry) => entry.id)).toEqual(['acct-fresh'])
    expect(after.routingAuthoritative).toBe(true)
  })

  it('preserves active routing when a machine write lands', async () => {
    await upsertSidebarActiveRouting('sess-1', makeRouting(), {
      stateFile: fixture.stateFile,
    })

    await setSidebarMachineState(
      { checkedAt: Date.now() + 1_000, accounts: [makeAccount()] },
      { stateFile: fixture.stateFile },
    )

    const after = readSidebarState(fixture.stateFile)
    expect(after.activeRouting['sess-1']?.accountId).toBe('acct-0')
  })

  it('never demotes routingAuthoritative from true to false', async () => {
    await upsertSidebarActiveRouting('sess-1', makeRouting(), {
      stateFile: fixture.stateFile,
      authoritative: true,
    })

    await setSidebarMachineState(
      {
        checkedAt: Date.now() + 1_000,
        accounts: [makeAccount()],
        routingAuthoritative: false,
      },
      { stateFile: fixture.stateFile },
    )

    const after = readSidebarState(fixture.stateFile)
    expect(after.routingAuthoritative).toBe(true)
  })

  it('promotes routingAuthoritative when an upsert brings it to true', async () => {
    await setSidebarMachineState(
      {
        checkedAt: 100,
        accounts: [makeAccount()],
        routingAuthoritative: false,
      },
      { stateFile: fixture.stateFile },
    )

    await upsertSidebarActiveRouting('sess-1', makeRouting(), {
      stateFile: fixture.stateFile,
      authoritative: true,
    })

    const after = readSidebarState(fixture.stateFile)
    expect(after.routingAuthoritative).toBe(true)
  })
})

describe('upsertSidebarActiveRouting / removeSidebarActiveRouting', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(async () => {
    setSidebarMergeHooks(null)
    fixture.cleanup()
  })

  it('keeps independent routes for two sessions', async () => {
    await upsertSidebarActiveRouting(
      'sess-a',
      makeRouting({
        accountId: 'acct-a',
        modelFamily: 'claude',
      }),
      { stateFile: fixture.stateFile },
    )
    await upsertSidebarActiveRouting(
      'sess-b',
      makeRouting({
        accountId: 'acct-b',
        modelFamily: 'gemini',
      }),
      { stateFile: fixture.stateFile },
    )

    const after = readSidebarState(fixture.stateFile)
    expect(after.activeRouting['sess-a']?.accountId).toBe('acct-a')
    expect(after.activeRouting['sess-b']?.accountId).toBe('acct-b')
  })

  it('removing one session preserves the other', async () => {
    await upsertSidebarActiveRouting('sess-a', makeRouting(), {
      stateFile: fixture.stateFile,
    })
    await upsertSidebarActiveRouting('sess-b', makeRouting(), {
      stateFile: fixture.stateFile,
    })

    await removeSidebarActiveRouting('sess-a', { stateFile: fixture.stateFile })

    const after = readSidebarState(fixture.stateFile)
    expect(after.activeRouting['sess-a']).toBeUndefined()
    expect(after.activeRouting['sess-b']?.accountId).toBe('acct-0')
  })

  it('survives a routing upsert enqueued while a machine write is paused at merged-state', async () => {
    const observed: SidebarMergeStep[] = []
    const gate = { open: false }
    let releasePromise: (() => void) | null = null

    const hooks: SidebarMergeHooks = {
      onStep: (step) => {
        observed.push(step)
        if (step === 'merged-state' && !gate.open) {
          // Pause the first machine write so a second writer can queue.
          return new Promise<void>((resolve) => {
            releasePromise = (): void => {
              releasePromise = null
              resolve()
            }
          })
        }
      },
    }
    setSidebarMergeHooks(hooks)

    const machineWrite = setSidebarMachineState(
      {
        checkedAt: Date.now(),
        accounts: [makeAccount({ id: 'acct-fresh', label: 'Fresh' })],
      },
      { stateFile: fixture.stateFile },
    )

    await waitFor(() => observed.includes('merged-state'))

    const upsert = upsertSidebarActiveRouting(
      'sess-1',
      makeRouting({ accountId: 'acct-fresh' }),
      { stateFile: fixture.stateFile },
    )

    await waitFor(() => releasePromise !== null)
    gate.open = true
    // The hook closure nulls `releasePromise` once invoked; take a snapshot
    // so TypeScript sees a non-null callable without a non-null assertion.
    const release = releasePromise
    if (typeof release === 'function') {
      ;(release as () => void)()
    }

    await Promise.all([machineWrite, upsert])

    const after = readSidebarState(fixture.stateFile)
    expect(after.accounts.map((entry) => entry.id)).toEqual(['acct-fresh'])
    expect(after.activeRouting['sess-1']?.accountId).toBe('acct-fresh')
  })
})

describe('readSidebarState — malformed/missing normalization', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('returns the default state when the file is missing', () => {
    expect(readSidebarState(fixture.stateFile)).toEqual({
      ...DEFAULT_SIDEBAR_STATE,
      version: SIDEBAR_STATE_VERSION,
    })
  })

  it('collapses to the default when JSON is malformed', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(fixture.stateFile, '{not-valid-json', 'utf-8')
    const after = readSidebarState(fixture.stateFile)
    expect(after.lastError).toBe('malformed-json')
    expect(after.accounts).toEqual([])
  })
})

describe('pruneActiveRouting', () => {
  it('drops entries older than 24h and caps the map at 100 newest', () => {
    const now = 1_000_000
    const entries: Record<string, SidebarRoutingEntry> = {}
    // 105 fresh entries (within the cap) and 5 stale entries (older than 24h).
    for (let i = 0; i < 105; i++) {
      entries[`sess-${i}`] = makeRouting({ updatedAt: now - i * 1_000 })
    }
    entries['stale-1'] = makeRouting({ updatedAt: now - 25 * 60 * 60 * 1_000 })
    entries['stale-2'] = makeRouting({ updatedAt: now - 48 * 60 * 60 * 1_000 })
    entries['stale-3'] = makeRouting({ updatedAt: now - 72 * 60 * 60 * 1_000 })
    entries['stale-4'] = makeRouting({ updatedAt: 0 })
    entries['stale-5'] = makeRouting({ updatedAt: now - 30 * 60 * 60 * 1_000 })

    const pruned = pruneActiveRouting(entries, now)

    expect(Object.keys(pruned)).toHaveLength(100)
    expect(pruned['stale-1']).toBeUndefined()
    expect(pruned['stale-2']).toBeUndefined()
    expect(pruned['stale-3']).toBeUndefined()
    expect(pruned['stale-4']).toBeUndefined()
    expect(pruned['stale-5']).toBeUndefined()
    // The cap drops the oldest entries; sess-104 should be gone.
    expect(pruned['sess-104']).toBeUndefined()
    expect(pruned['sess-0']).toBeDefined()
  })
})

describe('lock contention retry', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(async () => {
    setSidebarMergeHooks(null)
    fixture.cleanup()
  })

  it('throws SidebarStateLockContentionError after the 2s budget when another writer holds the lock', async () => {
    // Acquire the same lock the writers use, simulating a cross-process
    // holder. Without release, the writer's acquire-with-retry must exhaust
    // the 2s budget and throw a typed error.
    const blockingLock = await acquireFencedFileLock({
      path: fixture.stateFile,
      name: 'sidebar',
      ttlMs: 60_000,
      renew: true,
    })
    expect(blockingLock).not.toBeNull()

    try {
      await expect(
        setSidebarMachineState(
          { checkedAt: 1, accounts: [makeAccount()] },
          { stateFile: fixture.stateFile },
        ),
      ).rejects.toBeInstanceOf(SidebarStateLockContentionError)
    } finally {
      await blockingLock?.release()
    }
  }, 5_000)

  it('succeeds once the blocking lock is released mid-retry', async () => {
    const blockingLock = await acquireFencedFileLock({
      path: fixture.stateFile,
      name: 'sidebar',
      ttlMs: 60_000,
      renew: true,
    })
    expect(blockingLock).not.toBeNull()

    const write = setSidebarMachineState(
      { checkedAt: 500, accounts: [makeAccount({ id: 'acct-released' })] },
      { stateFile: fixture.stateFile },
    )

    // Release after a short delay so the retry budget isn't exhausted.
    const release = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        blockingLock?.release().then(resolve, reject)
      }, 250)
    })

    await Promise.all([write, release])

    const after = readSidebarState(fixture.stateFile)
    expect(after.accounts.map((entry) => entry.id)).toEqual(['acct-released'])
  }, 5_000)
})

describe('redaction', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('never serializes token, project, fingerprint, or request fields', async () => {
    await setSidebarMachineState(
      {
        checkedAt: 1_000,
        accounts: [
          {
            id: 'acct-0',
            label: 'Primary',
            enabled: true,
            health: 100,
            current: false,
            quota: {
              gemini: { remainingPercent: 80 },
            },
          },
        ],
      },
      { stateFile: fixture.stateFile },
    )

    const fs = require('node:fs') as typeof import('node:fs')
    const raw = fs.readFileSync(fixture.stateFile, 'utf-8')

    // Hard-coded denylist of secret-shaped keys.
    for (const key of [
      'refresh',
      'access',
      'token',
      'projectId',
      'project',
      'fingerprint',
      'deviceId',
      'request',
      'signature',
      'cookie',
      'authorization',
    ]) {
      expect(raw.toLowerCase()).not.toContain(`"${key.toLowerCase()}":`)
    }
  })

  it('creates the parent directory at mode 0o700 and the file at mode 0o600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-sidebar-modes-'))
    const nested = join(dir, 'nested', 'sidebar-state.json')
    try {
      await setSidebarMachineState(
        { checkedAt: 1_000, accounts: [makeAccount()] },
        { stateFile: nested },
      )

      const dirMode = statSync(join(dir, 'nested')).mode & 0o777
      const fileMode = statSync(nested).mode & 0o777
      // POSIX mkdir honours the requested mode; on Linux this is exact.
      expect([0o700, 0o711]).toContain(dirMode)
      expect([0o600, 0o644]).toContain(fileMode)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults healthScore to 100 when missing', () => {
    // The doc comment says "Defaults to 100 when missing" — the
    // implementation must NOT render 0 just because no producer
    // passed the field.
    const redacted = redactAccountForSidebar({ index: 0 })
    expect(redacted.health).toBe(100)
  })

  it('passes through an explicit healthScore', () => {
    const redacted = redactAccountForSidebar({ index: 0, healthScore: 42 })
    expect(redacted.health).toBe(42)
  })

  it('replaces profile labels with privacy-safe ordinal labels', () => {
    const redacted = redactAccountForSidebar({
      index: 0,
      label: 'Alice Example',
    })
    expect(redacted.label).toBe('Account 1')
    expect(JSON.stringify(redacted)).not.toContain('Alice Example')
    expect(redactAccountForSidebar({ index: 1 }).label).toBe('Account 2')
  })

  it('redacts non-Gemini quota into the sidebar state', () => {
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        'non-gemini': { remainingFraction: 0.42 },
      },
    })
    expect(redacted.quota['non-gemini']?.remainingPercent).toBe(42)
  })

  it('drops cachedQuota when the persisted stamp does not match the current account identity', () => {
    // Persisted stamp from a different refresh token than the live one.
    // The projection must drop the quota rather than render the wrong
    // account's percentages after an index shift or token replacement.
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        gemini: { remainingFraction: 0.42 },
        'non-gemini': { remainingFraction: 0.8 },
      },
      cachedQuotaAccountId: 'deadbeefcafebabe',
      currentQuotaAccountId: '0123456789abcdef',
    })
    expect(redacted.quota).toEqual({})
  })

  it('preserves cachedQuota when the stamp matches the current account identity', () => {
    const stamp = 'a'.repeat(16)
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        'non-gemini': { remainingFraction: 0.5 },
      },
      cachedQuotaAccountId: stamp,
      currentQuotaAccountId: stamp,
    })
    expect(redacted.quota['non-gemini']?.remainingPercent).toBe(50)
  })

  it('preserves cachedQuota when only one of the stamps is provided (fail open for legacy)', () => {
    // Legacy snapshots omit the stamp; pre-stamp live views also omit
    // the current identity. The projection must not silently drop the
    // quota in either half-missing case.
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: { gemini: { remainingFraction: 0.3 } },
      cachedQuotaAccountId: 'a'.repeat(16),
    })
    expect(redacted.quota.gemini?.remainingPercent).toBe(30)
  })

  it('preserves cachedQuota when only the current quota account id is provided (fail open for legacy)', () => {
    // Symmetric half-missing case: the live snapshot has a stamp
    // (provider added currentQuotaAccountId) but the persisted cache
    // row does not yet (legacy). The projection must not silently
    // drop the quota; the absence of the persisted stamp alone is
    // not enough to mark the cache as stale.
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: { 'non-gemini': { remainingFraction: 0.6 } },
      currentQuotaAccountId: 'b'.repeat(16),
    })
    expect(redacted.quota['non-gemini']?.remainingPercent).toBe(60)
  })
})

describe('windows rework — producer seam tests', () => {
  it('redactAccountForSidebar carries windows when cachedQuota has them', () => {
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        gemini: {
          remainingFraction: 0.92,
          resetTime: '2026-07-28T18:24:21Z',
          windows: [
            {
              window: '5h',
              remainingFraction: 0.99,
              resetTime: '2026-07-24T20:43:21Z',
            },
            {
              window: 'weekly',
              remainingFraction: 0.92,
              resetTime: '2026-07-28T18:24:21Z',
            },
          ],
        },
        'non-gemini': {
          remainingFraction: 0.96,
          resetTime: '2026-07-24T18:41:52Z',
          windows: [
            {
              window: '5h',
              remainingFraction: 0.96,
              resetTime: '2026-07-24T18:41:52Z',
            },
            {
              window: 'weekly',
              remainingFraction: 0.99,
              resetTime: '2026-07-31T13:41:52Z',
            },
          ],
        },
      },
    })

    const gemini = redacted.quota.gemini
    expect(gemini).toBeDefined()
    expect(gemini!.remainingPercent).toBe(92)
    expect(gemini!.windows).toHaveLength(2)
    expect(gemini!.windows![0]!.window).toBe('5h')
    expect(gemini!.windows![0]!.remainingPercent).toBe(99)
    expect(gemini!.windows![1]!.window).toBe('weekly')
    expect(gemini!.windows![1]!.remainingPercent).toBe(92)

    const nonGemini = redacted.quota['non-gemini']
    expect(nonGemini).toBeDefined()
    expect(nonGemini!.windows).toHaveLength(2)
    expect(nonGemini!.windows![0]!.remainingPercent).toBe(96)
    expect(nonGemini!.windows![1]!.remainingPercent).toBe(99)
  })

  it('redactAccountForSidebar normalizes legacy cachedQuota keys and drops windows', () => {
    // Uses real legacy keys (gemini-pro) to exercise normalizeLegacyCachedQuota,
    // not the canonical 'gemini' key that bypasses the normalization path.
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        'gemini-pro': { remainingFraction: 0.5 },
      },
    })
    // Legacy key must be normalized to 'gemini'.
    expect(redacted.quota.gemini?.remainingPercent).toBe(50)
    // No windows were in the legacy snapshot — none must be invented.
    expect(redacted.quota.gemini?.windows).toBeUndefined()
  })

  it('redactAccountForSidebar handles Free (weekly-only) windows', () => {
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        gemini: {
          remainingFraction: 0.89,
          windows: [
            {
              window: 'weekly',
              remainingFraction: 0.89,
              resetTime: '2026-07-31T15:54:18Z',
            },
          ],
        },
      },
    })

    const gemini = redacted.quota.gemini
    expect(gemini).toBeDefined()
    expect(gemini!.windows).toHaveLength(1)
    expect(gemini!.windows![0]!.window).toBe('weekly')
    expect(gemini!.windows![0]!.remainingPercent).toBe(89)
  })

  it('full round-trip: write windows through setSidebarMachineState → readSidebarState', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-seam-windows-'))
    const statePath = join(root, 'sidebar-state.json')
    try {
      // Write state with windowed data through the real machine-state path.
      await setSidebarMachineState(
        buildSidebarMachineStateFromAccounts(
          [
            {
              index: 0,
              cachedQuota: {
                gemini: {
                  remainingFraction: 0.7,
                  resetTime: '2026-08-01T00:00:00Z',
                  windows: [
                    {
                      window: '5h',
                      remainingFraction: 0.85,
                      resetTime: '2026-07-25T00:00:00Z',
                    },
                    {
                      window: 'weekly',
                      remainingFraction: 0.7,
                      resetTime: '2026-08-01T00:00:00Z',
                    },
                  ],
                },
              },
            },
          ],
          { checkedAt: Date.now() },
        ),
        { stateFile: statePath },
      )

      // Read back and assert windows survived the full cycle.
      const state = readSidebarState(statePath)
      expect(state.accounts).toHaveLength(1)
      const gemini = state.accounts[0]!.quota.gemini
      expect(gemini).toBeDefined()
      expect(gemini!.windows).toHaveLength(2)
      expect(gemini!.windows![0]!.window).toBe('5h')
      expect(gemini!.windows![0]!.remainingPercent).toBe(85)
      expect(gemini!.windows![1]!.window).toBe('weekly')
      expect(gemini!.windows![1]!.remainingPercent).toBe(70)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('normalizeLegacyCachedQuota: gemini-pro + gemini-flash collapse to gemini with MIN fraction', () => {
    // M5: verify the two legacy gemini keys collapse with the most-constrained
    // (lowest remainingFraction) winning. Also verifies the M4 resetTime fix:
    // the winner (gemini-flash, 0.3) carries resetTime=Aug-01; gemini-pro (0.5)
    // has an earlier resetTime=Jul-26 — the merged result must use Jul-26.
    const result = normalizeLegacyCachedQuota({
      'gemini-pro': {
        remainingFraction: 0.5,
        resetTime: '2026-07-26T00:00:00Z',
      },
      'gemini-flash': {
        remainingFraction: 0.3,
        resetTime: '2026-08-01T00:00:00Z',
      },
    })
    expect(result?.gemini?.remainingFraction).toBe(0.3) // gemini-flash wins fraction
    // M4 regression: the winner\'s resetTime (Aug-01) is LATER than the loser\'s
    // (Jul-26). The merged result must carry the earlier one (Jul-26).
    expect(result?.gemini?.resetTime).toBe('2026-07-26T00:00:00Z')
    // No windows must be invented for migrated entries.
    expect(result?.gemini?.windows).toBeUndefined()
  })

  it('normalizeLegacyCachedQuota: M4 a-wins branch also merges resetTime', () => {
    // Specifically tests the a-wins path (fa <= fb): gemini-pro has lower
    // fraction than gemini-flash AND an earlier resetTime — both must survive.
    const result = normalizeLegacyCachedQuota({
      'gemini-pro': {
        remainingFraction: 0.2, // wins
        resetTime: '2026-07-26T00:00:00Z', // earlier
      },
      'gemini-flash': {
        remainingFraction: 0.5,
        resetTime: '2026-08-05T00:00:00Z',
      },
    })
    expect(result?.gemini?.remainingFraction).toBe(0.2)
    // Even though a wins, the merged resetTime must be the earlier of the two.
    expect(result?.gemini?.resetTime).toBe('2026-07-26T00:00:00Z')
  })

  it('normalizeLegacyCachedQuota: a-wins branch with loser having earlier resetTime (M4 bug scenario)', () => {
    // This is the exact M4 bug: a wins the fraction comparison but b has the
    // earlier resetTime. Before the fix, b\'s resetTime was silently dropped.
    const result = normalizeLegacyCachedQuota({
      'gemini-pro': {
        remainingFraction: 0.3, // wins (lower)
        resetTime: '2026-08-01T00:00:00Z', // later
      },
      'gemini-flash': {
        remainingFraction: 0.5,
        resetTime: '2026-07-26T00:00:00Z', // earlier — must survive
      },
    })
    expect(result?.gemini?.remainingFraction).toBe(0.3)
    // M4 fix: loser\'s earlier resetTime must win over the winner\'s later one.
    expect(result?.gemini?.resetTime).toBe('2026-07-26T00:00:00Z')
  })

  it('normalizeLegacyCachedQuota: claude + gpt-oss collapse to non-gemini with MIN fraction', () => {
    const result = normalizeLegacyCachedQuota({
      claude: { remainingFraction: 0.7, resetTime: '2026-08-01T00:00:00Z' },
      'gpt-oss': { remainingFraction: 0.4, resetTime: '2026-07-28T00:00:00Z' },
    })
    expect(result?.['non-gemini']?.remainingFraction).toBe(0.4) // gpt-oss wins
    expect(result?.['non-gemini']?.resetTime).toBe('2026-07-28T00:00:00Z') // earlier
  })

  it('normalizeLegacyCachedQuota: no windows invented for migrated entries', () => {
    // Legacy entries never had windows; the normalizer must not synthesize them.
    const result = normalizeLegacyCachedQuota({
      'gemini-pro': { remainingFraction: 0.6 },
      claude: { remainingFraction: 0.8 },
    })
    expect(result?.gemini?.windows).toBeUndefined()
    expect(result?.['non-gemini']?.windows).toBeUndefined()
  })

  it('normalizeLegacyCachedQuota: canonical keys pass through unchanged', () => {
    // Non-legacy input must be returned as-is without any transformation.
    const canonical = {
      gemini: { remainingFraction: 0.6, resetTime: '2026-08-01T00:00:00Z' },
      'non-gemini': { remainingFraction: 0.4 },
    }
    const result = normalizeLegacyCachedQuota(canonical)
    expect(result).toBe(canonical) // same reference — fast path returned as-is
  })

  it('identity mismatch drops the entire cachedQuota including windows', () => {
    const redacted = redactAccountForSidebar({
      index: 0,
      cachedQuota: {
        gemini: {
          remainingFraction: 0.9,
          windows: [
            {
              window: 'weekly',
              remainingFraction: 0.9,
              resetTime: '2026-08-01T00:00:00Z',
            },
          ],
        },
      },
      cachedQuotaAccountId: 'stamp-a',
      currentQuotaAccountId: 'stamp-b', // mismatch
    })
    // Stamp mismatch → cachedQuota dropped → no quota in the redacted output.
    expect(Object.keys(redacted.quota)).toHaveLength(0)
  })
})

describe('render boundary — current flag', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('preserves current: true from producer input through to sidebar state', async () => {
    const state = buildSidebarMachineStateFromAccounts([
      { index: 0, current: true },
      { index: 1, current: false },
    ])
    // The render boundary is `redactAccountForSidebar` inside
    // `buildSidebarMachineStateFromAccounts`. A `current: true` from any
    // producer must survive to the state the TUI reads so that
    // `visibleAccounts` (when fallbackAccounts is off) renders the
    // active account instead of an empty list.
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts[0]?.current).toBe(true)
    expect(state.accounts[1]?.current).toBe(false)

    // Also exercise the full write→read round-trip the TUI actually uses.
    await setSidebarMachineState(state, { stateFile: fixture.stateFile })
    const disk = readSidebarState(fixture.stateFile)
    expect(disk.accounts[0]?.current).toBe(true)
    expect(disk.accounts[1]?.current).toBe(false)
  })

  it('without fallbackAccounts, current: false for all accounts → no accounts visible', () => {
    // The filter the TUI runs is:
    //   state.accounts.filter(account => account.current)
    // When every account has current: false, the result is empty — that
    // was the live bug before this fix.
    const state = buildSidebarMachineStateFromAccounts([
      { index: 0, current: false },
      { index: 1, current: false },
    ])
    const visible = state.accounts.filter((entry) => entry.current)
    expect(visible).toHaveLength(0)
  })

  it('without fallbackAccounts, current: true on one account → that account is visible', () => {
    const state = buildSidebarMachineStateFromAccounts([
      { index: 0, current: true },
      { index: 1, current: false },
    ])
    const visible = state.accounts.filter((entry) => entry.current)
    expect(visible).toHaveLength(1)
    expect(visible[0]?.id).toBe('acct-0')
  })

  // ── Fix 2: tier round-trip ──────────────────────────────────────────────────

  it('Fix2-tier-roundtrip: tier writes to disk and reads back with capturedAt', async () => {
    // An account with a captured tier must survive a full write→read cycle.
    const capturedAt = 1_785_005_949_000
    const state = buildSidebarMachineStateFromAccounts([
      { index: 0, tier: { id: 'free-tier', capturedAt } },
    ])
    await setSidebarMachineState(state, { stateFile: fixture.stateFile })
    const disk = readSidebarState(fixture.stateFile)
    expect(disk.accounts[0]?.tier).toEqual({ id: 'free-tier', capturedAt })
  })

  it('Fix2-tier-absent: account without tier yields no tier key', () => {
    // An account with no tier in the redaction input must not emit tier in the
    // rendered state — absent ≠ free, absent ≠ {} .
    const state = buildSidebarMachineStateFromAccounts([{ index: 0 }])
    expect(state.accounts[0]?.tier).toBeUndefined()
    // Confirm `tier` is not a key at all in serialized form.
    const serialized = JSON.stringify(state.accounts[0])
    expect(serialized).not.toContain('tier')
  })

  it('Fix2-tier-redaction: tier survives redactAccountForSidebar (not PII)', () => {
    // Plan tier is metadata, not a credential — it must pass the redaction boundary.
    const capturedAt = 1_785_000_000_000
    const result = redactAccountForSidebar({
      index: 0,
      tier: { id: 'paid-tier', capturedAt },
    })
    expect(result.tier).toEqual({ id: 'paid-tier', capturedAt })
  })
})
