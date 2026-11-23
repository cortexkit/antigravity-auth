import { expect, test } from 'bun:test'
import { conversation, models } from '../cases.ts'
import { Environment } from '../environment.ts'
import { bodyOf, candidate, credential, sse, success } from '../fixtures.ts'
import { openCode1 } from '../open-code.ts'
import { piAdapter } from '../pi-surface.ts'

const input = conversation('Pi single account settings')
const ineligible = {
  status: 403,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    error: {
      status: 'PERMISSION_DENIED',
      details: [{ reason: 'VALIDATION_REQUIRED' }],
    },
  }),
}
const missing = {
  status: 404,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    error: { status: 'NOT_FOUND', message: 'Fixture model not found' },
  }),
}
const modelUnavailable =
  'Antigravity request failed: HTTP 412 {"error":{"code":412,"status":"FAILED_PRECONDITION","message":"The requested Antigravity model is not available to the configured accounts. Choose another model."}}'

test('vault endpoint fallback waits for receipt I/O without advancing the fixture clock', async () => {
  const env = new Environment(() => ({ stall: 'before-headers' }))
  let admissions = 0
  const pi = await piAdapter(env, 'vault', false, {}, undefined, async () => {
    if (++admissions === 2) await Bun.sleep(15)
  })
  try {
    const result = await env.timed(() => pi.run(input, 'slow-vault-fallback'))
    expect(admissions).toBe(2)
    expect(env.physicalSends.map(({ endpoint }) => endpoint)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com',
      'https://cloudcode-pa.googleapis.com',
    ])
    expect(env.delays).toEqual([180_000])
    expect(env.cancellations).toEqual([180_000, 360_000])
    expect(env.aborts).toEqual([])
    expect(result.terminal).toEqual(['failure:deadline'])
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

for (const [gate, settings] of [
  [
    'health',
    {
      health_score: {
        initial: 0,
        min_usable: 100,
        max_score: 100,
        success_reward: 0,
        failure_penalty: -100,
        rate_limit_penalty: -50,
        recovery_rate_per_hour: 0,
      },
    },
  ],
  [
    'token bucket',
    {
      token_bucket: {
        max_tokens: 1,
        initial_tokens: 1,
        regeneration_rate_per_minute: 0.1,
      },
    },
  ],
  [
    'killswitch',
    {
      killswitch: {
        enabled: true,
        minimum_remaining_percent: 100,
        accounts: {},
      },
    },
  ],
  [
    'quota floor',
    {
      killswitch: {
        enabled: true,
        minimum_remaining_percent: 0,
        accounts: { 'parity-identity': 100 },
      },
    },
  ],
  ['soft quota', { soft_quota_threshold_percent: 1 }],
  [
    'cache-first wait',
    { scheduling_mode: 'cache_first', max_cache_first_wait_seconds: 300 },
  ],
  ['switch delay', { switch_account_delay_ms: 10_000 }],
] as const) {
  test(`Pi does not apply the ${gate} pool gate to its only account`, async () => {
    const env = new Environment()
    const pi = await piAdapter(env, 'local', false, settings)
    try {
      expect((await pi.run(input, 'gate')).terminal).toEqual(['stop'])
      expect((await pi.run(input, 'gate')).terminal).toEqual(['stop'])
      expect(env.physicalSends).toHaveLength(2)
      expect(env.delays).toEqual([])
    } finally {
      await pi.dispose()
      await env.dispose()
    }
  })
}

async function replaceLogin(file: string, suffix: string) {
  const saved = await Bun.file(file).json()
  await Bun.write(
    file,
    JSON.stringify(
      {
        ...saved,
        google: {
          ...saved.google,
          access: `${credential.accessToken}-${suffix}`,
          refresh: `${suffix}|${credential.projectId}|${credential.projectId}`,
        },
      },
      null,
      2,
    ),
  )
}

test('Pi leaves a refused native slot byte-identical and sends after a new login', async () => {
  const env = new Environment((_wire, index) =>
    index === 0 ? ineligible : success,
  )
  const pi = await piAdapter(env, 'local', false)
  try {
    await pi.activate()
    const before = await Bun.file(pi.nativeAuthPath).text()
    expect((await pi.run(input, 'reauthorize')).terminal).toEqual([
      'failure:account_reauthorize',
    ])
    expect(await Bun.file(pi.nativeAuthPath).text()).toBe(before)
    expect(env.physicalSends).toHaveLength(1)
    await replaceLogin(pi.nativeAuthPath, 'replacement')
    expect((await pi.run(input, 'reauthorize')).terminal).toEqual(['stop'])
    expect(env.physicalSends).toHaveLength(2)
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('a replaced native credential does not inherit NOT_FOUND for the same model', async () => {
  const env = new Environment((_wire, index) =>
    index === 0 ? missing : success,
  )
  const pi = await piAdapter(env, 'local', false)
  try {
    await pi.activate()
    await pi.run(input, 'missing')
    await pi.run(input, 'missing')
    expect(env.physicalSends).toHaveLength(1)
    await replaceLogin(pi.nativeAuthPath, 'available')
    expect((await pi.run(input, 'missing')).terminal).toEqual(['stop'])
    expect(env.physicalSends).toHaveLength(2)
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('keep_thinking enables Claude warmup bytes without calling the Pi hooks for the warmup', async () => {
  const captures = []
  for (const keepThinking of [false, true]) {
    const env = new Environment()
    const pi = await piAdapter(env, 'local', false, {
      keep_thinking: keepThinking,
      thinking_warmup: true,
    })
    try {
      const first = conversation('Pi thinking setting', {
        model: models.claude,
      })
      await pi.run(
        {
          ...first,
          messages: [
            ...first.messages,
            {
              role: 'assistant',
              parts: [
                {
                  type: 'call',
                  id: 'lookup-1',
                  name: 'lookup',
                  args: { key: 'value' },
                },
                { type: 'text', text: 'Four.' },
              ],
            },
            { role: 'user', parts: [{ type: 'text', text: 'Check again.' }] },
          ],
        },
        'thinking',
      )
      captures.push(env.wires.map(bodyOf))
      expect(env.hooks).toHaveLength(2)
    } finally {
      await pi.dispose()
      await env.dispose()
    }
  }
  expect(captures[0]).toHaveLength(1)
  expect(captures[1]).toHaveLength(2)
  expect(captures[1]?.[0]?.request).not.toEqual(captures[1]?.[1]?.request)
})

test('Pi observes each main payload and response without replacing the body', async () => {
  const env = new Environment((_wire, attempt) =>
    attempt === 0
      ? { transportError: 'Fixture daily unavailable' }
      : {
          body: sse({
            responseId: 'fixture-response-id',
            response: candidate([{ text: 'Four.' }], 'STOP').response,
          }),
        },
  )
  const pi = await piAdapter(env, 'local', true)
  try {
    const result = await pi.run(input, 'hooks')
    expect(result.terminal).toEqual(['stop'])
    expect(result.responseId).toBe('fixture-response-id')
    expect(result.rawStopReason).toBe('STOP')
    expect(env.hooks).toEqual([
      { payload: bodyOf(env.wires[0]!).request },
      { payload: bodyOf(env.wires[1]!).request },
      {
        response: {
          status: 200,
          headers: expect.objectContaining({
            'content-type': 'text/event-stream',
          }),
        },
      },
    ])
    expect(JSON.stringify(env.hooks)).not.toContain(credential.accessToken)
    expect(JSON.stringify(env.hooks)).not.toContain(credential.projectId)
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('Pi custody sends without a routing accessor or a report', async () => {
  const env = new Environment()
  const pi = await piAdapter(env, 'vault', false)
  try {
    expect((await pi.run(input, 'no-accessor')).terminal).toEqual(['stop'])
    expect(env.physicalSends).toHaveLength(1)
    expect(env.reports).toEqual([])
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('Pi refuses a failed native refresh without writing the login slot', async () => {
  const env = new Environment()
  const pi = await piAdapter(env, 'local', false)
  try {
    const provider = await pi.activate()
    const bytes = await Bun.file(pi.nativeAuthPath).text()
    const auth = JSON.parse(bytes).google
    await expect(
      provider.oauth!.refreshToken(auth, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'account_reauthorize',
    })
    expect(await Bun.file(pi.nativeAuthPath).text()).toBe(bytes)
    expect(env.physicalSends).toEqual([])
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('Pi custody reports a wait start and cancellation without sending again', async () => {
  const env = new Environment(() => ({
    status: 429,
    headers: { 'content-type': 'application/json' },
    body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}',
  }))
  const controller = new AbortController()
  const key = Symbol.for('cortexkit.routing')
  const original = Reflect.getOwnPropertyDescriptor(globalThis, key)
  Reflect.defineProperty(globalThis, key, {
    configurable: true,
    value: (session: string) => ({
      report(report: Record<string, unknown>) {
        env.reports.push({ session, report })
        if (report.phase === 'start') controller.abort()
      },
    }),
  })
  const pi = await piAdapter(env, 'vault', false)
  try {
    expect(
      (
        await env.timed(() =>
          pi.run(input, 'cancelled-wait', controller.signal),
        )
      ).terminal,
    ).toEqual(['failure:cancelled'])
    expect(env.physicalSends).toHaveLength(1)
    expect(env.reports).toEqual([
      {
        session: 'cancelled-wait',
        report: expect.objectContaining({
          kind: 'billing',
          request_kind: 'primary',
          status: 429,
          attempt: 1,
          outcome: 'failed',
        }),
      },
      {
        session: 'cancelled-wait',
        report: expect.objectContaining({
          kind: 'transient_backoff',
          account_id: 'parity-identity',
          credential_id: 'parity-credential',
        }),
      },
      {
        session: 'cancelled-wait',
        report: expect.objectContaining({
          kind: 'wait',
          phase: 'start',
          attempt: 1,
          reason: 'rate_limited',
          wait_id: expect.any(String),
        }),
      },
      {
        session: 'cancelled-wait',
        report: expect.objectContaining({
          kind: 'wait',
          phase: 'end',
          attempt: 1,
          reason: 'rate_limited',
          wait_id: (env.reports[2] as { report: { wait_id: string } }).report
            .wait_id,
          outcome: 'cancelled',
        }),
      },
    ])
  } finally {
    if (original) Reflect.defineProperty(globalThis, key, original)
    else Reflect.deleteProperty(globalThis, key)
    await pi.dispose()
    await env.dispose()
  }
})

test('Pi custody does not report billing without a host session id', async () => {
  const env = new Environment()
  const key = Symbol.for('cortexkit.routing')
  const original = Reflect.getOwnPropertyDescriptor(globalThis, key)
  Reflect.defineProperty(globalThis, key, {
    configurable: true,
    value: () => ({
      report(report: unknown) {
        env.reports.push(report)
      },
    }),
  })
  const pi = await piAdapter(env, 'vault', false)
  try {
    expect((await pi.run(input)).terminal).toEqual(['stop'])
    expect(env.physicalSends).toHaveLength(1)
    expect(env.reports).toEqual([])
  } finally {
    if (original) Reflect.defineProperty(globalThis, key, original)
    else Reflect.deleteProperty(globalThis, key)
    await pi.dispose()
    await env.dispose()
  }
})

test('an outstanding NOT_FOUND marks its original native credential, not the replacement', async () => {
  const env = new Environment()
  const sawOldSend = Promise.withResolvers<void>()
  const oldReply = Promise.withResolvers<Response>()
  const sent: string[] = []
  const pi = await piAdapter(env, 'local', false, {}, async (_url, init) => {
    const bearer = new Headers(init?.headers).get('authorization') ?? ''
    sent.push(bearer)
    if (bearer === `Bearer ${credential.accessToken}`) {
      sawOldSend.resolve()
      return oldReply.promise
    }
    return new Response(success.body, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  try {
    await pi.activate()
    const pending = pi.run(input, 'old-request')
    await sawOldSend.promise
    await replaceLogin(pi.nativeAuthPath, 'new-slot')
    expect((await pi.run(input, 'new-request')).terminal).toEqual(['stop'])
    oldReply.resolve(new Response(missing.body, missing))
    expect((await pending).errors).toEqual([modelUnavailable])
    expect((await pi.run(input, 'new-request')).terminal).toEqual(['stop'])
    expect(sent).toEqual([
      `Bearer ${credential.accessToken}`,
      `Bearer ${credential.accessToken}-new-slot`,
      `Bearer ${credential.accessToken}-new-slot`,
    ])
  } finally {
    oldReply.resolve(new Response(missing.body, missing))
    await pi.dispose()
    await env.dispose()
  }
})

test('NOT_FOUND for the native login does not follow a Pi activation into vault custody', async () => {
  const env = new Environment((_wire, index) =>
    index === 0 ? missing : success,
  )
  const pi = await piAdapter(env, 'local', false)
  try {
    expect((await pi.run(input, 'switch-custody')).errors).toEqual([
      modelUnavailable,
    ])
    expect((await pi.run(input, 'switch-custody')).errors).toEqual([
      modelUnavailable,
    ])
    expect(env.physicalSends).toHaveLength(1)
    await pi.switchToVault()
    expect((await pi.run(input, 'switch-custody')).terminal).toEqual(['stop'])
    expect(env.physicalSends).toHaveLength(2)
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('NOT_FOUND for a vault route does not apply to a later record version on that route', async () => {
  const env = new Environment((_wire, index) =>
    index === 0 ? missing : success,
  )
  const pi = await piAdapter(env, 'vault', false)
  try {
    expect((await pi.run(input, 'vault-version')).errors).toEqual([
      modelUnavailable,
    ])
    expect((await pi.run(input, 'vault-version')).errors).toEqual([
      modelUnavailable,
    ])
    expect(env.physicalSends).toHaveLength(1)
    pi.replaceVaultRecord()
    expect((await pi.run(input, 'vault-version')).terminal).toEqual(['stop'])
    expect(env.physicalSends).toHaveLength(2)
  } finally {
    await pi.dispose()
    await env.dispose()
  }
})

test('Pi and OpenCode 1 share the structured same-account rate-limit trace', async () => {
  const structured = {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: {
        code: 429,
        message: 'Request refused',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
          },
        ],
      },
    }),
  }
  async function capture(subject: 'pi' | 'opencode1') {
    const env = new Environment(() => structured)
    const host =
      subject === 'pi'
        ? await piAdapter(env, 'local', false)
        : await openCode1(env, 'local', input)
    try {
      const started = Date.now()
      const result = await env.timed(() => host.run(input, 'same-account'))
      expect(result.text).toBe('')
      const beforeFinalWait = env.delays.reduce(
        (total, delay) => total + delay,
        0,
      )
      return {
        sends: env.physicalSends,
        waits: [...env.delays, Date.now() - started - beforeFinalWait],
      }
    } finally {
      await host.dispose()
      await env.dispose()
    }
  }
  const expected = {
    sends: Array.from({ length: 3 }, () => ({
      endpoint: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.8-flash-medium',
      route: credential.projectId,
    })),
    waits: [1000, 1000, 2000],
  }
  expect(await capture('opencode1')).toEqual(expected)
  expect(await capture('pi')).toEqual(expected)
})
