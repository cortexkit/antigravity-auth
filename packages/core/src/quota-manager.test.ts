import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountMetadataV3 } from './account-types.ts'
import {
  aggregateQuotaSummary,
  createQuotaManager,
  type FetchAccountQuota,
  fetchQuotaSummary,
  type RetrieveUserQuotaSummaryResponse,
} from './quota-manager.ts'
import type { AccountQuotaResult } from './quota-types.ts'

function makeAccount(
  overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
  return {
    refreshToken: 'rt',
    addedAt: 0,
    lastUsed: 0,
    ...overrides,
  }
}

interface CallRecord {
  account: AccountMetadataV3
}

function makeHarness(
  overrides: Partial<{ failures: number; result: 'ok' | 'err' }> = {},
) {
  const calls: CallRecord[] = []
  const failures = overrides.failures ?? 0
  let invocations = 0

  const fetch: FetchAccountQuota = async (account, _signal) => {
    calls.push({ account })
    invocations += 1
    if (invocations <= failures) {
      throw new Error(`synthetic failure #${invocations}`)
    }
    if (overrides.result === 'err') {
      return {
        index: 0,
        status: 'error',
        email: account.email,
        error: 'synthetic',
      }
    }
    return {
      index: 0,
      status: 'ok',
      email: account.email,
      quota: {
        groups: { 'non-gemini': { remainingFraction: 0.5, modelCount: 1 } },
        modelCount: 1,
      },
    }
  }

  return { fetch, calls }
}

function keyOfAccount(account: AccountMetadataV3): string {
  return account.email ?? `rt:${account.refreshToken}`
}

let managers: Array<{ dispose: () => void }> = []

afterEach(() => {
  for (const manager of managers) {
    manager.dispose()
  }
  managers = []
})

// Generic so callers keep the full manager type (refreshAccount, getCached,
// ...) while the afterEach hook only needs dispose().
function track<T extends { dispose: () => void }>(disposable: T): T {
  managers.push(disposable)
  return disposable
}

describe('classifyQuotaGroup', () => {
  it('classifies Claude models into the non-Gemini pool', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(classifyQuotaGroup('claude-sonnet-4-6', 'Claude Sonnet 4.6')).toBe(
      'non-gemini',
    )
  })

  it('classifies every representative Gemini model into the Gemini pool', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    // Each tuple covers a distinct tier/variant the production API
    // exposes — a regression that ignores one tier would surface as a
    // single failure rather than a passing test.
    const geminiModels: Array<[string, string]> = [
      ['gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'],
      ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
      ['gemini-3-flash', 'Gemini 3 Flash'],
      ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'],
      ['gemini-pro-agent', 'Gemini Pro Agent'],
      ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
    ]
    for (const [id, display] of geminiModels) {
      expect(classifyQuotaGroup(id, display)).toBe('gemini')
    }
  })

  it('classifies tab autocomplete models into the Gemini pool', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })

    expect(classifyQuotaGroup('tab_12345', 'Autocomplete')).toBe('gemini')
  })

  it('classifies GPT-OSS variants into the non-Gemini pool', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(classifyQuotaGroup('gpt-oss-120b-medium', 'GPT-OSS 120B')).toBe(
      'non-gemini',
    )
  })

  it('classifies gemini-claude-* aliases into the non-Gemini pool (Claude route wins over the gemini- prefix)', () => {
    // These aliases map to Claude-sonnet-4-6 in the route table; a
    // regression that checks `gemini` first would misroute them to the
    // gemini pool and silently double-charge that pool.
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(
      classifyQuotaGroup('gemini-claude-sonnet-4-6-thinking-low', ''),
    ).toBe('non-gemini')
    expect(classifyQuotaGroup('gemini-claude-sonnet-4-6', '')).toBe(
      'non-gemini',
    )
  })

  it('returns null for unrecognized models', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(classifyQuotaGroup('totally-unknown', 'Whatever')).toBeNull()
  })
})

describe('aggregateQuota', () => {
  it('aggregates per-model entries into groups by minimum remaining', () => {
    const { aggregateQuota } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    const summary = aggregateQuota({
      'claude-sonnet-4-6': {
        quotaInfo: {
          remainingFraction: 0.8,
          resetTime: '2099-01-01T00:00:00Z',
        },
        displayName: 'Claude Sonnet 4.6',
        modelName: 'Claude Sonnet 4.6',
      },
      'gemini-3.1-pro-low': {
        quotaInfo: { remainingFraction: 0.4 },
        displayName: 'Gemini 3.1 Pro',
        modelName: 'Gemini 3.1 Pro',
      },
      'gemini-3.5-flash-low': {
        quotaInfo: { remainingFraction: 0.1 },
        displayName: 'Gemini Flash',
        modelName: 'Gemini Flash',
      },
    })
    expect(summary.groups['non-gemini']?.remainingFraction).toBe(0.8)
    expect(summary.groups.gemini?.remainingFraction).toBe(0.1)
    expect(summary.groups.gemini?.modelCount).toBe(2)
    expect(summary.perModel).toHaveLength(3)
    expect(summary.modelCount).toBe(3)
  })

  it('clamps out-of-range remaining fractions', () => {
    const { aggregateQuota } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    const summary = aggregateQuota({
      'claude-sonnet-4-6': {
        quotaInfo: { remainingFraction: 5 },
        displayName: 'Claude',
        modelName: 'Claude',
      },
      'gemini-3.5-flash-low': {
        quotaInfo: { remainingFraction: -1 },
        displayName: 'Flash',
        modelName: 'Flash',
      },
    })
    expect(summary.groups['non-gemini']?.remainingFraction).toBe(1)
    expect(summary.groups.gemini?.remainingFraction).toBe(0)
  })
})

