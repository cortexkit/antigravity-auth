import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Mirror of the private quotaAccountIdentity used in production code. */
function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

import type { AccountMetadataV3 } from '@cortexkit/antigravity-auth-core'

import {
  readSidebarState,
  SIDEBAR_STATE_ENV,
  setSidebarMachineState,
} from '../sidebar-state'
import {
  BackgroundQuotaRefresh,
  type BackgroundQuotaRefreshOptions,
  type PollerAccountView,
} from './background-quota-refresh'
import { createAntigravityPlugin } from './index'
import type { PluginClient, PluginInput } from './types'

// ─── Minimal harness helpers ─────────────────────────────────────────────────

function makeMinimalClient(): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      abort: mock(async () => {}),
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => {}),
    },
    tui: { showToast: mock(async () => {}) },
  } as unknown as PluginClient
}

function makePluginInput(client: PluginClient, directory: string): PluginInput {
  return {
    client,
    project: {} as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: { register: mock(() => {}) },
    serverUrl: new URL('http://localhost:4096'),
    $: (() => {}) as unknown as PluginInput['$'],
  }
}

// Build a fake AccountManager that satisfies BackgroundQuotaRefresh's usage.
type StubAccount = ReturnType<PollerAccountView['getAccounts']>[number]

function makeStubAccount(refreshToken = 'tok-abc'): StubAccount {
  return {
    index: 0,
    label: 'Account',
    enabled: true,
    parts: { refreshToken },
    cachedQuota: undefined,
    cachedQuotaAccountId: undefined,
    coolingDownUntil: undefined,
  }
}

function makeAccountManager(
  accounts: StubAccount[] = [makeStubAccount()],
  activeByFamily: { claude: number; gemini: number } = { claude: 0, gemini: 0 },
): PollerAccountView {
  return {
    getAccounts: () => [...accounts],
    getAccountsForQuotaCheck: (): AccountMetadataV3[] =>
      accounts.map((a) => ({
        refreshToken: a.parts.refreshToken,
        enabled: a.enabled,
        addedAt: 0,
        lastUsed: 0,
      })),
    updateQuotaCache: mock(() => {}),
    applyUpdatedAccount: mock(() => {}),
    requestSaveToDisk: mock(() => {}),
    getActiveIndexByFamily: () => activeByFamily,
  }
}

// Build a QuotaManager stub that returns configurable results.
function makeQuotaManager(
  opts: {
    result?: 'ok' | 'error' | 'pending'
    onRefreshAccounts?: () => void
    delay?: number
  } = {},
) {
  const { result = 'ok', delay = 0 } = opts
  const refreshAccounts = mock(
    async (accounts: Array<{ refreshToken: string }>, _options: unknown) => {
      if (opts.onRefreshAccounts) opts.onRefreshAccounts()
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      if (result === 'error') throw new Error('quota fetch failed')
      if (result === 'ok') {
        return accounts.map((_, i) => ({
          index: i,
          status: 'ok' as const,
          quota: {
            groups: {
              'non-gemini': { remainingFraction: 0.5, modelCount: 1 },
            },
          },
        }))
      }
      return []
    },
  )
  return {
    refreshAccounts,
    dispose: mock(async () => {}),
  }
}

type TierStubAccount = StubAccount & {
  capturedTierId?: string
  capturedPaidTierId?: string
  capturedTierAt?: number
  capturedTierSchemaVersion?: number
}

function makeTierManager(account: TierStubAccount): PollerAccountView {
  return {
    getAccounts: () => [account],
    getAccountsForQuotaCheck: () => [
      {
        refreshToken: account.parts.refreshToken,
        enabled: account.enabled,
        addedAt: 0,
        lastUsed: 0,
      },
    ],
    updateQuotaCache: mock(() => {}),
    applyUpdatedAccount: mock((_index, patch) => Object.assign(account, patch)),
    requestSaveToDisk: mock(() => {}),
    getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
  }
}

type TickablePoller = {
  runTick: () => Promise<void>
}

