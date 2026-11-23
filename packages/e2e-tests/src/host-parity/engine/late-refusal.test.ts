import { expect, test } from 'bun:test'
import { fetchWithAgyCliTransport } from '@cortexkit/antigravity-auth-core'
import { conversation } from '../cases.ts'
import { Environment } from '../environment.ts'
import { candidate, sse } from '../fixtures.ts'
import { piAdapter } from '../pi-surface.ts'
import { runConversation } from '../runner.ts'
import { responseScenarios } from '../scenarios.ts'

test('a vault safety finish bills as completed and reports served before surfacing a refusal', async () => {
  const result = await runConversation({
    subject: 'opencode1',
    custody: 'vault',
    input: conversation('safety finish routing credit', {
      sessions: ['session'],
    }),
    reply: () => ({ body: sse(candidate([], 'SAFETY')) }),
  })
  expect(result.turns[0]?.terminal).toEqual(['failure:stopped_by_google'])
  expect(result.reports).toEqual([
    expect.objectContaining({
      report: expect.objectContaining({
        kind: 'billing',
        outcome: 'completed',
      }),
    }),
    expect.objectContaining({
      report: expect.objectContaining({ outcome: 'served' }),
    }),
  ])
})

test('Pi local delivers a buffered text delta when the idle timer fires before the body is read', async () => {
  const environment = new Environment(() => ({
    body: sse(candidate([{ text: 'Four.' }])),
    stall: 'after-body',
  }))
  const pi = await piAdapter(
    environment,
    'local',
    false,
    {},
    async (url, init, options) => {
      const idle = Promise.withResolvers<void>()
      const response = await fetchWithAgyCliTransport(url, init, {
        ...options,
        onDebug(message) {
          options?.onDebug?.(message)
          if (message.includes('idle timeout')) idle.resolve()
        },
      })
      await idle.promise
      return response
    },
  )
  try {
    const result = await environment.timed(() =>
      pi.run(conversation('buffered partial answer'), 'idle-session'),
    )
    expect(result.text).toBe('Four.')
    expect(result.terminal).toEqual(['failure:deadline'])
    expect(environment.cancellations).toEqual([180_000])
  } finally {
    await pi.dispose()
    await environment.dispose()
  }
})

test('Pi gives browser and sign-in instructions when Google requires verification', async () => {
  const scenario = responseScenarios.find(
    ({ input }) => input.id === 'lasting 403',
  )!
  const result = await runConversation({
    subject: 'pi',
    custody: 'local',
    input: scenario.input,
    reply: () => scenario.replies[0]!,
  })
  expect(result.notices).toEqual([
    'An Antigravity account needs verification. Complete verification in your browser, then sign in again with /login google.',
  ])
})