describe('refreshAccount', () => {
  it('records successful fetch completion time and does not restamp a cached reading', async () => {
    const harness = makeHarness()
    let now = 1_000
    const manager = track(
      createQuotaManager({
        keyOf: keyOfAccount,
        now: () => now,
        fetchAccountQuota: async (...args) => {
          const result = await harness.fetch(...args)
          now = 2_000
          return result
        },
      }),
    )
    const account = makeAccount({ email: 'dated@example.com' })
    const result = await manager.refreshAccount(account, { index: 0 })
    expect(result.checkedAt).toBe(2_000)
    now = 10_000
    expect(manager.getCached(account)?.checkedAt).toBe(2_000)
  })

  it('attempts the fetch and stores the result indexed by stable key', async () => {
    const harness = makeHarness()
    const manager = track(
      createQuotaManager({
        fetchAccountQuota: harness.fetch,
        keyOf: keyOfAccount,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })
    const result = await manager.refreshAccount(account, { index: 7 })

    expect(result.status).toBe('ok')
    expect(result.index).toBe(7)
    expect(result.email).toBe('a@example.com')
    expect(harness.calls).toHaveLength(1)

    const cached = manager.getCached(account)
    expect(cached?.status).toBe('ok')
    expect(cached?.index).toBe(7)
  })

  it('treats disabled accounts as a disabled result without fetching', async () => {
    const harness = makeHarness()
    const manager = track(
      createQuotaManager({
        fetchAccountQuota: harness.fetch,
        keyOf: keyOfAccount,
      }),
    )

    const account = makeAccount({ email: 'a@example.com', enabled: false })
    const result = await manager.refreshAccount(account, { index: 0 })

    expect(result.status).toBe('disabled')
    expect(result.disabled).toBe(true)
    expect(harness.calls).toHaveLength(0)
    expect(manager.getCached(account)?.status).toBe('disabled')
  })

  it('captures fetch errors as status="error"', async () => {
    const harness = makeHarness({ failures: 1 })
    const manager = track(
      createQuotaManager({
        fetchAccountQuota: harness.fetch,
        keyOf: keyOfAccount,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })
    const result = await manager.refreshAccount(account, { index: 0 })

    expect(result.status).toBe('error')
    expect(result.error).toContain('synthetic failure #1')
    expect(manager.getCached(account)?.status).toBe('error')
  })

  it('treats resolved error results (status="error") as failures for backoff', async () => {
    let calls = 0
    const fetch: FetchAccountQuota = async (account) => {
      calls += 1
      // Adapter contract: fail soft by resolving with status="error" instead
      // of throwing. Core must still record a failure and apply backoff so
      // the next call does not re-hammer a degraded account.
      return {
        index: 0,
        email: account.email,
        status: 'error',
        error: 'adapter reported failure',
      }
    }

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })

    const first = await manager.refreshAccount(account, { index: 0 })
    expect(first.status).toBe('error')
    expect(manager.getBackoffUntil(account)).toBeGreaterThan(0)

    // Second call within backoff window must be skipped — proves backoff
    // was applied to a resolved (not thrown) error.
    const second = await manager.refreshAccount(account, { index: 0 })
    expect(second.status).toBe('error')
    expect(calls).toBe(1)

    // The cached result is preserved across the skipped call.
    const cached = manager.getCached(account)
    expect(cached?.status).toBe('error')
    expect(cached?.error).toBe('adapter reported failure')
  })

  it('does not apply backoff for disabled results returned by the adapter', async () => {
    const fetch: FetchAccountQuota = async (account) => ({
      index: 0,
      email: account.email,
      status: 'disabled',
      disabled: true,
    })

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })

    await manager.refreshAccount(account, { index: 0 })
    expect(manager.getBackoffUntil(account)).toBe(0)

    await manager.refreshAccount(account, { index: 0 })
    expect(manager.getBackoffUntil(account)).toBe(0)
  })

  it('dedupes concurrent fetches for the same account', async () => {
    let invocations = 0
    const fetch: FetchAccountQuota = async (_account, _signal) => {
      invocations += 1
      // yield to confirm both callers are awaiting the same promise
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        index: 0,
        status: 'ok',
        quota: { groups: {}, modelCount: 0 },
      }
    }

    const manager = track(
      createQuotaManager({ fetchAccountQuota: fetch, keyOf: keyOfAccount }),
    )
    const account = makeAccount({ email: 'a@example.com' })

    const [a, b] = await Promise.all([
      manager.refreshAccount(account, { index: 0 }),
      manager.refreshAccount(account, { index: 0 }),
    ])

    expect(invocations).toBe(1)
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
  })

  it('lets independent accounts fetch in parallel', async () => {
    const fetch: FetchAccountQuota = async (account, _signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        index: 0,
        status: 'ok',
        email: account.email,
        quota: { groups: {}, modelCount: 0 },
      }
    }

    const manager = track(
      createQuotaManager({ fetchAccountQuota: fetch, keyOf: keyOfAccount }),
    )
    const a = makeAccount({ email: 'a@example.com' })
    const b = makeAccount({ email: 'b@example.com' })

    const results = await manager.refreshAccounts([a, b], { indexFor: () => 0 })

    expect(results).toHaveLength(2)
    expect(results[0]?.status).toBe('ok')
    expect(results[1]?.status).toBe('ok')
  })
})

