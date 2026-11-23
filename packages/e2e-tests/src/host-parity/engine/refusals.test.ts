import { expect, test } from 'bun:test'
import * as engine from '@cortexkit/antigravity-auth-core/engine'
import { isContextOverflow } from '@earendil-works/pi-ai'
import { conversation } from '../cases.ts'
import { Environment } from '../environment.ts'
import { candidate, sse } from '../fixtures.ts'
import { google2 } from '../native-google.ts'
import { piAdapter } from '../pi-surface.ts'
import { runConversation } from '../runner.ts'
import { openCode1IsOverflow } from './vendor/opencode1-overflow.ts'
import { openCode1WouldRetry } from './vendor/opencode1-retry.ts'
import { isRetryableAssistantError as pi152WouldRetry } from './vendor/pi-1.5.2-retry.ts'
import { isRetryableAssistantError as pi160WouldRetry } from './vendor/pi-1.6.0-retry.ts'

const entries = [
  ['quota_wait_exhausted', 412, 412],
  ['quota_exhausted', 429, 429],
  ['capacity_exhausted', 412, 412],
  ['model_not_found', 412, 412],
  ['account_reauthorize', 401, 401],
  ['signature_recovery_failed', 400, 400],
  ['stopped_by_google', 400, 400],
  ['incomplete', 400, 400],
  ['empty', 400, 400],
  ['embedded_error', 400, 400],
  ['deadline', 412, 412],
  ['transport_error', 412, 412],
  ['cancelled', 412, 412],
  ['upstream_http', 400, 400],
  ['retired_model', 412, 412],
  ['model_not_allowed', 412, 412],
  ['busy_store', 503, 412],
  ['authority_changed', 412, 412],
  ['context_overflow', 413, 413],
] as const

test('the closed refusal table cannot induce an unintended host resend', async () => {
  expect(
    Object.keys(Reflect.get(engine, 'ENGINE_REFUSALS') ?? {}).sort(),
  ).toEqual(entries.map(([id]) => id).sort())
  for (const [id, v1Status, v2Status] of entries) {
    const entry = engine.ENGINE_REFUSALS[id]
    const error = new engine.EngineRefusalError(id)
    expect(entry.id).toBe(id)
    expect(error.message).toContain(entry.text)
    expect(error.message).not.toMatch(
      /too_many_requests|exhausted|unavailable|429|5\d\d/i,
    )
    const v1 = engine.engineRefusalResponse(id)
    const responseBody = await v1.text()
    const overflow = openCode1IsOverflow(
      error.message,
      v1.status,
      JSON.parse(responseBody),
    )
    expect(overflow).toBe(id === 'context_overflow')
    expect(v1.status).toBe(v1Status)
    expect(
      openCode1WouldRetry({
        contextOverflow: overflow,
        message: error.message,
        api: {
          status: v1.status,
          // The Google SDK's default retry classification for these HTTP statuses.
          isRetryable: v1.status >= 500 || v1.status === 429,
          responseBody,
        },
      }),
    ).toBe(id === 'busy_store' || id === 'quota_exhausted')
    expect(openCode1WouldRetry({ message: error.message })).toBe(
      id === 'busy_store',
    )
    const v2 = engine.engineRefusalResponse(id, {}, 'openCode2')
    expect(v2.status).toBe(v2Status)
    expect(v2.headers.get('x-should-retry')).toBe('false')
    const pi = { stopReason: entry.pi.stopReason, errorMessage: error.message }
    expect(entry.pi.event).toBe('error')
    expect(pi.stopReason).toBe(id === 'cancelled' ? 'aborted' : 'error')
    expect(pi152WouldRetry(pi)).toBe(false)
    expect(pi160WouldRetry(pi)).toBe(false)
    const piMessage = {
      ...pi,
      content: [],
      usage: { input: 0 },
    } as unknown as Parameters<typeof isContextOverflow>[0]
    expect(isContextOverflow(piMessage, 1_048_576)).toBe(
      id === 'context_overflow',
    )
  }
  const quota = engine.engineRefusalResponse('quota_exhausted', {
    resetAfterMs: 61_250,
  })
  expect(quota.headers.get('retry-after')).toBe('62')
  expect(quota.headers.get('retry-after-ms')).toBe('61250')
  expect(await quota.text()).toContain('Quota resets in 1m 2s.')
  const overflow = await google2(conversation('safe overflow'), async () =>
    engine.engineRefusalResponse('context_overflow', {}, 'openCode2'),
  )
  expect(overflow.compaction).toBe(true)
})

const marker = '/private/refusal-marker-503 account@example.invalid'
const input = conversation('private failure details')

test('Pi returns a safe cancellation instead of a caller-supplied abort reason', async () => {
  const environment = new Environment()
  const pi = await piAdapter(environment, 'local', false)
  try {
    const controller = new AbortController()
    controller.abort(new Error(marker))
    const turn = await pi.run(input, 'cancelled', controller.signal)
    expect(turn.errors).toEqual(['Antigravity request cancelled.'])
    expect(environment.hooks).toEqual([])
    expect(environment.physicalSends).toEqual([])
  } finally {
    await pi.dispose()
    await environment.dispose()
  }
})

for (const subject of ['opencode1', 'opencode2', 'pi'] as const) {
  test(`${subject} never publishes upstream refusal bodies or arbitrary headers`, async () => {
    const result = await runConversation({
      subject,
      custody: 'local',
      input,
      reply: () => ({
        status: 400,
        headers: {
          'content-type': 'application/json',
          'x-upstream-debug': marker,
        },
        body: JSON.stringify({
          error: { message: marker, details: [{ path: marker }] },
        }),
      }),
    })
    expect(result.physicalSends).toHaveLength(1)
    expect(result.turns[0]?.errors.join('\n')).toContain(
      'Google refused the Antigravity request.',
    )
    expect(
      JSON.stringify({
        turns: result.turns,
        notices: result.notices,
        hooks: result.hooks,
      }),
    ).not.toContain('refusal-marker')
  })

  test(`${subject} exposes only an allowlisted Google stop code`, async () => {
    const result = await runConversation({
      subject,
      custody: 'local',
      input,
      reply: () => ({
        body: sse(candidate([{ text: 'Visible.' }]), candidate([], marker)),
      }),
    })
    expect(result.physicalSends).toHaveLength(1)
    expect(result.turns[0]?.text).toBe('Visible.')
    expect(result.turns[0]?.errors.join('\n')).toContain(
      'Response stopped by Google: unknown.',
    )
    expect(
      JSON.stringify({
        turns: result.turns,
        notices: result.notices,
        hooks: result.hooks,
      }),
    ).not.toContain('refusal-marker')
  })

  test(`${subject} discards the body of an embedded upstream error`, async () => {
    const result = await runConversation({
      subject,
      custody: 'local',
      input,
      reply: () => ({
        body: sse({ error: { message: marker, code: 503 } }),
      }),
    })
    expect(result.physicalSends).toHaveLength(1)
    expect(result.turns[0]?.errors.join('\n')).toContain(
      'Antigravity returned an embedded error.',
    )
    expect(
      JSON.stringify({
        turns: result.turns,
        notices: result.notices,
        hooks: result.hooks,
      }),
    ).not.toContain('refusal-marker')
  })
}
