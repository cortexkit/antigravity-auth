import { describe, expect, it } from 'bun:test'
import { type RequestEvent, readRequestEvents } from './events.ts'
import { enforceStreamRefusals } from './refusal-stream.ts'

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const textFrame =
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial answer"}]}}]}}\n\n'
const terminalFrame = (finishReason: string) =>
  `data: ${JSON.stringify({ response: { candidates: [{ finishReason }] } })}\n\n`

async function requestEvents(finishReason: string): Promise<RequestEvent[]> {
  const events: RequestEvent[] = []
  for await (const event of readRequestEvents(
    sseResponse([textFrame, terminalFrame(finishReason)]),
  ))
    events.push(event)
  return events
}

async function forwardedBody(finishReason: string): Promise<string> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(textFrame))
      controller.enqueue(encoder.encode(terminalFrame(finishReason)))
      controller.close()
    },
  })
  const output = enforceStreamRefusals(source, { log: () => {} })
  const reader = output.getReader()
  let text = ''
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  text += decoder.decode()
  reader.releaseLock()
  return text
}

describe('Google CONTINUATION finish', () => {
  it('reads exactly like MAX_TOKENS on the Pi event path', async () => {
    const continuation = await requestEvents('CONTINUATION')
    const limit = await requestEvents('MAX_TOKENS')
    expect(continuation).toEqual(limit)
    expect(continuation.at(-1)).toEqual({ type: 'terminal', reason: 'length' })
  })

  it('forwards exactly like MAX_TOKENS on the OpenCode refusal path', async () => {
    const continuation = await forwardedBody('CONTINUATION')
    const limit = await forwardedBody('MAX_TOKENS')
    expect(continuation).toEqual(limit)
    expect(continuation).toContain('"finishReason":"MAX_TOKENS"')
    expect(continuation).not.toContain('CONTINUATION')
  })

  it('still refuses other unknown finish reasons', async () => {
    for (const finishReason of ['SAFETY', 'PRIVATE_FIXTURE_CODE']) {
      const events = await requestEvents(finishReason)
      expect(events.at(-1)).toMatchObject({ type: 'failure' })
    }
  })
})