describe('backoff', () => {
  it('skips fetch while inside the backoff window unless forced', async () => {
    let now = 1_000_000
    let calls = 0
    const counterFetch: FetchAccountQuota = async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('first call fails')
      }
      return { index: 0, status: 'ok', quota: { groups: {}, modelCount: 0 } }
    }

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: counterFetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })

    // First call fails — seeds the backoff window
    await manager.refreshAccount(account, { index: 0 })
    expect(calls).toBe(1)
    expect(manager.getBackoffUntil(account)).toBeGreaterThan(0)

    // Second call within backoff window — should skip the fetch
    const resultSkipped = await manager.refreshAccount(account, { index: 0 })
    expect(calls).toBe(1)
    expect(resultSkipped.status).toBe('error')

    // Advance past backoff window
    now += 5000
    const resultAllowed = await manager.refreshAccount(account, { index: 0 })
    expect(calls).toBe(2)
    expect(resultAllowed.status).toBe('ok')

    // Backoff cleared after success
    expect(manager.getBackoffUntil(account)).toBe(0)
  })

  it('grows backoff exponentially and caps at maxBackoffMs', async () => {
    let now = 0
    const fetch: FetchAccountQuota = async () => {
      throw new Error('persistent failure')
    }

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 4000,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })

    // failures: 1 → backoff 1s, 2 → 2s, 3 → 4s, 4 → capped at 4s
    // Use stable `now` values so the backoff math is predictable: backoffUntil
    // is computed as `now() + baseBackoffMs * 2^(failures-1)`.
    await manager.refreshAccount(account, { index: 0 })
    expect(manager.getBackoffUntil(account)).toBe(0 + 1_000)

    now = 2_000
    await manager.refreshAccount(account, { index: 0 })
    expect(manager.getBackoffUntil(account)).toBe(2_000 + 2_000)

    now = 6_000
    await manager.refreshAccount(account, { index: 0 })
    expect(manager.getBackoffUntil(account)).toBe(6_000 + 4_000)

    now = 11_000
    await manager.refreshAccount(account, { index: 0 })
    // Capped at maxBackoffMs (4000)
    expect(manager.getBackoffUntil(account)).toBe(11_000 + 4_000)
  })

  it('force option bypasses backoff and triggers a fresh fetch', async () => {
    const now = 0
    const fetch: FetchAccountQuota = async () => {
      throw new Error('persistent failure')
    }

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )

    const account = makeAccount({ email: 'a@example.com' })

    await manager.refreshAccount(account, { index: 0 })
    expect(manager.getBackoffUntil(account)).toBeGreaterThan(0)

    // force=true should still call fetch despite backoff
    const result = await manager.refreshAccount(account, {
      index: 0,
      force: true,
    })
    expect(result.status).toBe('error')
    expect(manager.getBackoffUntil(account)).toBeGreaterThan(0)
  })

  it('keeps backoffs independent per account key', async () => {
    let now = 0
    const fetch: FetchAccountQuota = async (account) => {
      throw new Error(`fail ${account.email ?? 'unknown'}`)
    }

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )

    const a = makeAccount({ email: 'a@example.com' })
    const b = makeAccount({ email: 'b@example.com' })

    await manager.refreshAccount(a, { index: 0 })
    // B's backoff should still be 0
    expect(manager.getBackoffUntil(b)).toBe(0)
    expect(manager.getBackoffUntil(a)).toBeGreaterThan(0)

    // B can still fetch even if A is backed off
    now = 1
    let calls = 0
    const counterFetch: FetchAccountQuota = async (account) => {
      calls += 1
      if (account.email === 'b@example.com') {
        return { index: 0, status: 'ok', quota: { groups: {}, modelCount: 0 } }
      }
      throw new Error('fail')
    }
    const manager2 = track(
      createQuotaManager({
        fetchAccountQuota: counterFetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )
    await manager2.refreshAccount(a, { index: 0 })
    await manager2.refreshAccount(b, { index: 0 })
    expect(calls).toBe(2)
  })
})

describe('getCached', () => {
  it('returns undefined for unknown accounts', () => {
    const manager = track(
      createQuotaManager({
        fetchAccountQuota: makeHarness().fetch,
        keyOf: keyOfAccount,
      }),
    )
    expect(manager.getCached(makeAccount({ email: 'nope' }))).toBeUndefined()
  })

  it('preserves result.index even when accounts reorder', async () => {
    const fetch: FetchAccountQuota = async (account, _signal) => ({
      index: 0,
      status: 'ok',
      email: account.email,
      quota: { groups: {}, modelCount: 0 },
    })

    const manager = track(
      createQuotaManager({ fetchAccountQuota: fetch, keyOf: keyOfAccount }),
    )
    const a = makeAccount({ email: 'a@example.com' })
    const b = makeAccount({ email: 'b@example.com' })

    await manager.refreshAccount(a, { index: 5 })
    await manager.refreshAccount(b, { index: 9 })

    expect(manager.getCached(a)?.index).toBe(5)
    expect(manager.getCached(b)?.index).toBe(9)
  })
})

describe('dispose', () => {
  it('aborts in-flight fetches and rejects subsequent refreshes', async () => {
    let activeController: AbortController | undefined
    const fetch: FetchAccountQuota = async (account, signal) => {
      activeController = new AbortController()
      const composite = signal
        ? AbortSignal.any([signal, activeController.signal])
        : activeController.signal
      try {
        await new Promise<void>((resolve, reject) => {
          if (composite.aborted) {
            reject(new Error('aborted'))
            return
          }
          composite.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
          setTimeout(resolve, 200)
        })
        return {
          index: 0,
          status: 'ok',
          email: account.email,
          quota: { groups: {}, modelCount: 0 },
        }
      } finally {
        activeController = undefined
      }
    }

    const manager = createQuotaManager({
      fetchAccountQuota: fetch,
      keyOf: keyOfAccount,
    })
    const account = makeAccount({ email: 'a@example.com' })

    const pending = manager.refreshAccount(account, { index: 0 })
    manager.dispose()
    // Wait for abort controller to settle
    await new Promise((resolve) => setTimeout(resolve, 10))

    const result = await pending
    expect(result.status).toBe('error')
    expect(result.error).toContain('aborted')

    // Subsequent refresh attempts after dispose should also fail with an aborted signal.
    const next = await manager.refreshAccount(account, { index: 0 })
    expect(next.status).toBe('error')
  })

  it('awaits the in-flight refresh before resolving so a post-refresh side effect is fenced', async () => {
    // A producer (the opencode quota wrapper) fires a fire-and-forget
    // sidebar write in the continuation after refreshAccount resolves.
    // dispose() must not resolve until that in-flight refresh has
    // settled, so the continuation's write is enqueued before the
    // lifecycle drains the sidebar queue in the following phase. A
    // side-effect attached to the refresh promise stands in for that
    // continuation here.
    const order: string[] = []
    // Held in an object so TypeScript does not narrow the closure-assigned
    // release callback to `null` (and then `never`) at the call site below.
    const fetchGate: { release: (() => void) | null } = { release: null }
    const fetch: FetchAccountQuota = (account) => {
      order.push('fetch:start')
      return new Promise<AccountQuotaResult>((resolve) => {
        fetchGate.release = () =>
          resolve({
            index: 0,
            status: 'ok',
            email: account.email,
            quota: { groups: {}, modelCount: 0 },
          })
      })
    }

    const manager = createQuotaManager({
      fetchAccountQuota: fetch,
      keyOf: keyOfAccount,
    })
    const account = makeAccount({ email: 'inflight@example.com' })

    let sideEffectRan = false
    const pending = manager
      .refreshAccount(account, { index: 0 })
      .then((result) => {
        // Stand-in for the wrapper's fire-and-forget sidebar write.
        sideEffectRan = true
        order.push('side-effect')
        return result
      })

    // The fetch is now mid-flight (awaiting fetchGate.release). Kick off
    // dispose, then release the fetch — dispose must await the in-flight
    // refresh and its continuation before resolving.
    const disposed = manager.dispose().then(() => {
      order.push('dispose:resolved')
      // The producer's side-effect was scheduled before dispose resolved.
      expect(sideEffectRan).toBe(true)
    })
    fetchGate.release?.()

    await Promise.all([disposed, pending])

    // fetch:start → (in-flight refresh settles + side-effect) → dispose.
    expect(order).toEqual(['fetch:start', 'side-effect', 'dispose:resolved'])
  })
})

