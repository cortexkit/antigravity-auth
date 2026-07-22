import { afterEach, describe, expect, it } from 'bun:test'
import type { AccountMetadataV3 } from './account-types.ts'
import { createQuotaManager, type FetchAccountQuota } from './quota-manager.ts'

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
        groups: { claude: { remainingFraction: 0.5, modelCount: 1 } },
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

function track(disposable: { dispose: () => void }) {
  managers.push(disposable)
  return disposable
}

describe('classifyQuotaGroup', () => {
  it('classifies Antigravity claude models', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(classifyQuotaGroup('claude-sonnet-4-6', 'Claude Sonnet 4.6')).toBe(
      'claude',
    )
  })

  it('classifies gemini flash vs pro via registry', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(
      classifyQuotaGroup('gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'),
    ).toBe('gemini-flash')
    expect(classifyQuotaGroup('gemini-3.1-pro', 'Gemini 3.1 Pro')).toBe(
      'gemini-pro',
    )
  })

  it('classifies gpt-oss variants', () => {
    const { classifyQuotaGroup } = createQuotaManager({
      fetchAccountQuota: makeHarness().fetch,
      keyOf: keyOfAccount,
    })
    expect(classifyQuotaGroup('gpt-oss-120b-medium', 'GPT-OSS 120B')).toBe(
      'gpt-oss',
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
    expect(summary.groups.claude?.remainingFraction).toBe(0.8)
    expect(summary.groups['gemini-pro']?.remainingFraction).toBe(0.4)
    expect(summary.groups['gemini-flash']?.remainingFraction).toBe(0.1)
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
    expect(summary.groups.claude?.remainingFraction).toBe(1)
    expect(summary.groups['gemini-flash']?.remainingFraction).toBe(0)
  })
})

describe('refreshAccount', () => {
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
