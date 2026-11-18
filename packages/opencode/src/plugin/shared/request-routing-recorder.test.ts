import { afterEach, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequestExecutor } from './request-services'
import {
  CHAT_INIT,
  disposePools,
  FIXED_NOW,
  makePool,
  NON_STREAM_URL,
  okJson,
  placementHarness,
  quotaReading,
  quotaRefusal,
  routedTime,
  routingAdmission,
  routingSession,
  vaultDeps,
  wireBearers,
} from './request-services-harness.test'

const ROUTING = Symbol.for('cortexkit.routing')

type Route = { account_id: string; credential_id: string }
type Ask = {
  mode?: 'continue'
  request_id?: string
  exhausted?: Record<string, unknown>
  candidates?: { view_digest: string; accounts: Route[] }
}
type Answer =
  | Route
  | {
      refused: {
        code:
          | 'account_selection_refused'
          | 'account_selection_final'
          | 'account_limit_exhausted'
        routing_code?: string
        reason?: string
        retry_after_secs?: number
        resets_at_ms?: number
      }
    }
type Call =
  | {
      method: 'accountFor'
      sessionId: string
      args: [Ask, { deadlineMs: number }]
      answer: Answer
    }
  | { method: 'report'; sessionId: string; args: [Record<string, unknown>] }

afterEach(disposePools)

async function captureRouting<T>(
  answers: readonly Answer[],
  run: () => Promise<T>,
) {
  const calls: Call[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, ROUTING)
  let askIndex = 0
  Object.defineProperty(globalThis, ROUTING, {
    configurable: true,
    value: (sessionId: string) => ({
      async accountFor(...args: [Ask, { deadlineMs: number }]) {
        const answer = answers[askIndex++]!
        calls.push({
          method: 'accountFor',
          sessionId,
          args: structuredClone(args),
          answer,
        })
        return answer
      },
      report(...args: [Record<string, unknown>]) {
        calls.push({ method: 'report', sessionId, args: structuredClone(args) })
      },
    }),
  })
  try {
    const result = await run()
    expect(askIndex).toBe(answers.length)
    return { calls, result }
  } finally {
    if (previous) Object.defineProperty(globalThis, ROUTING, previous)
    else Reflect.deleteProperty(globalThis, ROUTING)
  }
}

