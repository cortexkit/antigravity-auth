import { expect, test } from 'bun:test'
import { conversation, type Subject } from '../cases.ts'
import { candidate, sse } from '../fixtures.ts'
import { runConversation } from '../runner.ts'

const usage = (usageMetadata: object) => ({ response: { usageMetadata } })

for (const subject of ['opencode1', 'opencode2', 'pi'] satisfies Subject[]) {
  test(`${subject} merges usage through EOF without replacing the first terminal`, async () => {
    const { turns, physicalSends } = await runConversation({
      subject,
      custody: 'local',
      input: conversation('split terminal usage'),
      reply: () => ({
        body: sse(
          '{malformed',
          candidate([{ text: 'Other candidate.' }], 'STOP', 1),
          usage({ promptTokenCount: 9, cachedContentTokenCount: 4 }),
          candidate([{ text: 'Four.' }], 'STOP'),
          { error: { message: 'late error' } },
          candidate([{ text: 'Late answer.' }], 'RECITATION'),
          usage({ promptTokenCount: 10, candidatesTokenCount: 2 }),
          usage({ thoughtsTokenCount: 3, totalTokenCount: 15 }),
        ),
      }),
    })
    expect(physicalSends).toHaveLength(1)
    expect(turns[0]?.usage).toEqual({
      input: 6,
      cacheRead: 4,
      output: 5,
      reasoning: 3,
      total: 15,
    })
    expect(turns[0]?.terminal).toEqual(['stop'])
    expect(turns[0]?.text).toBe('Four.')
  })

  test(`${subject} closes a finished but stalled stream at the two-second usage deadline`, async () => {
    const { turns, cancellations } = await runConversation({
      subject,
      custody: 'local',
      input: conversation('stall after STOP'),
      timed: true,
      reply: () => ({
        body: sse(
          candidate([{ text: 'Four.' }], 'STOP'),
          usage({ promptTokenCount: 10, totalTokenCount: 10 }),
        ),
        stall: 'after-body',
      }),
    })
    expect(cancellations).toEqual([2_000])
    expect(turns[0]?.terminal).toEqual(['stop'])
    expect(turns[0]?.usage?.total).toBe(10)
  })
}