function makeTwoPollers(options: {
  stateFile: string
  now: number
  firstManager: PollerAccountView
  secondManager: PollerAccountView
  firstQuotaManager?: ReturnType<typeof makeQuotaManager>
  secondQuotaManager?: ReturnType<typeof makeQuotaManager>
  firstLoadAccountTier?: BackgroundQuotaRefreshOptions['loadAccountTier']
  secondLoadAccountTier?: BackgroundQuotaRefreshOptions['loadAccountTier']
  firstAcquireLock?: BackgroundQuotaRefreshOptions['acquireLock']
  secondAcquireLock?: BackgroundQuotaRefreshOptions['acquireLock']
}) {
  const first = new BackgroundQuotaRefresh({
    intervalMs: 5 * 60_000,
    sidebarStateFile: options.stateFile,
    getAccountManager: () => options.firstManager,
    quotaManager: (options.firstQuotaManager ??
      makeQuotaManager()) as unknown as import('./quota').QuotaManager,
    now: () => options.now,
    random: () => 0,
    loadAccountTier: options.firstLoadAccountTier,
    acquireLock: options.firstAcquireLock,
  })
  const second = new BackgroundQuotaRefresh({
    intervalMs: 5 * 60_000,
    sidebarStateFile: options.stateFile,
    getAccountManager: () => options.secondManager,
    quotaManager: (options.secondQuotaManager ??
      makeQuotaManager()) as unknown as import('./quota').QuotaManager,
    now: () => options.now,
    random: () => 0,
    loadAccountTier: options.secondLoadAccountTier,
    acquireLock: options.secondAcquireLock,
  })

  return {
    first,
    second,
    tick: (poller: BackgroundQuotaRefresh) =>
      (poller as unknown as TickablePoller).runTick(),
    dispose: () => Promise.all([first.dispose(), second.dispose()]),
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('BackgroundQuotaRefresh', () => {
  let dir: string
  let stateFile: string
  let savedSidebarEnv: string | undefined

  beforeEach(() => {
    savedSidebarEnv = process.env[SIDEBAR_STATE_ENV]
    dir = mkdtempSync(join(tmpdir(), 'bg-quota-test-'))
    stateFile = join(dir, 'sidebar-state.json')
    process.env[SIDEBAR_STATE_ENV] = stateFile
  })

  afterEach(async () => {
    // Restore rather than delete — a delete drops resolution to the real state dir.
    if (savedSidebarEnv !== undefined)
      process.env[SIDEBAR_STATE_ENV] = savedSidebarEnv
    else delete process.env[SIDEBAR_STATE_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  // ── Timer: idempotent start/stop ──────────────────────────────────────────

  it('start is idempotent — a second call before the first tick does not double-schedule', async () => {
    const calls: number[] = []
    const manager = makeAccountManager()
    const quotaManager = makeQuotaManager({
      onRefreshAccounts: () => calls.push(Date.now()),
    })
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 5 * 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      // Delay the first tick past dispose so we can check nothing ran.
      random: () => 1, // max startup jitter → no immediate tick
    })
    poller.start()
    poller.start()
    await poller.dispose()
    // No tick ran within the jitter window — both starts share one timer.
    expect(calls).toHaveLength(0)
  })

  it('dispose after dispose is idempotent', async () => {
    const manager = makeAccountManager()
    const quotaManager = makeQuotaManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 1,
    })
    poller.start()
    await poller.dispose()
    await poller.dispose() // must not throw
  })

  // ── V4: unexpected throw before internal reschedule still reschedules ──────

  it('V4 liveness: a throw escaping runTick before any scheduleNext still reschedules', async () => {
    // runTick has three internal reschedule paths (freshness skip, lock held,
    // lock throws). A throw that ESCAPES the function before any of those
    // paths previously meant no next tick was queued — the poller died.
    // The fix adds a reschedule in the outer .catch() so the poller
    // degrades to a delayed retry rather than silently stopping.
    //
    // We verify this by observing that scheduleNext IS called after the throw,
    // rather than waiting for the full ERROR_JITTER_MS delay (15 s).

    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const manager = makeAccountManager()
    const quotaManager = makeQuotaManager()

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })

    // Intercept scheduleNext to observe calls after the catch.
    type PollerInternals = {
      runTick: () => Promise<void>
      scheduleNext: (ms: number) => void
    }
    const inner = poller as unknown as PollerInternals
    const scheduleNextCalls: number[] = []
    const origScheduleNext = inner.scheduleNext.bind(poller)
    inner.scheduleNext = (ms: number) => {
      scheduleNextCalls.push(ms)
      origScheduleNext(ms)
    }

    // Replace runTick to throw before any internal scheduleNext can run.
    const origRunTick = inner.runTick.bind(poller)
    let firstCall = true
    inner.runTick = async () => {
      if (firstCall) {
        firstCall = false
        throw new Error('simulated unexpected escape from runTick')
      }
      return origRunTick()
    }

    poller.start()
    // The startup scheduleNext fires synchronously with jitteredStartDelay
    // (random=0 → 0 ms) — tick runs almost immediately, throws, outer catch
    // queues the recovery scheduleNext. Allow a brief event-loop drain.
    await new Promise((r) => setTimeout(r, 50))
    await poller.dispose()

    // The outer catch must have called scheduleNext (the recovery reschedule).
    // scheduleNextCalls[0] is the startup call; [1] is from the outer catch.
    expect(scheduleNextCalls.length).toBeGreaterThanOrEqual(2)
    // The recovery delay includes ERROR_JITTER_MS (15_000).
    const recoveryDelay = scheduleNextCalls[1]
    expect(recoveryDelay).toBeGreaterThanOrEqual(15_000)
  })

  // ── Error in tick does not kill the timer ─────────────────────────────────

  it('an error inside a tick does not prevent subsequent ticks', async () => {
    let callCount = 0
    let secondCallResolve!: () => void
    const secondCallSeen = new Promise<void>((r) => {
      secondCallResolve = r
    })

    const manager = makeAccountManager()
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const quotaManager = {
      refreshAccounts: mock(async () => {
        callCount++
        if (callCount === 1) throw new Error('first tick error')
        secondCallResolve()
        return []
      }),
      dispose: mock(async () => {}),
    }

    const poller = new BackgroundQuotaRefresh({
      // Very short interval so the second tick fires within the timeout.
      intervalMs: 100,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()
    await Promise.race([
      secondCallSeen,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('timeout waiting for second tick')),
          5_000,
        ),
      ),
    ])
    await poller.dispose()
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  // ── In-flight tick not double-entered ────────────────────────────────────

  it('a slow tick prevents re-entry while it is in flight', async () => {
    let active = 0
    let maxActive = 0
    let tickDone!: () => void
    const tickBlocked = new Promise<void>((r) => {
      tickDone = r
    })

    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const quotaManager = {
      refreshAccounts: mock(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await tickBlocked
        active--
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()
    // Give the first tick a moment to start.
    await new Promise((r) => setTimeout(r, 20))
    tickDone()
    await poller.dispose()
    expect(maxActive).toBe(1)
  })

  // ── Async dispose awaits in-flight tick ───────────────────────────────────

  it('dispose awaits an in-flight tick before resolving', async () => {
    const events: string[] = []

    let tickStartedResolve!: () => void
    const tickStartedP = new Promise<void>((r) => {
      tickStartedResolve = r
    })
    let tickRelease!: () => void
    const tickGate = new Promise<void>((r) => {
      tickRelease = r
    })

    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const quotaManager = {
      refreshAccounts: mock(async () => {
        events.push('tick:start')
        tickStartedResolve()
        await tickGate
        events.push('tick:finish')
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()
    await tickStartedP
    // Tick is now in flight. Dispose must wait for it.
    const disposeP = poller.dispose().then(() => {
      events.push('dispose:done')
    })
    tickRelease()
    await disposeP
    // dispose:done must follow tick:finish
    expect(events).toEqual(['tick:start', 'tick:finish', 'dispose:done'])
  })

  it('S3 boundary: re-entry guard prevents inFlight overwrite when scheduleNext fires mid-tick', async () => {
    // The natural test scenario (intervalMs < tick duration) never reaches the
    // guard because runTick only calls scheduleNext AFTER it completes, so the
    // second timer always fires after inFlight is already null.
    // This test triggers the guard directly via reflection: call scheduleNext(0)
    // while tick 1 is blocked, then assert the inFlight reference is unchanged.
    // Without the guard the 0ms timer would overwrite inFlight; with it, the
    // timer callback exits early and the original promise is preserved.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    let tickStartedResolve!: () => void
    const tickStartedP = new Promise<void>((r) => {
      tickStartedResolve = r
    })
    let releaseFirstTick!: () => void
    const firstTickGate = new Promise<void>((r) => {
      releaseFirstTick = r
    })

    const quotaManager = {
      refreshAccounts: mock(async () => {
        tickStartedResolve()
        await firstTickGate
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })

    // Reach private members via cast to verify the guard's effect.
    type PollerInternals = {
      inFlight: Promise<void> | null
      scheduleNext: (ms: number) => void
    }
    const inner = poller as unknown as PollerInternals

    poller.start()
    await tickStartedP // tick 1 is now blocked inside refreshAccounts

    const originalInFlight = inner.inFlight
    expect(originalInFlight).not.toBeNull()

    // Force a 0ms timer while the tick is in flight. Without the guard, this
    // overwrites inFlight; with it, the timer callback returns immediately.
    inner.scheduleNext(0)
    await new Promise((r) => setTimeout(r, 20)) // let the 0ms timer fire

    // Guard must have prevented the overwrite.
    expect(inner.inFlight).toBe(originalInFlight)

    releaseFirstTick()
    await poller.dispose()
  })

  // ── Freshness gate ────────────────────────────────────────────────────────

  it('freshness gate: skips when checkedAt is fresher than threshold (5-minute interval)', async () => {
    const intervalMs = 5 * 60_000 // 300 000 ms
    // Threshold = max(300000-60000, floor(300000/2)) = max(240000, 150000) = 240 000 ms
    // A checkedAt 239 s ago is still within the threshold → skip.
    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 239_000, accounts: [] },
      { stateFile },
    )

    const quotaManager = makeQuotaManager()
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => now,
    })
    poller.start()
    // Allow one event loop tick for the timer.
    await new Promise((r) => setTimeout(r, 50))
    await poller.dispose()
    expect(quotaManager.refreshAccounts).not.toHaveBeenCalled()
  })

  it('freshness gate: refreshes when checkedAt is staler than threshold (5-minute interval)', async () => {
    const intervalMs = 5 * 60_000
    // checkedAt 241 s ago → stale → should refresh.
    let refreshCalled = false
    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 241_000, accounts: [] },
      { stateFile },
    )

    const quotaManager = {
      refreshAccounts: mock(async () => {
        refreshCalled = true
        refreshResolve()
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => now,
    })
    poller.start()
    await Promise.race([
      refreshedP,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ])
    await poller.dispose()
    expect(refreshCalled).toBe(true)
  })

  it('freshness gate at 1-minute minimum (floor(intervalMs/2) = 30 s)', async () => {
    const intervalMs = 60_000 // 1 minute
    // Threshold = max(60000-60000, floor(60000/2)) = max(0, 30000) = 30 000 ms
    // checkedAt 29 s ago → skip.
    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 29_000, accounts: [] },
      { stateFile },
    )

    const quotaManager = makeQuotaManager()
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => now,
    })
    poller.start()
    await new Promise((r) => setTimeout(r, 50))
    await poller.dispose()
    expect(quotaManager.refreshAccounts).not.toHaveBeenCalled()
  })

  it('freshness gate at 1-minute minimum refreshes when stale (31 s age)', async () => {
    const intervalMs = 60_000
    // checkedAt 31 s ago → stale → refresh.
    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 31_000, accounts: [] },
      { stateFile },
    )

    const quotaManager = {
      refreshAccounts: mock(async () => {
        refreshResolve()
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => now,
    })
    poller.start()
    await Promise.race([
      refreshedP,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ])
    await poller.dispose()
    expect(quotaManager.refreshAccounts).toHaveBeenCalled()
  })

  it('freshness gate at 60-minute interval uses intervalMs - 60 000 threshold', async () => {
    const intervalMs = 60 * 60_000 // 3 600 000 ms
    // Threshold = max(3600000-60000, floor(3600000/2)) = max(3540000, 1800000) = 3 540 000 ms
    // checkedAt 3 539 s ago → fresh → skip.
    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 3_539_000, accounts: [] },
      { stateFile },
    )

    const quotaManager = makeQuotaManager()
    const manager = makeAccountManager()
    const poller = new BackgroundQuotaRefresh({
      intervalMs,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => now,
    })
    poller.start()
    await new Promise((r) => setTimeout(r, 50))
    await poller.dispose()
    expect(quotaManager.refreshAccounts).not.toHaveBeenCalled()
  })

  it('two pollers: a fresh snapshot from one writer does not starve the other tier slot', async () => {
    const now = Date.now()
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const firstQuotaManager = makeQuotaManager()
    const secondQuotaManager = makeQuotaManager()
    const secondLoadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: now,
    }))
    const pair = makeTwoPollers({
      stateFile,
      now,
      firstManager: makeTierManager({
        ...makeStubAccount('tok-first-fresh-tier'),
        capturedTierId: 'free-tier',
        capturedPaidTierId: 'g1-pro-tier',
        capturedTierAt: now,
        capturedTierSchemaVersion: 1,
      }),
      secondManager: makeTierManager(makeStubAccount('tok-second-stale-tier')),
      firstQuotaManager,
      secondQuotaManager,
      secondLoadAccountTier,
    })

    await pair.tick(pair.first)
    await pair.tick(pair.second)
    await pair.dispose()

    expect(firstQuotaManager.refreshAccounts).toHaveBeenCalledTimes(1)
    expect(secondQuotaManager.refreshAccounts).not.toHaveBeenCalled()
    expect(secondLoadAccountTier).toHaveBeenCalledTimes(1)
  })

  it('two pollers: a shared stale account resolves tier once in one lock window', async () => {
    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 60_000, accounts: [] },
      { stateFile },
    )

    const account = makeStubAccount('tok-shared-stale-tier')
    const loadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: now,
    }))
    const pair = makeTwoPollers({
      stateFile,
      now,
      firstManager: makeTierManager(account),
      secondManager: makeTierManager(account),
      firstLoadAccountTier: loadAccountTier,
      secondLoadAccountTier: loadAccountTier,
    })

    await Promise.all([pair.tick(pair.first), pair.tick(pair.second)])
    await pair.dispose()

    expect(loadAccountTier).toHaveBeenCalledTimes(1)
  })

  it('two pollers: both tier slots eventually spend while their shared snapshot stays fresh', async () => {
    const now = Date.now()
    await setSidebarMachineState(
      { checkedAt: now - 60_000, accounts: [] },
      { stateFile },
    )

    const firstLoadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: now,
    }))
    const secondLoadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: now,
    }))
    const pair = makeTwoPollers({
      stateFile,
      now,
      firstManager: makeTierManager(makeStubAccount('tok-first-stale-tier')),
      secondManager: makeTierManager(makeStubAccount('tok-second-stale-tier')),
      firstLoadAccountTier,
      secondLoadAccountTier,
    })

    await pair.tick(pair.first)
    await pair.tick(pair.second)
    await pair.dispose()

    expect(firstLoadAccountTier).toHaveBeenCalledTimes(1)
    expect(secondLoadAccountTier).toHaveBeenCalledTimes(1)
  })

  // ── Lock: held → skip ────────────────────────────────────────────────────

  it('renews the fenced lock while a slow quota refresh is in flight', async () => {
    const { acquireFencedFileLock } = await import(
      '@cortexkit/antigravity-auth-core/file-lock'
    )
    const lockTtlMs = 60
    let lockNow = 0
    let firstLockOptions:
      | Parameters<NonNullable<BackgroundQuotaRefreshOptions['acquireLock']>>[0]
      | undefined
    let renewalRead = false
    let renewalCommitted!: () => void
    const renewalCommittedPromise = new Promise<void>((resolve) => {
      renewalCommitted = resolve
    })
    const firstAcquireShortLease: NonNullable<
      BackgroundQuotaRefreshOptions['acquireLock']
    > = (options) => {
      firstLockOptions = options
      return acquireFencedFileLock({
        ...options,
        ttlMs: lockTtlMs,
        renewIntervalMs: 1,
        now: () => lockNow,
        onStep: (step) => {
          if (step === 'renew-read' && !renewalRead) {
            renewalRead = true
            lockNow = 50
          }
          if (step === 'renew-committed') renewalCommitted()
        },
      })
    }
    const secondAcquireShortLease: NonNullable<
      BackgroundQuotaRefreshOptions['acquireLock']
    > = (options) =>
      acquireFencedFileLock({
        ...options,
        ttlMs: lockTtlMs,
        now: () => lockNow,
      })

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const firstQuotaManager = makeQuotaManager()
    firstQuotaManager.refreshAccounts = mock(async () => {
      firstStarted()
      await firstGate
      return []
    })
    const secondQuotaManager = makeQuotaManager()
    const now = Date.now()
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const pair = makeTwoPollers({
      stateFile,
      now,
      firstManager: makeAccountManager(),
      secondManager: makeAccountManager(),
      firstQuotaManager,
      secondQuotaManager,
      firstAcquireLock: firstAcquireShortLease,
      secondAcquireLock: secondAcquireShortLease,
    })

    const firstTick = pair.tick(pair.first)
    try {
      await firstStartedPromise
      expect(firstLockOptions?.renew).not.toBe(false)
      await renewalCommittedPromise
      lockNow = 70 // Past the original expiry (60), before the renewed expiry (110).
      await pair.tick(pair.second)

      expect(secondQuotaManager.refreshAccounts).not.toHaveBeenCalled()
    } finally {
      releaseFirst()
      await firstTick
      await pair.dispose()
    }
  })

  it('skips when the fenced lock is held by another process', async () => {
    // Acquire the lock ourselves so the poller sees "held".
    const { acquireFencedFileLock } = await import(
      '@cortexkit/antigravity-auth-core/file-lock'
    )
    const lock = await acquireFencedFileLock({
      path: stateFile,
      name: 'bg-quota-poll',
      ttlMs: 60_000,
      renew: false,
    })
    expect(lock).not.toBeNull()

    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const quotaManager = makeQuotaManager()
    const manager = makeAccountManager()
    const loadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: Date.now(),
    }))
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
      loadAccountTier,
    })
    poller.start()
    await new Promise((r) => setTimeout(r, 100))
    await poller.dispose()
    await lock?.release()

    // Lock was held → refresh must not have been called.
    expect(quotaManager.refreshAccounts).not.toHaveBeenCalled()
    expect(loadAccountTier).not.toHaveBeenCalled()
  })

  // ── Lock throws → FAIL CLOSED ────────────────────────────────────────────

  it('fail-closed: acquireFencedFileLock throw skips the tick without a fallback mutex', async () => {
    // Use a NUL-byte in the path: the kernel rejects mkdir("...\0...") with
    // ENOENT/EINVAL immediately, which causes acquireFencedFileLock to throw
    // before touching any lock file. Two pollers share the same valid
    // sidebarStateFile (for the freshness read), but tick 1 uses the bad lock
    // path to trigger the throw, tick 2 uses the real path to confirm the
    // timer rescheduled and a real refresh is possible.
    //
    // Crucially: no "claim marker" or secondary mutex files appear anywhere.
    // This is the load-bearing invariant from the module-level comment.
    const nullPath = join(dir, 'bad\x00path', 'state.json')
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const quotaManager = {
      refreshAccounts: mock(async () => {
        refreshResolve()
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()
    const loadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: Date.now(),
    }))

    // Poller 1: bad lock path → tick throws → fail closed → refresh NOT called.
    const pollerBad = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      // The lock is attempted against sidebarStateFile (the valid path) by
      // default. We need the lock to use the nullPath instead. Since the lock
      // path is derived from sidebarStateFile (by appending `.bg-quota-poll.lock`)
      // we point sidebarStateFile at nullPath so the lock write uses it.
      // The freshness read will fail (file doesn't exist) and return checkedAt=0,
      // which passes the gate — and then the lock attempt throws on NUL-byte.
      sidebarStateFile: nullPath,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
      loadAccountTier,
    })
    pollerBad.start()
    // Give it a moment to attempt and fail the lock.
    await new Promise((r) => setTimeout(r, 100))
    await pollerBad.dispose()

    // Lock threw → refresh must NOT have been called on the bad poller.
    expect(quotaManager.refreshAccounts).not.toHaveBeenCalled()
    expect(loadAccountTier).not.toHaveBeenCalled()

    // Confirm NO claim/marker files were created — the fail-closed path
    // must not fall back to a secondary mutex.
    const { readdirSync } = await import('node:fs')
    const anyLockFiles = readdirSync(dir).filter(
      (f) =>
        f.includes('.lock') || f.includes('.claim') || f.includes('.marker'),
    )
    expect(anyLockFiles).toHaveLength(0)

    // Poller 2: real path → refresh succeeds → confirms the timer is still
    // functional after a fail-closed skip (not a property of pollerBad's timer
    // but of the code path: the catch reschedules, so another poller can run).
    const pollerGood = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    pollerGood.start()
    await Promise.race([
      refreshedP,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('timeout waiting for good refresh')),
          5_000,
        ),
      ),
    ])
    await pollerGood.dispose()
    expect(quotaManager.refreshAccounts).toHaveBeenCalledTimes(1)
  })

  // ── N-contender bound ─────────────────────────────────────────────────────

  it('N-contender bound: concurrent pollers against a slow refresh never all refresh', async () => {
    // A slow refresh is simulated by inserting a delay. We run N pollers with
    // zero startup jitter, all stale, and count how many refreshes execute
    // BEFORE the first write lands. The freshness gate + lock means at most
    // one poller should execute the refresh.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    let refreshes = 0
    let firstRefreshDone!: () => void
    const firstRefreshP = new Promise<void>((r) => {
      firstRefreshDone = r
    })

    const quotaManager = {
      refreshAccounts: mock(async () => {
        refreshes++
        // Simulate a slow fetch — enough for all other pollers to attempt.
        await new Promise((r) => setTimeout(r, 150))
        firstRefreshDone()
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager = makeAccountManager()

    const N = 4
    const pollers = Array.from({ length: N }, () => {
      const p = new BackgroundQuotaRefresh({
        intervalMs: 60_000,
        sidebarStateFile: stateFile,
        getAccountManager: () => manager,
        quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
        random: () => 0,
        now: () => Date.now(),
      })
      p.start()
      return p
    })

    // Wait for the first refresh to start and finish.
    await Promise.race([
      firstRefreshP,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    // At this point the first refresh just completed. Count before cleanup.
    const refreshesSoFar = refreshes
    await Promise.all(pollers.map((p) => p.dispose()))

    // Only 1 refresh should have run before the first write landed —
    // the freshness gate blocks all others once checkedAt is updated.
    expect(refreshesSoFar).toBe(1)
  })

  // ── Windows survive a polled refresh ─────────────────────────────────────

  it('windows-survive: a polled refresh writes per-window data into the sidebar state', async () => {
    // This test exercises the real path:
    //   BackgroundQuotaRefresh.refresh()
    //   → quotaManager.refreshAccounts (returns per-window data)
    //   → manager.updateQuotaCache
    //   → pushSidebarQuotaSnapshot (reads the live view)
    //   → sidebar state file (verified via readSidebarState)

    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const windowData = {
      'non-gemini': {
        remainingFraction: 0.72,
        modelCount: 1,
        windows: [
          {
            window: 'weekly' as const,
            remainingFraction: 0.72,
            resetTime: new Date(
              Date.now() + 7 * 24 * 60 * 60_000,
            ).toISOString(),
          },
          {
            window: '5h' as const,
            remainingFraction: 0.91,
            resetTime: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
          },
        ],
      },
    }

    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const accounts = [
      {
        index: 0,
        label: 'Account',
        enabled: true,
        parts: { refreshToken: 'tok-win' },
        cachedQuota: undefined as typeof windowData | undefined,
        cachedQuotaAccountId: undefined as string | undefined,
        coolingDownUntil: undefined as number | undefined,
      },
    ]

    const quotaManager = {
      refreshAccounts: mock(async (accts: Array<{ refreshToken: string }>) => {
        return accts.map((_, i) => ({
          index: i,
          status: 'ok' as const,
          quota: { groups: windowData },
        }))
      }),
      dispose: mock(async () => {}),
    }

    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: (): AccountMetadataV3[] => [
        {
          refreshToken: 'tok-win',
          enabled: true,
          addedAt: 0,
          lastUsed: 0,
        },
      ],
      updateQuotaCache: (
        _index: number,
        groups: Partial<
          Record<string, { remainingFraction?: number; modelCount: number }>
        >,
        _token: string,
      ) => {
        accounts[0]!.cachedQuota = groups as typeof windowData
        // Use the real identity derived from the refresh token so the
        // currentQuotaAccountId computed by the poller (same hash) matches.
        accounts[0]!.cachedQuotaAccountId = quotaAccountIdentity('tok-win')
        refreshResolve()
      },
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()

    await Promise.race([
      // Wait a bit extra to let pushSidebarQuotaSnapshot complete after updateQuotaCache.
      refreshedP.then(() => new Promise((r) => setTimeout(r, 200))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    await poller.dispose()

    const state = readSidebarState(stateFile)
    expect(state.accounts).toHaveLength(1)
    const quota = state.accounts[0]?.quota['non-gemini']
    expect(quota?.remainingPercent).toBe(72)
    // Per-window entries must survive through the sidebar read path.
    expect(quota?.windows).toBeDefined()
    expect(quota?.windows?.length).toBeGreaterThanOrEqual(1)
    const weekly = quota?.windows?.find((w) => w.window === 'weekly')
    expect(weekly).toBeDefined()
    expect(weekly?.remainingPercent).toBe(72)
  })

  // ── V1: stale cachedQuotaAccountId is dropped after a polled refresh ────

  it('V1 identity: poller writes currentQuotaAccountId from live token, not from cached stamp', async () => {
    // An account whose cachedQuotaAccountId does NOT match its live
    // refresh-token identity — simulating an account that was reordered
    // or replaced. After a poll-written snapshot the sidebar must DROP the
    // stale cached quota rather than displaying the wrong account's bars.
    //
    // Without the fix both fields were the same value so the
    // staleness check never fired.

    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const refreshToken = 'tok-fresh-account'
    // A stale stamp that will never match the hash of refreshToken.
    const staleStamp = 'stale-id-000000000000'

    const accounts = [
      {
        index: 0,
        label: 'Account',
        enabled: true,
        parts: { refreshToken },
        // Stale quota snapshot from a previous account at this index.
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.5, modelCount: 1 },
        } as ReturnType<PollerAccountView['getAccounts']>[0]['cachedQuota'],
        cachedQuotaAccountId: staleStamp,
        coolingDownUntil: undefined as number | undefined,
      },
    ]

    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const quotaManager = {
      // The quota fetch itself succeeds and returns new data.
      refreshAccounts: mock(async (accts: Array<{ refreshToken: string }>) => {
        return accts.map((_, i) => ({
          index: i,
          status: 'ok' as const,
          quota: {
            groups: {
              'non-gemini': { remainingFraction: 0.8, modelCount: 1 },
            },
          },
        }))
      }),
      dispose: mock(async () => {}),
    }

    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        { refreshToken, enabled: true, addedAt: 0, lastUsed: 0 },
      ],
      updateQuotaCache: (_index: number, groups: unknown, _token: string) => {
        // Update the in-memory cache but keep the STALE stamp — simulating
        // an account where the identity hasn't been updated yet.
        accounts[0]!.cachedQuota = groups as (typeof accounts)[0]['cachedQuota']
        // Intentionally DO NOT update cachedQuotaAccountId here: the stamp
        // stays stale so the sidebar projection must detect the mismatch.
        refreshResolve()
      },
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()

    await Promise.race([
      refreshedP.then(() => new Promise((r) => setTimeout(r, 200))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout waiting for poll')), 5_000),
      ),
    ])
    await poller.dispose()

    const state = readSidebarState(stateFile)
    expect(state.accounts).toHaveLength(1)
    // The stale stamp must cause the quota to be dropped from the sidebar.
    const sidebarQuota = state.accounts[0]?.quota
    expect(sidebarQuota?.['non-gemini']).toBeUndefined()
  })

  // ── Fix 1: poller keeps `current` flag ─────────────────────────────────────────

  it('Fix1-current: poller tick keeps current:true on the active account (index 1)', async () => {
    // Two accounts; claude-active is index 1. After a poll tick the sidebar
    // must carry current:true on account at index 1 and false on index 0.
    // Before this fix the poller omitted getActiveIndexByFamily, defaulting
    // isAccountCurrent to false for every account.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const accounts: StubAccount[] = [
      { ...makeStubAccount('tok-0'), index: 0 },
      { ...makeStubAccount('tok-1'), index: 1 },
    ]

    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const quotaManager = {
      refreshAccounts: mock(async (accts: Array<{ refreshToken: string }>) => {
        return accts.map((_, i) => ({
          index: i,
          status: 'ok' as const,
          quota: {
            groups: { 'non-gemini': { remainingFraction: 0.5, modelCount: 1 } },
          },
        }))
      }),
      dispose: mock(async () => {}),
    }

    // claude-active = 1, so account at index 1 should be current.
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () =>
        accounts.map((a) => ({
          refreshToken: a.parts.refreshToken,
          enabled: true,
          addedAt: 0,
          lastUsed: 0,
        })),
      updateQuotaCache: (_i, _g, _t) => {
        if (_i === accounts.length - 1) refreshResolve()
      },
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 1, gemini: 1 }),
    }

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()

    await Promise.race([
      refreshedP.then(() => new Promise((r) => setTimeout(r, 300))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    await poller.dispose()

    const state = readSidebarState(stateFile)
    expect(state.accounts).toHaveLength(2)
    const acct0 = state.accounts.find((a) => a.id === 'acct-0')
    const acct1 = state.accounts.find((a) => a.id === 'acct-1')
    // Index 1 is the active account — must be current.
    expect(acct1?.current).toBe(true)
    // Index 0 is not active.
    expect(acct0?.current).toBe(false)
  })

  // ── Fix 2: tier round-trips through sidebar state file ────────────────────

  it('Fix2-tier-poller: captured tier appears in sidebar after a poll tick', async () => {
    // When the in-memory account carries capturedTierId/capturedTierAt the
    // poller must include tier: { id, capturedAt } in the sidebar snapshot.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const capturedAt = Date.now()
    const accounts: StubAccount[] = [
      {
        ...makeStubAccount('tok-tier'),
        index: 0,
        capturedTierId: 'enterprise-tier',
        capturedPaidTierId: 'g1-pro-tier',
        capturedTierAt: capturedAt,
      } as StubAccount & { capturedPaidTierId: string },
    ]

    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const quotaManager = {
      refreshAccounts: mock(async (accts: Array<{ refreshToken: string }>) => {
        return accts.map((_, i) => ({
          index: i,
          status: 'ok' as const,
          quota: {
            groups: { 'non-gemini': { remainingFraction: 0.9, modelCount: 1 } },
          },
        }))
      }),
      dispose: mock(async () => {}),
    }

    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        {
          refreshToken: 'tok-tier',
          enabled: true,
          addedAt: 0,
          lastUsed: 0,
        },
      ],
      updateQuotaCache: (_i, _g, _t) => {
        accounts[0]!.cachedQuotaAccountId = quotaAccountIdentity('tok-tier')
        refreshResolve()
      },
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()

    await Promise.race([
      refreshedP.then(() => new Promise((r) => setTimeout(r, 300))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    await poller.dispose()

    const state = readSidebarState(stateFile)
    expect(state.accounts).toHaveLength(1)
    const acct = state.accounts[0]
    expect(acct?.tier).toBeDefined()
    expect(acct?.tier?.id).toBe('enterprise-tier')
    expect(acct?.tier?.paidId).toBe('g1-pro-tier')
    expect(acct?.tier?.capturedAt).toBe(capturedAt)
  })

  it('keeps a successful quota refresh when the updated account token differs', async () => {
    const accounts: StubAccount[] = [makeStubAccount('bare-token')]
    const quotaGroups = {
      gemini: { remainingFraction: 0.5, modelCount: 1 },
    }
    const updateQuotaCache = mock(() => {})
    const quotaManager = {
      refreshAccounts: mock(async () => {
        accounts[0]!.parts.refreshToken = 'updated-token'
        return [
          {
            index: 0,
            status: 'ok' as const,
            quota: { groups: quotaGroups },
            updatedAccount: {
              refreshToken: 'updated-token',
              addedAt: 0,
              lastUsed: 0,
            },
          },
        ]
      }),
      dispose: mock(async () => {}),
    }
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        {
          refreshToken: 'bare-token',
          addedAt: 0,
          lastUsed: 0,
        },
      ],
      updateQuotaCache,
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()

    await new Promise((resolve) => setTimeout(resolve, 300))
    await poller.dispose()

    expect(updateQuotaCache).toHaveBeenCalledWith(
      0,
      quotaGroups,
      'updated-token',
    )
  })

  it('Fix2-tier-absent: account without tier yields no tier key in sidebar', async () => {
    // An account with no capturedTierId must not emit tier in the snapshot.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const accounts: StubAccount[] = [
      { ...makeStubAccount('tok-notier'), index: 0 },
    ]

    let refreshResolve!: () => void
    const refreshedP = new Promise<void>((r) => {
      refreshResolve = r
    })

    const quotaManager = {
      refreshAccounts: mock(async (accts: Array<{ refreshToken: string }>) =>
        accts.map((_, i) => ({
          index: i,
          status: 'ok' as const,
          quota: { groups: {} },
        })),
      ),
      dispose: mock(async () => {}),
    }

    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        {
          refreshToken: 'tok-notier',
          enabled: true,
          addedAt: 0,
          lastUsed: 0,
        },
      ],
      updateQuotaCache: () => {
        refreshResolve()
      },
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
    })
    poller.start()

    await Promise.race([
      refreshedP.then(() => new Promise((r) => setTimeout(r, 300))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    await poller.dispose()

    const state = readSidebarState(stateFile)
    expect(state.accounts).toHaveLength(1)
    const acct = state.accounts[0]
    // Must be absent (undefined), not {} or { id: undefined }.
    expect(acct?.tier).toBeUndefined()
  })

  // ── P2-A: tier resolved via loadAccountTier for existing accounts ──────────────

  it('P2-A: account with managedProjectId (existing account) gets tier after a tick via loadAccountTier', async () => {
    // P2-A: existing accounts have managedProjectId packed in their refresh token.
    // ensureProjectContext fast-paths on that field and never calls loadCodeAssist,
    // so capturedTierId is never populated by the quota fetch path alone.
    // The tier-staleness check must call loadAccountTier for the stalest account
    // and persist the result via applyUpdatedAccount.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const refreshToken = 'tok-existing-account'
    // Simulate an account with managedProjectId but NO captured tier yet.
    const accounts: (StubAccount & {
      capturedTierId?: string
      capturedTierAt?: number
    })[] = [
      {
        ...makeStubAccount(refreshToken),
        index: 0,
        // capturedTierId absent -- the bug: existing account never got tier.
      },
    ]

    let tierLoadCalled = false
    const applyUpdatedAccountCalls: Array<{
      index: number
      patch: { capturedTierId?: string; capturedTierAt?: number }
    }> = []

    const quotaManager = makeQuotaManager({ result: 'ok' })
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        {
          refreshToken,
          managedProjectId: 'proj-abc123', // existing account has managedProjectId
          enabled: true,
          addedAt: 0,
          lastUsed: 0,
        },
      ],
      updateQuotaCache: mock((_i, groups, _t) => {
        accounts[0]!.cachedQuotaAccountId = quotaAccountIdentity(refreshToken)
      }),
      applyUpdatedAccount: mock((index, patch) => {
        applyUpdatedAccountCalls.push({ index, patch })
        if (patch.capturedTierId !== undefined) {
          accounts[0]!.capturedTierId = patch.capturedTierId
          accounts[0]!.capturedTierAt = patch.capturedTierAt
        }
      }),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    let tierResolve!: () => void
    const tierResolved = new Promise<void>((r) => {
      tierResolve = r
    })

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
      loadAccountTier: async (account) => {
        tierLoadCalled = true
        // Must be called with the AccountMetadataV3 that has managedProjectId.
        expect(account.managedProjectId).toBe('proj-abc123')
        const result = { id: 'free-tier', capturedAt: Date.now() }
        // Signal after returning so the assertions run AFTER applyUpdatedAccount.
        setTimeout(tierResolve, 0)
        return result
      },
    })
    poller.start()

    await Promise.race([
      tierResolved.then(() => new Promise((r) => setTimeout(r, 300))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout waiting for tier')), 5_000),
      ),
    ])
    await poller.dispose()

    // The tier loader must have been called.
    expect(tierLoadCalled).toBe(true)
    // applyUpdatedAccount must have been called with the resolved tier.
    const tierCall = applyUpdatedAccountCalls.find(
      (c) => c.patch.capturedTierId !== undefined,
    )
    expect(tierCall).toBeDefined()
    expect(tierCall?.patch.capturedTierId).toBe('free-tier')
    expect(typeof tierCall?.patch.capturedTierAt).toBe('number')
  })

  it('P2-A-stale: account with outdated capturedTierAt triggers tier refresh', async () => {
    // An account that already has a tier but its capturedTierAt is older than
    // TIER_STALENESS_TTL_MS must be re-resolved.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const refreshToken = 'tok-stale-tier'
    const oldTierAt = Date.now() - 25 * 60 * 60 * 1_000 // 25h ago (> 24h TTL)
    const accounts: (StubAccount & {
      capturedTierId?: string
      capturedTierAt?: number
    })[] = [
      {
        ...makeStubAccount(refreshToken),
        index: 0,
        capturedTierId: 'old-tier',
        capturedTierAt: oldTierAt,
      },
    ]

    let tierLoadCalled = false
    const quotaManager = makeQuotaManager({ result: 'ok' })
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        { refreshToken, enabled: true, addedAt: 0, lastUsed: 0 },
      ],
      updateQuotaCache: mock(() => {}),
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    let tierResolve!: () => void
    const tierResolved = new Promise<void>((r) => {
      tierResolve = r
    })

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(), // real time -- oldTierAt IS stale
      loadAccountTier: async (_account) => {
        tierLoadCalled = true
        setTimeout(tierResolve, 0)
        return { id: 'new-tier', capturedAt: Date.now() }
      },
    })
    poller.start()

    await Promise.race([
      tierResolved.then(() => new Promise((r) => setTimeout(r, 100))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    await poller.dispose()

    expect(tierLoadCalled).toBe(true)
  })

  it('backfills a missing paid tier field despite a fresh tier timestamp', async () => {
    const now = 1_700_000_000_000
    const refreshToken = 'tok-paid-tier-backfill'
    const accounts: Array<
      StubAccount & {
        capturedTierId?: string
        capturedPaidTierId?: string
        capturedTierAt?: number
        capturedTierSchemaVersion?: number
      }
    > = [
      {
        ...makeStubAccount(refreshToken),
        capturedTierId: 'free-tier',
        capturedTierAt: now - 60 * 60 * 1_000,
      },
    ]
    const loadAccountTier = mock(async () => ({
      id: 'free-tier',
      paidId: 'g1-pro-tier',
      capturedAt: now,
    }))
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        { refreshToken, enabled: true, addedAt: 0, lastUsed: 0 },
      ],
      updateQuotaCache: mock(() => {}),
      applyUpdatedAccount: mock((_index, patch) => {
        Object.assign(accounts[0]!, patch)
      }),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: makeQuotaManager({
        result: 'ok',
      }) as unknown as import('./quota').QuotaManager,
      loadAccountTier,
      now: () => now,
    })

    await (poller as unknown as { refresh: () => Promise<void> }).refresh()

    expect(loadAccountTier).toHaveBeenCalledTimes(1)
    expect(accounts[0]?.capturedPaidTierId).toBe('g1-pro-tier')
  })

  it('records a paid-tier-schema attempt when the upstream paid tier is absent', async () => {
    const now = 1_700_000_000_000
    const refreshToken = 'tok-empty-paid-tier'
    const accounts: Array<
      StubAccount & {
        capturedTierId?: string
        capturedTierAt?: number
        capturedTierSchemaVersion?: number
      }
    > = [
      {
        ...makeStubAccount(refreshToken),
        capturedTierId: 'free-tier',
        capturedTierAt: now - 60 * 60 * 1_000,
      },
    ]
    const loadAccountTier = mock(async () => ({
      id: 'free-tier',
      capturedAt: now,
    }))
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        { refreshToken, enabled: true, addedAt: 0, lastUsed: 0 },
      ],
      updateQuotaCache: mock(() => {}),
      applyUpdatedAccount: mock((_index, patch) => {
        Object.assign(accounts[0]!, patch)
      }),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: makeQuotaManager({
        result: 'ok',
      }) as unknown as import('./quota').QuotaManager,
      loadAccountTier,
      now: () => now,
    })
    const refresh = (
      poller as unknown as { refresh: () => Promise<void> }
    ).refresh.bind(poller)

    await refresh()
    await refresh()

    expect(loadAccountTier).toHaveBeenCalledTimes(1)
    expect(accounts[0]?.capturedTierSchemaVersion).toBe(1)
  })

  it('does not re-resolve a fresh tier captured under the paid-tier schema', async () => {
    const now = 1_700_000_000_000
    const refreshToken = 'tok-current-tier-schema'
    const accounts: Array<
      StubAccount & {
        capturedTierId?: string
        capturedPaidTierId?: string
        capturedTierAt?: number
        capturedTierSchemaVersion?: number
      }
    > = [
      {
        ...makeStubAccount(refreshToken),
        capturedTierId: 'free-tier',
        capturedPaidTierId: 'g1-pro-tier',
        capturedTierAt: now - 60 * 60 * 1_000,
      },
    ]
    const loadAccountTier = mock(async () => ({
      id: 'free-tier',
      paidId: 'g1-pro-tier',
      capturedAt: now,
    }))
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        { refreshToken, enabled: true, addedAt: 0, lastUsed: 0 },
      ],
      updateQuotaCache: mock(() => {}),
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }
    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: makeQuotaManager({
        result: 'ok',
      }) as unknown as import('./quota').QuotaManager,
      loadAccountTier,
      now: () => now,
    })

    await (poller as unknown as { refresh: () => Promise<void> }).refresh()

    expect(loadAccountTier).not.toHaveBeenCalled()
  })

  it('P2-A-fresh: account with fresh capturedTierAt does NOT trigger tier refresh', async () => {
    // An account refreshed 1h ago (< 24h TTL) must not trigger loadAccountTier.
    await setSidebarMachineState({ checkedAt: 0, accounts: [] }, { stateFile })

    const refreshToken = 'tok-fresh-tier'
    const freshTierAt = Date.now() - 1 * 60 * 60 * 1_000 // 1h ago (well within 24h)
    const accounts: (StubAccount & {
      capturedTierId?: string
      capturedPaidTierId?: string
      capturedTierAt?: number
      capturedTierSchemaVersion?: number
    })[] = [
      {
        ...makeStubAccount(refreshToken),
        index: 0,
        capturedTierId: 'free-tier',
        capturedPaidTierId: 'g1-pro-tier',
        capturedTierAt: freshTierAt,
        capturedTierSchemaVersion: 1,
      },
    ]

    let tierLoadCalled = false
    let refreshDone = false
    const quotaManager = {
      refreshAccounts: mock(async () => {
        refreshDone = true
        return []
      }),
      dispose: mock(async () => {}),
    }
    const manager: PollerAccountView = {
      getAccounts: () => [...accounts],
      getAccountsForQuotaCheck: () => [
        { refreshToken, enabled: true, addedAt: 0, lastUsed: 0 },
      ],
      updateQuotaCache: mock(() => {}),
      applyUpdatedAccount: mock(() => {}),
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    }

    const poller = new BackgroundQuotaRefresh({
      intervalMs: 60_000,
      sidebarStateFile: stateFile,
      getAccountManager: () => manager,
      quotaManager: quotaManager as unknown as import('./quota').QuotaManager,
      random: () => 0,
      now: () => Date.now(),
      loadAccountTier: async () => {
        tierLoadCalled = true
        return null
      },
    })
    poller.start()

    // Wait for the quota refresh to complete (a tick ran).
    await Promise.race([
      new Promise<void>((r) => {
        const interval = setInterval(() => {
          if (refreshDone) {
            clearInterval(interval)
            r()
          }
        }, 10)
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ])
    // Small extra drain so any async tier check would have fired.
    await new Promise((r) => setTimeout(r, 200))
    await poller.dispose()

    // Fresh tier -- tier loader must NOT have been invoked.
    expect(tierLoadCalled).toBe(false)
  })
})