// Node 20.0.0 is the oldest runtime the published packages support. It has
// AbortSignal.timeout but not AbortSignal.any (added in Node 20.3.0), so
// these tests remove `any` for the duration of one test. They also wrap
// AbortSignal.timeout to record each deadline signal the manager creates and
// the 'abort' listeners attached to it, so a test can prove the manager
// detaches from the deadline once the fetch callback settles.
interface DeadlineProbe {
  requestedMs: number[]
  signals: AbortSignal[]
  addedAbortListeners: () => number
  activeAbortListeners: () => number
}

async function withoutAbortSignalAny(
  run: (probe: DeadlineProbe) => Promise<void>,
): Promise<void> {
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'timeout',
  )
  if (typeof timeoutDescriptor?.value !== 'function') {
    throw new Error('AbortSignal.timeout is required by these tests')
  }
  const realTimeout = timeoutDescriptor.value as (ms: number) => AbortSignal

  const requestedMs: number[] = []
  const signals: AbortSignal[] = []
  const active = new Set<unknown>()
  let added = 0

  const probe: DeadlineProbe = {
    requestedMs,
    signals,
    addedAbortListeners: () => added,
    activeAbortListeners: () => active.size,
  }

  const trackedTimeout = (ms: number): AbortSignal => {
    const signal = Reflect.apply(realTimeout, AbortSignal, [ms]) as AbortSignal
    requestedMs.push(ms)
    signals.push(signal)
    const addListener = EventTarget.prototype.addEventListener
    const removeListener = EventTarget.prototype.removeEventListener
    Object.defineProperty(signal, 'addEventListener', {
      configurable: true,
      value(type: string, listener: unknown, options?: unknown) {
        if (type === 'abort' && listener != null) {
          added += 1
          active.add(listener)
        }
        return Reflect.apply(addListener, signal, [type, listener, options])
      },
    })
    Object.defineProperty(signal, 'removeEventListener', {
      configurable: true,
      value(type: string, listener: unknown, options?: unknown) {
        if (type === 'abort') active.delete(listener)
        return Reflect.apply(removeListener, signal, [type, listener, options])
      },
    })
    return signal
  }

  try {
    if (!Reflect.deleteProperty(AbortSignal, 'any')) {
      throw new Error('could not remove AbortSignal.any')
    }
    Object.defineProperty(AbortSignal, 'timeout', {
      ...timeoutDescriptor,
      value: trackedTimeout,
    })
    // Guard against a runtime that keeps `any` reachable some other way:
    // the tests below only mean something when the API is truly absent.
    expect('any' in AbortSignal).toBe(false)
    await run(probe)
  } finally {
    if (anyDescriptor) {
      Object.defineProperty(AbortSignal, 'any', anyDescriptor)
    } else {
      Reflect.deleteProperty(AbortSignal, 'any')
    }
    Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
  }
}

const STILL_PENDING = Symbol('still pending')

// Races `promise` against a bounded timer so a test can record that a promise
// is still pending, release whatever it waits on, and only then assert. A
// failed assertion before the release would leave the fetch callback (and
// therefore dispose()) waiting forever.
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof STILL_PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<typeof STILL_PENDING>((resolve) => {
    timer = setTimeout(() => resolve(STILL_PENDING), ms)
  })
  try {
    return await Promise.race([promise, bound])
  } finally {
    clearTimeout(timer)
  }
}

// A fetch callback that waits until either its signal aborts (rejecting with
// the signal's reason, as fetch() does) or the test calls release() (then
// resolving with an ok result). release() is idempotent so tests can call it
// unconditionally during teardown.
function makeSignalWaitingFetch() {
  const received: AbortSignal[] = []
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetch: FetchAccountQuota = async (account, signal) => {
    received.push(signal)
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      void released.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    return {
      index: 0,
      status: 'ok',
      email: account.email,
      quota: { groups: {}, modelCount: 0 },
    }
  }
  return { fetch, received, release: () => release() }
}

