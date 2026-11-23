import { expect, test } from 'bun:test'
import { conversation, models } from '../cases.ts'
import { Environment } from '../environment.ts'
import { bodyOf, candidate, credential, sse, success } from '../fixtures.ts'
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

test('Pi consumes the same signed Claude history with and without keep_thinking', async () => {
  const thought = {
    text: 'A cached signed thought.',
    thought: true,
    thoughtSignature: 'fixture-signature-'.repeat(8),
  }
  const captures = []
  for (const keepThinking of [false, true]) {
    const env = new Environment(() => ({
      body: sse(candidate([thought, { text: 'Four.' }], 'STOP')),
    }))
    const pi = await piAdapter(env, 'local', false, {
      keep_thinking: keepThinking,
    })
    try {
      const first = conversation('Pi thinking setting', {
        model: models.claude,
      })
      await pi.run(first, 'thinking')
      await pi.run(
        {
          ...first,
          messages: [
            ...first.messages,
            {
              role: 'assistant',
              parts: [
                {
                  type: 'thinking',
                  text: thought.text,
                  signature: thought.thoughtSignature,
                },
                { type: 'text', text: 'Four.' },
              ],
            },
            { role: 'user', parts: [{ type: 'text', text: 'Check again.' }] },
          ],
        },
        'thinking',
      )
      captures.push(bodyOf(env.wires[1]!).request)
    } finally {
      await pi.dispose()
      await env.dispose()
    }
  }
  expect(JSON.stringify(captures[0])).not.toContain(thought.text)
  expect(JSON.stringify(captures[1])).toContain(thought.text)
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