async function writeSample(name: string, sample: unknown) {
  const directory = process.env.AGY_RECORD_ROUTING_SAMPLES
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${name}.json`),
    `${JSON.stringify(sample, null, 2)}\n`,
  )
}

function route(index: number): Route {
  return {
    account_id: `identity-${index}`,
    credential_id: `credential-${index}`,
  }
}

type Scenario = {
  name: string
  kind?: 'primary' | 'generate' | 'compaction'
  answers: readonly Answer[]
  firstResponse?: () => Response
  provedQuota?: boolean
  sleepMs?: number
}

async function runCase({
  name,
  kind = 'primary',
  answers,
  firstResponse,
  provedQuota,
  sleepMs,
}: Scenario) {
  const clock = routedTime(...(sleepMs === undefined ? [] : [sleepMs]))
  try {
    const pool = makePool(2)
    const quota = provedQuota ? quotaReading(pool) : undefined
    const h = placementHarness({
      pool,
      respond: async (_call, index) =>
        index === 0 && firstResponse ? firstResponse() : okJson(),
    })
    const executor = createRequestExecutor(
      vaultDeps(h, async (account) => routingAdmission(account)),
    )
    const { calls, result: response } = await captureRouting(
      answers,
      async () => {
        try {
          const result = await executor.execute(
            NON_STREAM_URL,
            CHAT_INIT(),
            routingSession(name, kind),
          )
          return {
            status: result.status,
            headers: Object.fromEntries(result.headers),
            body: await result.text(),
          }
        } finally {
          await executor.dispose()
        }
      },
    )
    expect(clock.delays).toEqual(sleepMs === undefined ? [] : [sleepMs])
    const identitiesByBearer = new Map(
      pool.getAccounts().map((row) => {
        const { accessToken, accountIdentity, credentialId } =
          routingAdmission(row)
        return [
          `Bearer ${accessToken}`,
          { account_id: accountIdentity, credential_id: credentialId },
        ]
      }),
    )
    const sends = wireBearers(h).map((bearer) => {
      const identity = identitiesByBearer.get(bearer ?? '')
      expect(identity).toBeDefined()
      return identity
    })
    return { sample: { name, kind, calls, sends, response }, quota }
  } finally {
    clock.restore()
  }
}

function asks(calls: Call[]) {
  return calls.flatMap((call) =>
    call.method === 'accountFor' ? [call.args[0]] : [],
  )
}

function placementEvents(calls: Call[]) {
  return calls.flatMap((call) => {
    if (call.method === 'accountFor') return [call.args[0].mode ?? 'first']
    const report = call.args[0]
    if (report.kind === 'transient_backoff') return [report.kind]
    // Billing and wait records stay in the capture but aren't placement outcomes.
    return report.kind === undefined && report.outcome ? [report.outcome] : []
  })
}

function expectServed(calls: Call[], index: number) {
  expect(calls).toContainEqual(
    expect.objectContaining({
      method: 'report',
      args: [expect.objectContaining({ outcome: 'served', ...route(index) })],
    }),
  )
}

async function firstPlacement(
  name: string,
  kind: NonNullable<Scenario['kind']>,
) {
  const { sample } = await runCase({ name, kind, answers: [route(1)] })
  const { calls, response, sends } = sample
  expect(response.status).toBe(200)
  expect(sends).toEqual([route(1)])
  expect(placementEvents(calls)).toEqual(['first', 'served'])
  expect(asks(calls)[0]?.candidates).toEqual({
    view_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    accounts: [route(0), route(1)],
  })
  expectServed(calls, 1)
  return sample
}

it('records first primary placement', async () => {
  const name = '01-first-placement'
  await writeSample(name, await firstPlacement(name, 'primary'))
})

it('records first generate and compaction placement', async () => {
  const name = '02-generate-first-placement'
  await writeSample(name, [
    await firstPlacement('02-generate-first-placement', 'generate'),
    await firstPlacement('02-compaction-first-placement', 'compaction'),
  ])
})

it('records proved quota exhaustion and a successful continuation', async () => {
  const name = '03-exhausted-continue'
  const { sample, quota } = await runCase({
    name,
    answers: [route(0), route(1)],
    firstResponse: quotaRefusal,
    provedQuota: true,
  })
  expect(quota).toBeDefined()
  expect(sample.response.status).toBe(200)
  expect(sample.sends).toEqual([route(0), route(1)])
  expect(placementEvents(sample.calls)).toEqual([
    'first',
    'exhausted',
    'continue',
    'served',
  ])
  expect(sample.calls).toContainEqual(
    expect.objectContaining({
      method: 'report',
      args: [
        {
          outcome: 'exhausted',
          ...route(0),
          window: '5h',
          pool: 'gemini',
          resets_at: quota!.reset,
        },
      ],
    }),
  )
  expect(asks(sample.calls)[1]).toMatchObject({
    mode: 'continue',
    request_id: expect.stringMatching(/^[a-f\d-]{36}$/),
    exhausted: {
      account: route(0).account_id,
      credential_id: route(0).credential_id,
      limit_window: 'five_hour',
      pool: 'gemini',
      observed_at_ms: quota!.observedAt,
      resets_at_ms: quota!.reset,
    },
  })
  expectServed(sample.calls, 1)
  await writeSample(name, sample)
})

it('records a validation-required continuation without a credential-refused report', async () => {
  const name = '04-signed-out-continue'
  const { sample } = await runCase({
    name,
    answers: [route(0), route(1)],
    firstResponse: () =>
      Response.json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Verify your account',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'VALIDATION_REQUIRED',
              },
            ],
          },
        },
        { status: 403 },
      ),
  })
  expect(sample.response.status).toBe(200)
  expect(sample.sends).toEqual([route(0), route(1)])
  expect(placementEvents(sample.calls)).toEqual(['first', 'continue', 'served'])
  const ask = asks(sample.calls)[1]
  expect(ask?.request_id).toMatch(/^[a-f\d-]{36}$/)
  expect(ask?.exhausted).toEqual({
    account: route(0).account_id,
    credential_id: route(0).credential_id,
    limit_window: 'signed_out',
    observed_at_ms: FIXED_NOW,
  })
  expectServed(sample.calls, 1)
  await writeSample(name, sample)
})

it('records transient backoff and a retry on the same credential', async () => {
  const name = '05-transient-backoff'
  const { sample } = await runCase({
    name,
    answers: [route(0)],
    firstResponse: () =>
      Response.json({}, { status: 429, headers: { 'Retry-After': '8' } }),
    sleepMs: 8000,
  })
  expect(sample.response.status).toBe(200)
  expect(sample.sends).toEqual([route(0), route(0)])
  expect(placementEvents(sample.calls)).toEqual([
    'first',
    'transient_backoff',
    'served',
  ])
  expect(sample.calls).toContainEqual(
    expect.objectContaining({
      method: 'report',
      args: [
        {
          kind: 'transient_backoff',
          ...route(0),
          retry_at_ms: FIXED_NOW + 8000,
        },
      ],
    }),
  )
  expectServed(sample.calls, 0)
  await writeSample(name, sample)
})

it('records the three refusal answers and their fixed 412 responses', async () => {
  const refusalCases = [
    {
      name: '06-first-refusal-with-retry',
      answers: [
        {
          refused: {
            code: 'account_selection_refused',
            retry_after_secs: 30,
            reason: 'vault.empty',
          },
        },
      ],
      retryAfter: '30',
    },
    {
      name: '06-first-refusal-without-retry',
      answers: [{ refused: { code: 'account_selection_final' } }],
      retryAfter: undefined,
    },
    {
      name: '06-continue-refusal',
      answers: [
        route(0),
        {
          refused: {
            code: 'account_limit_exhausted',
            resets_at_ms: FIXED_NOW + 90_000,
            reason: 'pool.empty',
          },
        },
      ],
      firstResponse: quotaRefusal,
      provedQuota: true,
      retryAfter: '90',
    },
  ] as const satisfies ReadonlyArray<
    Scenario & { retryAfter: string | undefined }
  >

  const samples = []
  for (const { retryAfter, ...scenario } of refusalCases) {
    const { sample } = await runCase(scenario)
    const continued = scenario.answers.length === 2
    expect(placementEvents(sample.calls)).toEqual(
      continued ? ['first', 'exhausted', 'continue'] : ['first'],
    )
    expect(sample.sends).toEqual(continued ? [route(0)] : [])
    expect(sample.response.status).toBe(412)
    expect(sample.response.headers['retry-after']).toBe(retryAfter)
    expect(JSON.parse(sample.response.body)).toEqual({
      error: {
        code: 412,
        status: 'FAILED_PRECONDITION',
        message:
          'Routing has no Antigravity account available for this request right now. Wait before sending another request.',
      },
    })
    samples.push(sample)
  }
  await writeSample('06-refusals', samples)
})
