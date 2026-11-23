import { expect, spyOn, test } from 'bun:test'
import { createLocalQuotaRefresh } from '@cortexkit/antigravity-auth-core/engine'
import { createRequestExecutor } from '../../../../opencode/src/plugin/shared/request-executor.ts'
import {
  CHAT_INIT,
  disposePools,
  FIXED_NOW,
  type Harness,
  harness,
  makePool,
  NON_STREAM_URL,
  okJson,
  placementHarness,
  QUOTA_ERROR_INFO,
  routedTime,
  routingAdmission,
  vaultDeps,
  wireBearers,
} from '../../../../opencode/src/plugin/shared/request-services-harness.test.ts'

const domains = ['local', 'vault'] as const

type Domain = (typeof domains)[number]
const depsFor = (h: Harness, domain: Domain) =>
  domain === 'local'
    ? h.deps
    : vaultDeps(h, async (row) => routingAdmission(row))

async function dispatch(h: Harness, domain: Domain, count = 1) {
  const executor = createRequestExecutor(depsFor(h, domain))
  try {
    for (let index = 0; index < count; index++)
      await (await executor.execute(NON_STREAM_URL, CHAT_INIT())).text()
    return wireBearers(h).map((header) => Number(header?.at(-1)))
  } finally {
    await executor.dispose()
    await disposePools()
  }
}

function classifiedLimit(reason: string, retryAfter?: number) {
  return Response.json(
    { error: { details: [{ ...QUOTA_ERROR_INFO, reason }] } },
    {
      status: 429,
      headers:
        retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
    },
  )
}

test('a configured retry fallback sets the next eligible time when Google supplies no delay', async () => {
  for (const domain of domains) {
    for (const seconds of [7, 13]) {
      const h = placementHarness({
        config: { default_retry_after_seconds: seconds },
        respond: async (_call, index) =>
          index === 0 ? classifiedLimit('QUOTA_EXHAUSTED') : okJson(),
      })
      const clock = routedTime()
      const row = h.pool.getAccounts()[0]!
      try {
        expect(await dispatch(h, domain)).toEqual([0, 1])
        expect(row.rateLimitResetTimes['gemini:gemini-3-flash']).toBe(
          FIXED_NOW + seconds * 1000,
        )
      } finally {
        clock.restore()
      }
    }
  }
})

test('confirmed failures on both account stores expire on the configured TTL', async () => {
  for (const domain of domains) {
    for (const [ttl, wait] of [
      [60, 60_000],
      [120, 300_000],
    ] as const) {
      const h = placementHarness({
        config: { failure_ttl_seconds: ttl },
        respond: async (_call, index) =>
          index === 0 ? classifiedLimit('QUOTA_EXHAUSTED', 8000) : okJson(),
      })
      const row = h.pool.getAccounts()[0]!
      row.lastFailureTime = FIXED_NOW - 80_000
      row.consecutiveFailures = 1
      const clock = routedTime()
      try {
        expect(await dispatch(h, domain)).toEqual([0, 1])
        expect(row.rateLimitResetTimes['gemini:gemini-3-flash']).toBe(
          FIXED_NOW + wait,
        )
      } finally {
        clock.restore()
      }
    }
  }
})

test('first classified limit switches or retries according to the scheduling settings', async () => {
  for (const domain of domains) {
    for (const [mode, cap, switchFirst, expectedAccount, delays] of [
      ['balance', 10, false, 0, [1000]],
      ['balance', 10, true, 1, [1000]],
      ['cache_first', 10, true, 0, [1000, 8000]],
      ['cache_first', 5, true, 1, [1000]],
    ] as const) {
      const clock = routedTime(1000, 8000)
      try {
        const h = placementHarness({
          config: {
            scheduling_mode: mode,
            max_cache_first_wait_seconds: cap,
            switch_on_first_rate_limit: switchFirst,
          },
          respond: async (_call, index) =>
            index === 0 ? classifiedLimit('RATE_LIMIT_EXCEEDED', 8) : okJson(),
        })
        expect(await dispatch(h, domain)).toEqual([0, expectedAccount])
        expect(clock.delays).toEqual([...delays])
      } finally {
        clock.restore()
      }
    }
  }
})

