import { expect, test } from 'bun:test'
import { type Custody, conversation, type Subject } from '../cases.ts'
import { candidate, type Reply, sse } from '../fixtures.ts'
import { runConversation } from '../runner.ts'

const invalid = candidate([{ text: '' }], 'MALFORMED_FUNCTION_CALL')
const secondText = candidate([{ text: 'Recovered reply.' }], 'STOP')
const rejected = 'failure:stopped_by_google'
const cases = [
  {
    name: 'resends a malformed tool call and publishes the new reply once',
    replies: [{ body: sse(invalid) }, { body: sse(secondText) }],
    terminal: 'stop',
    text: 'Recovered reply.',
  },
  {
    name: 'surfaces the second invalid finish and does not send a third time',
    replies: [
      { body: sse(invalid) },
      { body: sse(candidate([], 'UNEXPECTED_TOOL_CALL')) },
    ],
    terminal: rejected,
    code: 'UNEXPECTED_TOOL_CALL',
  },
  {
    name: 'preserves visible text and does not resend a malformed response',
    replies: [
      {
        body: sse(
          candidate([{ text: 'Partial.' }]),
          candidate([], 'MALFORMED_RESPONSE'),
        ),
      },
    ],
    terminal: rejected,
    code: 'MALFORMED_RESPONSE',
    text: 'Partial.',
  },
  {
    name: 'resends after thinking and keeps thinking from both attempts',
    replies: [
      {
        body: sse(
          candidate([{ thought: true, text: 'First thought. ' }]),
          invalid,
        ),
      },
      {
        body: sse(
          candidate([{ thought: true, text: 'Second thought.' }]),
          secondText,
        ),
      },
    ],
    terminal: 'stop',
    thinking: 'First thought. Second thought.',
    text: 'Recovered reply.',
  },
  {
    name: 'classifies a quota refusal on the resend without a third send',
    replies: [
      { body: sse(invalid) },
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
        body: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }),
      },
    ],
    terminal: 'failure:quota_wait_exhausted',
  },
] satisfies {
  name: string
  replies: Reply[]
  terminal: string
  text?: string
  thinking?: string
  code?: string
}[]

for (const subject of ['opencode1', 'opencode2', 'pi'] satisfies Subject[]) {
  for (const custody of ['local', 'vault'] satisfies Custody[]) {
    for (const scenario of cases) {
      test(`${subject}/${custody} invalid-output finish: ${scenario.name}`, async () => {
        const result = await runConversation({
          subject,
          custody,
          input: conversation('invalid-output finish'),
          reply: (_, index) =>
            scenario.replies[index] ?? { body: sse(secondText) },
        })
        const turn = result.turns[0]!
        expect(result.physicalSends).toHaveLength(scenario.replies.length)
        if (scenario.replies.length === 2) {
          expect(result.physicalSends[1]).toEqual(result.physicalSends[0])
          expect(result.wire[1]?.bodyBase64).toBe(result.wire[0]?.bodyBase64)
        }
        expect(turn.terminal).toEqual([scenario.terminal])
        expect(turn.text).toBe(scenario.text ?? '')
        expect(turn.thinking).toBe(scenario.thinking ?? '')
        if (scenario.code) expect(turn.errors[0]).toContain(scenario.code)
        expect(result.notices).toEqual([])
        if (custody === 'vault') {
          const reports = result.reports.map(
            ({ report }) => report as { kind?: string; outcome?: string },
          )
          expect(reports.filter(({ kind }) => kind === 'billing')).toHaveLength(
            scenario.replies.length,
          )
          expect(
            reports.filter(({ outcome }) => outcome === 'served'),
          ).toHaveLength(
            scenario.terminal === 'failure:quota_wait_exhausted'
              ? 1
              : scenario.replies.length,
          )
        }
      })
    }
  }
}
