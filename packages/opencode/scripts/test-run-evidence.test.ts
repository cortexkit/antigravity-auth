import { describe, expect, it } from 'bun:test'
import {
  expectedToolOutput,
  readRunEvidence,
} from '../script/test-run-evidence'

const text = (
  answer = 'WORKING',
  sessionID = 'ses_created',
  messageID = 'msg_fresh',
) =>
  JSON.stringify({
    type: 'text',
    sessionID,
    part: { type: 'text', sessionID, messageID, text: answer },
  })
const tool = JSON.stringify({
  type: 'tool_use',
  sessionID: 'ses_created',
  part: {
    type: 'tool',
    sessionID: 'ses_created',
    state: { status: 'completed', output: 'first\n' },
  },
})

describe('manual CLI runner evidence', () => {
  it('accepts the exact assistant answer and its invocation-owned session', () => {
    expect(readRunEvidence(text(), '', 0, { answer: 'WORKING' })).toEqual({
      sessionId: 'ses_created',
      messageId: 'msg_fresh',
      text: 'WORKING',
    })
  })
  it('accepts a final answer after an intermediate assistant message and tool call', () => {
    const output = [
      text('I will run the command', 'ses_created', 'msg_intermediate'),
      tool,
      text(),
    ].join('\n')
    expect(
      readRunEvidence(output, '', 0, {
        answer: 'WORKING',
        toolOutput: 'first',
      }),
    ).toEqual({
      sessionId: 'ses_created',
      messageId: 'msg_fresh',
      text: 'WORKING',
    })
  })
  it.each([
    1, 17,
  ])('rejects an ordinary nonzero exit (%i), even with a valid answer', (code) => {
    expect(() => readRunEvidence(text(), '', code)).toThrow('exited')
  })
  it.each([
    '',
    'not JSON',
    JSON.stringify({ type: 'step_start', sessionID: 'ses_created' }),
  ])('rejects missing or malformed assistant output (%s)', (output) => {
    expect(() => readRunEvidence(output, '', 0)).toThrow()
  })
  it.each([
    'NOT_WORKING',
    'Reply with exactly one word: WORKING',
    '',
  ])('rejects a wrong or echoed model answer (%s)', (answer) => {
    expect(() =>
      readRunEvidence(text(answer), '', 0, { answer: 'WORKING' }),
    ).toThrow()
  })
  it('rejects error events and signature errors alongside valid assistant text', () => {
    expect(() => readRunEvidence(`${text()}\n{"type":"error"}`, '', 0)).toThrow(
      'error event',
    )
    expect(() =>
      readRunEvidence(text(), 'Invalid thinking signature', 0),
    ).toThrow('Invalid signature')
  })
  it('rejects a continuation in an unrelated session', () => {
    expect(() =>
      readRunEvidence(text(), '', 0, { sessionId: 'ses_decoy' }),
    ).toThrow('Wrong assistant session')
  })
  it('requires completed tool evidence when the prompt requests a command', () => {
    expect(expectedToolOutput("Run: echo 'first'")).toBe('first')
    expect(() =>
      readRunEvidence(text('first'), '', 0, { toolOutput: 'first' }),
    ).toThrow('tool output')
    expect(
      readRunEvidence(`${tool}\n${text('first')}`, '', 0, {
        toolOutput: 'first',
      }).text,
    ).toBe('first')
    expect(() =>
      readRunEvidence(`${tool}\n${text('second')}`, '', 0, {
        toolOutput: 'second',
      }),
    ).toThrow('tool output')
  })
})