describe('fetch cancellation without AbortSignal.any', () => {
  it('refreshes and detaches from the deadline after success and after an error', async () => {
    const originalAny = AbortSignal.any
    await withoutAbortSignalAny(async (probe) => {
      let calls = 0
      const fetch: FetchAccountQuota = async (account) => {
        calls += 1
        if (account.email === 'broken@example.com') {
          throw new Error('synthetic adapter failure')
        }
        return {
          index: 0,
          status: 'ok',
          email: account.email,
          quota: { groups: {}, modelCount: 0 },
        }
      }
      const manager = track(
        createQuotaManager({
          fetchAccountQuota: fetch,
          keyOf: keyOfAccount,
          now: () => 1_000_000,
          baseBackoffMs: 1_000,
          maxBackoffMs: 8_000,
          fetchTimeoutMs: 60_000,
        }),
      )
      try {
        const healthy = makeAccount({ email: 'healthy@example.com' })
        const ok = await manager.refreshAccount(healthy, { index: 0 })
        expect(ok.status).toBe('ok')
        expect(ok.error).toBeUndefined()
        expect(manager.getBackoffUntil(healthy)).toBe(0)
        expect(probe.requestedMs).toEqual([60_000])
        expect(probe.addedAbortListeners()).toBe(1)
        expect(probe.activeAbortListeners()).toBe(0)

        const broken = makeAccount({ email: 'broken@example.com' })
        const failed = await manager.refreshAccount(broken, { index: 1 })
        expect(failed.status).toBe('error')
        expect(failed.error).toBe('synthetic adapter failure')
        expect(manager.getBackoffUntil(broken)).toBe(1_000_000 + 1_000)
        expect(probe.requestedMs).toEqual([60_000, 60_000])
        expect(probe.addedAbortListeners()).toBe(2)
        expect(probe.activeAbortListeners()).toBe(0)
        expect(calls).toBe(2)
      } finally {
        await manager.dispose()
      }
    })
    expect(AbortSignal.any).toBe(originalAny)
  })

  it('aborts the callback signal at the fetch deadline and records normal backoff', async () => {
    await withoutAbortSignalAny(async (probe) => {
      const harness = makeSignalWaitingFetch()
      const manager = track(
        createQuotaManager({
          fetchAccountQuota: harness.fetch,
          keyOf: keyOfAccount,
          now: () => 1_000_000,
          baseBackoffMs: 1_000,
          maxBackoffMs: 8_000,
          fetchTimeoutMs: 20,
        }),
      )
      const account = makeAccount({ email: 'slow@example.com' })
      try {
        const pending = manager.refreshAccount(account, { index: 0 })
        const observed = await settleWithin(pending, 1_000)
        harness.release()
        await pending

        expect(observed).not.toBe(STILL_PENDING)
        if (observed === STILL_PENDING) return
        expect(observed.status).toBe('error')
        const signal = harness.received[0]
        expect(signal?.aborted).toBe(true)
        expect((signal?.reason as Error | undefined)?.name).toBe('TimeoutError')
        // A deadline is an ordinary failure, not shutdown: it backs off.
        expect(manager.getBackoffUntil(account)).toBe(1_000_000 + 1_000)
        const skipped = await manager.refreshAccount(account, { index: 0 })
        expect(skipped.status).toBe('error')
        expect(harness.received).toHaveLength(1)
        expect(probe.activeAbortListeners()).toBe(0)
      } finally {
        harness.release()
        await manager.dispose()
      }
    })
  })

  it('aborts the callback signal on dispose without recording backoff', async () => {
    await withoutAbortSignalAny(async (probe) => {
      const harness = makeSignalWaitingFetch()
      const manager = track(
        createQuotaManager({
          fetchAccountQuota: harness.fetch,
          keyOf: keyOfAccount,
          now: () => 1_000_000,
          baseBackoffMs: 1_000,
          maxBackoffMs: 8_000,
          fetchTimeoutMs: 60_000,
        }),
      )
      const account = makeAccount({ email: 'shutdown@example.com' })
      let disposing: Promise<void> | undefined
      try {
        const pending = manager.refreshAccount(account, { index: 0 })
        disposing = manager.dispose()
        const observed = await settleWithin(pending, 1_000)
        harness.release()
        await Promise.all([pending, disposing])

        expect(observed).not.toBe(STILL_PENDING)
        if (observed === STILL_PENDING) return
        expect(observed.status).toBe('error')
        const signal = harness.received[0]
        expect(signal?.aborted).toBe(true)
        expect((signal?.reason as Error | undefined)?.name).toBe('AbortError')
        // Shutdown is not an account failure: no backoff is recorded.
        expect(manager.getBackoffUntil(account)).toBe(0)
        expect(probe.activeAbortListeners()).toBe(0)
        const after = await manager.refreshAccount(account, { index: 0 })
        expect(after.error).toBe('quota manager disposed')
      } finally {
        harness.release()
        await (disposing ?? manager.dispose())
      }
    })
  })

  it('does not report success for a callback that resolves after dispose', async () => {
    await withoutAbortSignalAny(async () => {
      // Held in an object so TypeScript keeps the closure-assigned release
      // callback's type at the call site below.
      const gate: { release: (() => void) | null } = { release: null }
      const fetch: FetchAccountQuota = (account) =>
        new Promise<AccountQuotaResult>((resolve) => {
          // Ignores its signal on purpose, like a callback that finishes
          // parsing a body after cancellation was requested.
          gate.release = () =>
            resolve({
              index: 0,
              status: 'ok',
              email: account.email,
              quota: { groups: {}, modelCount: 0 },
            })
        })
      const manager = track(
        createQuotaManager({
          fetchAccountQuota: fetch,
          keyOf: keyOfAccount,
          fetchTimeoutMs: 60_000,
        }),
      )
      const account = makeAccount({ email: 'late@example.com' })
      const pending = manager.refreshAccount(account, { index: 0 })
      const disposing = manager.dispose()
      gate.release?.()
      const [result] = await Promise.all([pending, disposing])
      expect(result.status).toBe('error')
      expect(manager.getCached(account)?.status).toBe('error')
      expect(manager.getBackoffUntil(account)).toBe(0)
    })
  })

  it('returns an error result with backoff when the fetch deadline cannot be created', async () => {
    // fetchTimeoutMs is passed to AbortSignal.timeout unvalidated; a value
    // the runtime rejects must surface as the refresh's error result, not as
    // a rejected refresh promise.
    let expectedError = ''
    try {
      AbortSignal.timeout(-1)
    } catch (error) {
      expectedError = error instanceof Error ? error.message : String(error)
    }
    expect(expectedError).not.toBe('')

    let calls = 0
    const fetch: FetchAccountQuota = async (account) => {
      calls += 1
      return {
        index: 0,
        status: 'ok',
        email: account.email,
        quota: { groups: {}, modelCount: 0 },
      }
    }
    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        now: () => 1_000_000,
        baseBackoffMs: 1_000,
        maxBackoffMs: 8_000,
        fetchTimeoutMs: -1,
      }),
    )
    const account = makeAccount({ email: 'invalid-deadline@example.com' })
    try {
      const result = await manager.refreshAccount(account, { index: 3 })
      expect(result.status).toBe('error')
      expect(result.index).toBe(3)
      expect(result.error).toBe(expectedError)
      expect(calls).toBe(0)
      expect(manager.getBackoffUntil(account)).toBe(1_000_000 + 1_000)
      // The refresh finished, so a forced retry starts a new attempt rather
      // than waiting on a leftover in-flight entry.
      const retry = await manager.refreshAccount(account, {
        index: 3,
        force: true,
      })
      expect(retry.error).toBe(expectedError)
      expect(manager.getBackoffUntil(account)).toBe(1_000_000 + 2_000)
    } finally {
      await manager.dispose()
    }
  })
})

