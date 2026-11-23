import { AgyResponseIdleTimeoutError } from '../../agy-transport.ts'
import { EngineRefusalError } from '../refusals.ts'

/** Inspect the transformed SSE once, before any host can read a refusal frame. */
export function enforceStreamRefusals(
  source: ReadableStream<Uint8Array>,
  log: (diagnostic: string) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let visible = false
  let finished = false
  let done = false
  let failure: EngineRefusalError | undefined

  const inspect = (line: string): Uint8Array | undefined => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      done = true
      return
    }
    let envelope: any
    try {
      envelope = JSON.parse(payload)
    } catch {
      log(`Malformed Antigravity stream frame: ${payload}`)
      return
    }
    const frame = envelope?.response ?? envelope
    if (!frame || typeof frame !== 'object') return
    if (envelope.error !== undefined || frame.error !== undefined) {
      log(`Antigravity embedded error: ${payload}`)
      failure = new EngineRefusalError('embedded_error')
      return
    }
    if (frame.promptFeedback?.blockReason) {
      log(`Antigravity prompt blocked: ${payload}`)
      failure = new EngineRefusalError('stopped_by_google', {
        finishReason: frame.promptFeedback.blockReason,
      })
      return
    }
    const candidate = frame.candidates?.[0]
    if (Array.isArray(frame.candidates))
      frame.candidates = candidate ? [candidate] : []
    if (Array.isArray(candidate?.content?.parts))
      visible ||= candidate.content.parts.some(
        (part: any) =>
          part?.functionCall ||
          (!part?.thought &&
            typeof part?.text === 'string' &&
            part.text.length > 0),
      )
    const reason = candidate?.finishReason
    if (reason) {
      if (reason !== 'STOP' && reason !== 'MAX_TOKENS') {
        log(`Antigravity finish reason: ${JSON.stringify(reason)}`)
        failure = new EngineRefusalError('stopped_by_google', {
          finishReason: reason,
        })
        delete candidate.finishReason
        if (!candidate.content?.parts?.length) return
      } else if (reason === 'STOP' && !visible) {
        failure = new EngineRefusalError('empty')
        return
      } else {
        finished = true
      }
    }
    return encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`)
  }

  let closed = false
  const close = async (error?: EngineRefusalError) => {
    if (closed) return
    closed = true
    try {
      await reader.cancel(error).catch(() => {})
    } finally {
      reader.releaseLock()
    }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        while (!failure && !done) {
          const newline = buffer.indexOf('\n')
          if (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            const content = inspect(line)
            if (content) {
              controller.enqueue(content)
              return
            }
          } else {
            const next = await reader.read()
            if (next.done) {
              const finalLine = buffer + decoder.decode()
              // A final line without a newline still belongs to this reply.
              buffer = finalLine ? `${finalLine}\n` : ''
              done = !buffer
            } else buffer += decoder.decode(next.value, { stream: true })
          }
        }
      } catch (error) {
        log(`Antigravity body read failed: ${String(error)}`)
        failure = new EngineRefusalError(
          error instanceof AgyResponseIdleTimeoutError
            ? 'deadline'
            : 'transport_error',
        )
      }
      if (!finished)
        failure ??= new EngineRefusalError(visible ? 'incomplete' : 'empty')
      await close(failure)
      if (failure) controller.error(failure)
      else controller.close()
    },
    cancel: () => close(),
  })
}