test('the configured account-switch cap and delay control sends after confirmed limits', async () => {
  for (const domain of domains) {
    for (const [cap, delay, sent] of [
      [0, 23, [0]],
      [1, 71, [0, 1]],
      [2, 23, [0, 1, 2]],
    ] as const) {
      const clock = routedTime(23, 71)
      try {
        const h = placementHarness({
          pool: makePool(3),
          config: { max_account_switches: cap, switch_account_delay_ms: delay },
          respond: async (_call, index) =>
            index < 2 ? classifiedLimit('QUOTA_EXHAUSTED', 8) : okJson(),
        })
        expect(await dispatch(h, domain)).toEqual([...sent])
        expect(clock.delays).toEqual(Array(cap === 0 ? 1 : 2).fill(delay))
      } finally {
        clock.restore()
      }
    }
  }
})

test('disabling cache warmup skips the probe without preventing account switching', async () => {
  for (const domain of domains) {
    for (const enabled of [true, false]) {
      const h = placementHarness({
        config: { cache_warmup_on_switch: enabled },
        respond: async (_call, index) =>
          index === 0 ? classifiedLimit('QUOTA_EXHAUSTED', 8) : okJson(),
      })
      expect(await dispatch(h, domain)).toEqual(enabled ? [0, 1, 1] : [0, 1])
    }
  }
})

function setReading(h: Harness, index: number, fraction: number, age: number) {
  const row = h.pool.getAccounts()[index]!
  row.cachedQuota = { gemini: { modelCount: 1, remainingFraction: fraction } }
  row.cachedQuotaUpdatedAt = FIXED_NOW - age
}

test('the soft quota threshold and automatic or explicit TTL determine which account sends', async () => {
  for (const domain of domains) {
    for (const [threshold, ttl, cadence, expectedAccount] of [
      [10, 'auto', 30, 0],
      [20, 'auto', 30, 1],
      [20, 'auto', 5, 0],
      [20, 10, 30, 0],
      [20, 20, 30, 1],
    ] as const) {
      const clock = routedTime()
      try {
        const h = placementHarness({
          config: {
            soft_quota_threshold_percent: threshold,
            soft_quota_cache_ttl_minutes: ttl,
            quota_refresh_interval_minutes: cadence,
          },
        })
        setReading(h, 0, 0.15, 15 * 60_000)
        setReading(h, 1, 0.8, 0)
        expect(await dispatch(h, domain)).toEqual([expectedAccount])
      } finally {
        clock.restore()
      }
    }
  }
})

test('a non-default proactive rotation threshold changes the account on the next turn', async () => {
  for (const domain of domains) {
    for (const [threshold, expectedAccount] of [
      [0, 0],
      [50, 1],
    ] as const) {
      const clock = routedTime()
      try {
        const h = placementHarness({
          config: { proactive_rotation_threshold_percent: threshold },
        })
        setReading(h, 0, 0.3, 0)
        setReading(h, 1, 0.8, 0)
        expect(await dispatch(h, domain, 2)).toEqual([0, expectedAccount])
      } finally {
        clock.restore()
      }
    }
  }
})

test('the local quota refresh interval enables or skips an advisory refresh after a send', async () => {
  for (const [minutes, expectedCalls] of [
    [0, 0],
    [7, 1],
  ] as const) {
    const h = harness({
      config: { quota_refresh_interval_minutes: minutes },
      respond: async () => okJson(),
    })
    if (h.deps.credentials.domain !== 'local')
      throw new Error('Expected local credentials')
    const calls: number[] = []
    h.deps.credentials.refreshQuotaAfterSuccess = createLocalQuotaRefresh(
      h.pool,
      {
        refreshAccount: async (_account, { index }) => {
          calls.push(index)
          return { status: 'ok' }
        },
        hashedLogLabel: () => 'fixture-account',
      },
      h.deps.logger,
    )
    await dispatch(h, 'local')
    expect(calls).toEqual(Array(expectedCalls).fill(0))
  }
})