describe('refreshAccounts', () => {
  it('runs sequentially (preserving order) and returns attributed results', async () => {
    const calls: string[] = []
    const fetch: FetchAccountQuota = async (account, _signal) => {
      calls.push(account.email ?? 'unknown')
      return {
        index: 0,
        status: 'ok',
        email: account.email,
        quota: { groups: {}, modelCount: 0 },
      }
    }

    const manager = track(
      createQuotaManager({ fetchAccountQuota: fetch, keyOf: keyOfAccount }),
    )
    const accounts = [
      makeAccount({ email: 'a@example.com' }),
      makeAccount({ email: 'b@example.com' }),
      makeAccount({ email: 'c@example.com' }),
    ]

    const results = await manager.refreshAccounts(accounts, {
      indexFor: (account) =>
        accounts.findIndex((acc) => acc.email === account.email),
    })

    expect(results.map((r) => r.email)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ])
    expect(results.map((r) => r.index)).toEqual([0, 1, 2])
    expect(calls).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
  })

  it('respects force to bypass backoff for every account', async () => {
    const now = 0
    let calls = 0
    const fetch: FetchAccountQuota = async () => {
      calls += 1
      return { index: 0, status: 'ok', quota: { groups: {}, modelCount: 0 } }
    }

    const manager = track(
      createQuotaManager({
        fetchAccountQuota: fetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )

    const accounts = [makeAccount({ email: 'a@example.com' })]

    // Prime backoff
    const failFetch: FetchAccountQuota = async () => {
      throw new Error('fail')
    }
    const failManager = track(
      createQuotaManager({
        fetchAccountQuota: failFetch,
        keyOf: keyOfAccount,
        now: () => now,
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
      }),
    )
    await failManager.refreshAccount(accounts[0]!, { index: 0 })
    expect(failManager.getBackoffUntil(accounts[0]!)).toBeGreaterThan(0)

    // Use the ok manager but with same backoff seed by manually forcing
    await manager.refreshAccounts(accounts, { indexFor: () => 0, force: true })
    expect(calls).toBe(1)
  })
})

describe('hashed log labels', () => {
  it('produces a short hash label for log emissions', () => {
    const { hashedLogLabel } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(hashedLogLabel('refresh-fail', 'a@example.com')).toMatch(
      /^refresh-fail [a-f0-9]{8}$/,
    )
    // Different inputs yield different labels
    expect(hashedLogLabel('refresh-fail', 'b@example.com')).not.toBe(
      hashedLogLabel('refresh-fail', 'a@example.com'),
    )
    // Empty email still produces a label
    expect(hashedLogLabel('x', '')).toMatch(/^x [a-f0-9]{8}$/)
  })
})

// ============================================================================
// aggregateQuotaSummary — windowed quota from retrieveUserQuotaSummary
// ============================================================================

function loadFixture(name: string): RetrieveUserQuotaSummaryResponse {
  const path = join(import.meta.dir, '__fixtures__', 'quota', name)
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw) as RetrieveUserQuotaSummaryResponse
}