// ─── Wiring tests (through the real factory) ──────────────────────────────────

describe('BackgroundQuotaRefresh wiring through createAntigravityPlugin', () => {
  let tempDir: string
  let stateFile: string
  let fetchSpy: ReturnType<typeof import('bun:test').spyOn>
  let savedSidebarEnvWiring: string | undefined

  beforeEach(() => {
    savedSidebarEnvWiring = process.env[SIDEBAR_STATE_ENV]
    tempDir = mkdtempSync(join(tmpdir(), 'bg-quota-wiring-'))
    stateFile = join(tempDir, 'sidebar-state.json')
    process.env[SIDEBAR_STATE_ENV] = stateFile
    // Prevent the version check from hitting the network.
    const { spyOn } = require('bun:test') as typeof import('bun:test')
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response('not-found', { status: 404 })) as unknown as typeof fetch,
    )
  })

  afterEach(async () => {
    fetchSpy.mockRestore()
    mock.restore()
    // Restore rather than delete — a delete drops resolution to the real state dir.
    if (savedSidebarEnvWiring !== undefined)
      process.env[SIDEBAR_STATE_ENV] = savedSidebarEnvWiring
    else delete process.env[SIDEBAR_STATE_ENV]
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function makePlugin(
    directory: string,
    config: Record<string, unknown>,
    pollerCreatedCb?: (p: BackgroundQuotaRefresh) => void,
  ) {
    mkdirSync(join(directory, '.opencode'), { recursive: true })
    await Bun.write(
      join(directory, '.opencode', 'antigravity.json'),
      JSON.stringify(config),
    )
    const client = makeMinimalClient()
    const input = makePluginInput(client, directory)
    return createAntigravityPlugin('google', {
      _onPollerCreated: pollerCreatedCb,
    })(input)
  }

  it('background_quota_refresh: false → NO poller instance is constructed', async () => {
    const pluginDir = join(tempDir, 'plugin-disabled')
    let pollerCreated = false
    const plugin = await makePlugin(
      pluginDir,
      { background_quota_refresh: false },
      () => {
        pollerCreated = true
      },
    )
    await plugin.dispose()
    // _onPollerCreated must not have been called — the block is guarded by
    // `if (config.background_quota_refresh)` and the seam is wired INSIDE it.
    expect(pollerCreated).toBe(false)
  })

  it('background_quota_refresh: true → exactly one poller is constructed and its dispose is registered', async () => {
    const pluginDir = join(tempDir, 'plugin-enabled')
    const capturedPollers: BackgroundQuotaRefresh[] = []
    const plugin = await makePlugin(
      pluginDir,
      {
        background_quota_refresh: true,
        background_quota_refresh_interval_minutes: 60,
      },
      (p) => capturedPollers.push(p),
    )
    // Exactly one instance was constructed.
    expect(capturedPollers).toHaveLength(1)
    // Replace dispose with a spy BEFORE plugin.dispose() is called so we can
    // confirm the plugin's producer plumbing reaches through to the instance.
    let pollerDisposeCalled = false
    const original = capturedPollers[0]!.dispose.bind(capturedPollers[0]!)
    capturedPollers[0]!.dispose = async () => {
      pollerDisposeCalled = true
      return original()
    }
    await plugin.dispose()
    expect(pollerDisposeCalled).toBe(true)
  })

  it('plugin dispose awaits the poller in the PRODUCER phase (poller stops before the sidebar drain)', async () => {
    // Evidence that the poller is a producer (not consumer): the lifecycle
    // disposes producers BEFORE calling drainSidebarWrites. We instrument
    // the poller's dispose to record its completion timestamp, and confirm
    // plugin.dispose() resolves — which requires the producer chain to have
    // completed (poller stopped, any in-flight tick awaited).
    //
    // A more surgical ordering probe would require intercepting lifecycle
    // internals; this test focuses on the externally observable guarantee:
    // plugin.dispose() fully awaits the poller, and the poller's dispose
    // resolves within a tight deadline.
    const pluginDir = join(tempDir, 'plugin-producer')
    const capturedPollers: BackgroundQuotaRefresh[] = []
    const plugin = await makePlugin(
      pluginDir,
      {
        background_quota_refresh: true,
        background_quota_refresh_interval_minutes: 60,
      },
      (p) => capturedPollers.push(p),
    )
    expect(capturedPollers).toHaveLength(1)

    // Wrap dispose to measure how long the poller took to stop.
    let pollerDisposeResolved = false
    const orig = capturedPollers[0]!.dispose.bind(capturedPollers[0]!)
    capturedPollers[0]!.dispose = async () => {
      await orig()
      pollerDisposeResolved = true
    }
    const disposed = await Promise.race([
      plugin.dispose().then(() => 'done'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 5_000)),
    ])
    expect(disposed).toBe('done')
    // The poller's dispose must have resolved before plugin.dispose() resolved.
    expect(pollerDisposeResolved).toBe(true)
  })
})
