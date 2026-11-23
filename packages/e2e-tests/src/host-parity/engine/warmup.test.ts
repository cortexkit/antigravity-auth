import { expect, test } from 'bun:test'
import { call, conversation, models } from '../cases.ts'
import { Environment } from '../environment.ts'
import { bodyOf, candidate, type Reply, sse, success } from '../fixtures.ts'
import { piAdapter } from '../pi-surface.ts'

for (const failure of [
  { status: 422, headers: { 'content-type': 'application/json' }, body: '{}' },
  { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
] satisfies Reply[]) {
  test(`Pi does not count an auxiliary HTTP ${failure.status} without a terminal as a successful warmup`, async () => {
    let warmups = 0
    const environment = new Environment((wire) => {
      if (
        !JSON.stringify(bodyOf(wire).request).includes(
          'Warmup request for thinking signature.',
        )
      )
        return success
      ++warmups
      if (warmups === 1) return failure
      return {
        body: sse(candidate([{ thought: true, text: 'Primed.' }], 'STOP')),
      }
    })
    const pi = await piAdapter(environment, 'local', false, {
      keep_thinking: true,
      thinking_warmup: true,
    })
    const base = conversation('thinking warmup', { model: models.claude })
    const input = {
      ...base,
      messages: [
        ...base.messages,
        {
          role: 'assistant' as const,
          parts: [call, { type: 'text' as const, text: 'Four.' }],
        },
        {
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'Check again.' }],
        },
      ],
    }
    try {
      for (let turn = 0; turn < 3; ++turn) {
        const result = await pi.run(input, 'warmup-session')
        expect(result.terminal).toEqual(['stop'])
      }
      expect(warmups).toBe(2)
      expect(environment.physicalSends).toHaveLength(5)
      expect(environment.hooks).toHaveLength(6)
    } finally {
      await pi.dispose()
      await environment.dispose()
    }
  })
}