describe('aggregateQuotaSummary', () => {
  it('maps Pro (weekly+5h) groups to pools by bucketId prefix', () => {
    const response = loadFixture('pro-ruqs.json')
    const summary = aggregateQuotaSummary(response)

    expect(summary.groups.gemini).toBeDefined()
    expect(summary.groups['non-gemini']).toBeDefined()

    const gemini = summary.groups.gemini!
    expect(gemini.windows).toHaveLength(2)
    // shortest-first: 5h before weekly
    expect(gemini.windows![0]!.window).toBe('5h')
    expect(gemini.windows![0]!.remainingFraction).toBeCloseTo(0.9886, 3)
    expect(gemini.windows![1]!.window).toBe('weekly')
    expect(gemini.windows![1]!.remainingFraction).toBeCloseTo(0.9214, 3)

    const nonGemini = summary.groups['non-gemini']!
    expect(nonGemini.windows).toHaveLength(2)
    expect(nonGemini.windows![0]!.window).toBe('5h')
    expect(nonGemini.windows![0]!.remainingFraction).toBeCloseTo(0.9556, 3)
    expect(nonGemini.windows![1]!.window).toBe('weekly')
    expect(nonGemini.windows![1]!.remainingFraction).toBeCloseTo(0.9852, 3)
  })

  it('maps Free (weekly-only) groups to pools', () => {
    const response = loadFixture('free-ruqs.json')
    const summary = aggregateQuotaSummary(response)

    const gemini = summary.groups.gemini!
    // Weekly-only: one window
    expect(gemini.windows).toHaveLength(1)
    expect(gemini.windows![0]!.window).toBe('weekly')
    expect(gemini.windows![0]!.remainingFraction).toBeCloseTo(0.8875, 3)

    const nonGemini = summary.groups['non-gemini']!
    expect(nonGemini.windows).toHaveLength(1)
    expect(nonGemini.windows![0]!.window).toBe('weekly')
    expect(nonGemini.windows![0]!.remainingFraction).toBe(1)
  })

  it('derives most-constrained remainingFraction and resetTime per pool', () => {
    const response = loadFixture('pro-ruqs.json')
    const summary = aggregateQuotaSummary(response)

    // Gemini: weekly=0.9214, 5h=0.9886 → weekly is more constrained
    expect(summary.groups.gemini!.remainingFraction).toBeCloseTo(0.9214, 3)
    expect(summary.groups.gemini!.resetTime).toBe('2026-07-28T18:24:21Z')

    // Non-gemini: weekly=0.9852, 5h=0.9556 → 5h is more constrained
    expect(summary.groups['non-gemini']!.remainingFraction).toBeCloseTo(
      0.9556,
      3,
    )
    expect(summary.groups['non-gemini']!.resetTime).toBe('2026-07-24T18:41:52Z')
  })

  it('preserves window order: shortest first', () => {
    const response = loadFixture('pro-ruqs.json')
    const summary = aggregateQuotaSummary(response)

    for (const group of Object.values(summary.groups)) {
      if (!group?.windows) continue
      expect(group.windows).toHaveLength(2)
      expect(group.windows![0]!.window).toBe('5h')
      expect(group.windows![1]!.window).toBe('weekly')
    }
  })

  it('sorts unknown window kinds last, deterministically', async () => {
    // The server can send window kinds this client does not model yet
    // ('daily' here); RetrieveUserQuotaSummaryBucket only types the known
    // ones. fetchQuotaSummary passes the parsed JSON body through
    // unvalidated, so feed this raw wire payload through it instead of
    // building a typed response that cannot express an unknown window.
    const buckets = [
      {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly',
        window: 'weekly',
        resetTime: '2026-07-28T00:00:00Z',
        remainingFraction: 0.9,
      },
      {
        bucketId: 'gemini-daily',
        displayName: 'Daily',
        window: 'daily',
        resetTime: '2026-07-25T00:00:00Z',
        remainingFraction: 0.5,
      },
      {
        bucketId: 'gemini-5h',
        displayName: '5h',
        window: '5h',
        resetTime: '2026-07-24T12:00:00Z',
        remainingFraction: 0.8,
      },
    ]
    const wirePayload = {
      groups: [
        { displayName: 'Gemini', buckets, description: 'Models: A, B, C' },
      ],
    }
    const { summary: response } = await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'mp',
      endpoints: ['http://127.0.0.1:1'],
      fetchVia: async () =>
        new Response(JSON.stringify(wirePayload), { status: 200 }),
    })
    const summary = aggregateQuotaSummary(response)
    const windows = summary.groups.gemini!.windows!
    expect(windows).toHaveLength(3)
    // Known windows sorted shortest-first: 5h → weekly
    expect(windows[0]!.window).toBe('5h')
    expect(windows[1]!.window).toBe('weekly')
    // Unknown window ('daily') sorts last. QuotaWindow does not include it,
    // so read the value as a plain string to assert the raw kind survived.
    const unknownWindow: string = windows[2]!.window
    expect(unknownWindow).toBe('daily')
  })

  it('counts models from the description minus the prefix label', () => {
    const response: RetrieveUserQuotaSummaryResponse = {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 3.1 Pro, Flash',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit',
              window: 'weekly',
              resetTime: '2026-01-08T00:00:00Z',
              remainingFraction: 0.7,
            },
          ],
        },
      ],
    }
    const summary = aggregateQuotaSummary(response)
    expect(summary.groups.gemini!.modelCount).toBe(2)
    expect(summary.modelCount).toBe(2)
  })

  it('back-compat: treats a windows-less QuotaGroupSummary gracefully', () => {
    // Legacy shapes may have no `windows` array — consumers read
    // `remainingFraction`/`resetTime` directly which are the derived
    // values. Exercise this through the REAL response shape (a
    // retrieveUserQuotaSummary payload that omits `windows` on each
    // bucket), not through a windows-shaped fixture that already
    // produced a non-empty `windows` array on the way through.
    const response: RetrieveUserQuotaSummaryResponse = {
      groups: [
        {
          displayName: 'Gemini Legacy',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly',
              window: 'weekly',
              resetTime: '2025-12-29T00:00:00Z',
              remainingFraction: 0.3,
            },
          ],
        },
      ],
    }
    const summary = aggregateQuotaSummary(response)
    // The aggregator still surfaces per-window entries when the
    // wire shape includes them — that's the legacy path's only
    // window. Legacy consumers that read `remainingFraction`
    // directly see the single most-constrained value.
    expect(summary.groups.gemini).toBeDefined()
    expect(summary.groups.gemini!.remainingFraction).toBeCloseTo(0.3, 3)
    expect(summary.groups.gemini!.resetTime).toBe('2025-12-29T00:00:00Z')
  })

  it('keeps a pool when the first bucket is unrecognized', () => {
    // Older servers may prepend a junk bucket (system noise, a
    // non-standard prefix) whose bucketId doesn't match any of our
    // pool prefixes. The legacy derivation used group.buckets[0]
    // unconditionally, which silently dropped the whole group when
    // an unknown prefix led the array. The pool must be derived
    // from the first RECOGNIZED bucket, not the first bucket.
    const response: RetrieveUserQuotaSummaryResponse = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'unknown-prefix-noise',
              displayName: 'Unknown',
              window: 'weekly',
              resetTime: '2026-01-01T00:00:00Z',
              remainingFraction: 0,
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit',
              window: 'weekly',
              resetTime: '2026-01-08T00:00:00Z',
              remainingFraction: 0.7,
            },
            {
              bucketId: 'gemini-5h',
              displayName: '5h Limit',
              window: '5h',
              resetTime: '2026-01-01T05:00:00Z',
              remainingFraction: 0.85,
            },
          ],
        },
      ],
    }
    const summary = aggregateQuotaSummary(response)
    expect(summary.groups.gemini).toBeDefined()
    expect(summary.groups.gemini!.windows).toHaveLength(2)
    expect(summary.groups.gemini!.remainingFraction).toBeCloseTo(0.7, 3)
  })
})

// ============================================================================
// fetchQuotaSummary — network layer with managedProjectId fallback
// ============================================================================

