import { expect, test } from 'bun:test'
import { conversation, type Subject } from '../cases.ts'
import { candidate, sse } from '../fixtures.ts'
import { runConversation } from '../runner.ts'

for (const subject of ['opencode1', 'opencode2', 'pi'] satisfies Subject[]) {
  test(`${subject} ends a CONTINUATION finish like the output limit`, async () => {
    const observed = []
    for (const finishReason of ['MAX_TOKENS', 'CONTINUATION']) {
      const result = await runConversation({
        subject,
        custody: 'local',
        input: conversation('continuation finish'),
        reply: () => ({
          body: sse(candidate([{ text: 'Four.' }], finishReason)),
        }),
      })
      expect(result.physicalSends).toHaveLength(1)
      observed.push(result.turns[0])
    }
    const [limit, continuation] = observed
    expect(continuation?.terminal).toEqual(['length'])
    expect(continuation?.text).toBe('Four.')
    expect(continuation?.terminal).toEqual(limit?.terminal)
    expect(continuation?.text).toEqual(limit?.text)
  })
}