describe('fetchQuotaSummary', () => {
  const ENDPOINTS = ['http://127.0.0.1:1'] as const

  it('returns the summary when the server responds 200', async () => {
    const summary: RetrieveUserQuotaSummaryResponse = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit',
              window: 'weekly',
              resetTime: '2026-01-01T00:00:00Z',
              remainingFraction: 0.5,
            },
          ],
        },
      ],
    }
    const fetchVia = async () =>
      new Response(JSON.stringify(summary), { status: 200 })
    const result = await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'mp',
      endpoints: ENDPOINTS,
      fetchVia: fetchVia as any,
    })
    expect(result.summary.groups).toHaveLength(1)
    expect(result.summary.groups[0]!.buckets[0]!.bucketId).toBe('gemini-weekly')
  })

  it('falls back to projectId when managedProjectId returns 403', async () => {
    const summary: RetrieveUserQuotaSummaryResponse = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              displayName: 'Weekly Limit',
              window: 'weekly',
              resetTime: '2026-01-01T00:00:00Z',
              remainingFraction: 0.3,
            },
          ],
        },
      ],
    }
    let triedManaged = false
    const fetchVia = async (
      _url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init as any).body ?? '{}')
      if (body.project === 'mp') {
        triedManaged = true
        return new Response(JSON.stringify({ error: 'PERMISSION_DENIED' }), {
          status: 403,
        })
      }
      return new Response(JSON.stringify(summary), { status: 200 })
    }
    const result = await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'mp',
      projectId: 'regular',
      endpoints: ENDPOINTS,
      fetchVia: fetchVia as any,
    })
    expect(triedManaged).toBe(true)
    expect(result.summary.groups[0]!.buckets[0]!.bucketId).toBe('3p-weekly')
  })

  it('throws when all project IDs fail (caller handles fallback)', async () => {
    const fetchVia = async () =>
      new Response('{"error":"PERMISSION_DENIED"}', { status: 403 })
    await expect(
      fetchQuotaSummary({
        accessToken: 'tok',
        projectId: 'regular',
        endpoints: ENDPOINTS,
        fetchVia: fetchVia as any,
      }),
    ).rejects.toThrow()
  })

  it('uses managedProjectId as primary when both IDs are present', async () => {
    let receivedProjectId = ''
    const summary: RetrieveUserQuotaSummaryResponse = {
      groups: [],
    }
    const fetchVia = async (
      _url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init as any).body ?? '{}')
      receivedProjectId = body.project as string
      return new Response(JSON.stringify(summary), { status: 200 })
    }
    await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'managed-proj',
      projectId: 'regular-proj',
      endpoints: ENDPOINTS,
      fetchVia: fetchVia as any,
    })
    expect(receivedProjectId).toBe('managed-proj')
  })

  it('falls back to projectId when managedProjectId is missing', async () => {
    let receivedProjectId = ''
    const summary: RetrieveUserQuotaSummaryResponse = {
      groups: [],
    }
    const fetchVia = async (
      _url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init as any).body ?? '{}')
      receivedProjectId = body.project as string
      return new Response(JSON.stringify(summary), { status: 200 })
    }
    await fetchQuotaSummary({
      accessToken: 'tok',
      projectId: 'regular-proj',
      endpoints: ENDPOINTS,
      fetchVia: fetchVia as any,
    })
    expect(receivedProjectId).toBe('regular-proj')
  })

  it('uses managedProjectId when only managedProjectId is provided (managed-only path)', async () => {
    // Distinct from the precedence test above: only managedProjectId is
    // supplied — no projectId fallback. The managed-only input path must
    // still post `project` with the managed project ID.
    let receivedProjectId = ''
    const summary: RetrieveUserQuotaSummaryResponse = { groups: [] }
    const fetchVia = async (
      _url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init as any).body ?? '{}')
      receivedProjectId = body.project as string
      return new Response(JSON.stringify(summary), { status: 200 })
    }
    await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'managed-only',
      endpoints: ENDPOINTS,
      fetchVia: fetchVia as any,
    })
    expect(receivedProjectId).toBe('managed-only')
  })

  it('fails over to the next endpoint when the first returns 500', async () => {
    // The legacy fetchers iterate the endpoint list per project attempt
    // (fetchAvailableModels, fetchGeminiCliQuota). fetchQuotaSummary
    // must match: a 500 on the primary endpoint should fall through
    // to the next entry in `options.endpoints`.
    const summary: RetrieveUserQuotaSummaryResponse = {
      groups: [
        {
          displayName: 'Recovery',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly',
              window: 'weekly',
              resetTime: '2026-01-01T00:00:00Z',
              remainingFraction: 0.42,
            },
          ],
        },
      ],
    }
    const visited: string[] = []
    const fetchVia = async (url: string): Promise<Response> => {
      visited.push(url)
      if (url.startsWith('https://failover-a.test')) {
        return new Response('boom', { status: 500 })
      }
      return new Response(JSON.stringify(summary), { status: 200 })
    }
    const result = await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'mp',
      endpoints: [
        'https://failover-a.test',
        'https://failover-b.test',
      ] as const,
      fetchVia: fetchVia as any,
    })
    expect(visited).toHaveLength(2)
    expect(visited[0]).toBe(
      'https://failover-a.test/v1internal:retrieveUserQuotaSummary',
    )
    expect(visited[1]).toBe(
      'https://failover-b.test/v1internal:retrieveUserQuotaSummary',
    )
    expect(result.summary.groups[0]!.buckets[0]!.remainingFraction).toBe(0.42)
  })

  it('N1: a transient 500 on the managed attempt does NOT fall through to the projectId fallback', async () => {
    // N1 regression: before the fix, tryBody returned null for ANY failure
    // (403, 500, network). The fallback was entered on all of them, which
    // could return a different project\'s quota data on transient errors.
    // Now the fallback is gated on 403 only.
    const triedProjects: string[] = []
    const fetchVia = async (
      _url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init as any).body ?? '{}')
      triedProjects.push(body.project as string)
      // Return 500 for the managed project attempt (transient error).
      return new Response('internal error', { status: 500 })
    }
    // Both managed and regular project IDs are provided. The 500 on the
    // managed attempt must NOT trigger the projectId fallback.
    await expect(
      fetchQuotaSummary({
        accessToken: 'tok',
        managedProjectId: 'managed-proj',
        projectId: 'regular-proj',
        endpoints: ENDPOINTS,
        fetchVia: fetchVia as any,
      }),
    ).rejects.toThrow()
    // Only the managed project should have been tried — the regular-proj
    // fallback must not run on a transient error.
    expect(triedProjects).toHaveLength(1)
    expect(triedProjects[0]).toBe('managed-proj')
  })

  it('N1: a 500 on the managed attempt does not clobber the 403-fallback path', async () => {
    // Complement: a 403 on the managed project DOES enter the fallback.
    // This ensures the gating change did not accidentally disable the
    // existing 403-fallback behavior.
    const triedProjects: string[] = []
    const summary: RetrieveUserQuotaSummaryResponse = { groups: [] }
    const fetchVia = async (
      _url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init as any).body ?? '{}')
      triedProjects.push(body.project as string)
      if (body.project === 'managed-proj') {
        return new Response('{}', { status: 403 })
      }
      return new Response(JSON.stringify(summary), { status: 200 })
    }
    const result = await fetchQuotaSummary({
      accessToken: 'tok',
      managedProjectId: 'managed-proj',
      projectId: 'regular-proj',
      endpoints: ENDPOINTS,
      fetchVia: fetchVia as any,
    })
    // The 403 on managed-proj must trigger the fallback to regular-proj.
    expect(triedProjects).toHaveLength(2)
    expect(triedProjects[0]).toBe('managed-proj')
    expect(triedProjects[1]).toBe('regular-proj')
    expect(result.summary).toEqual(summary)
  })
})
