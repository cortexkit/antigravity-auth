import { AgyResponseIdleTimeoutError } from '../../agy-transport.ts'
import { EngineRefusalError } from '../refusals.ts'
import { primaryCandidate } from './terminal-event.ts'

const USAGE_DRAIN_MS = 2_000
const drainExpired = Symbol('usage drain expired')
const invalidOutputCodes = new Set([
  'MALFORMED_FUNCTION_CALL',
  'MALFORMED_RESPONSE',
  'UNEXPECTED_TOOL_CALL',
])

/** A failed attempt whose visible output can still be replaced. */
export class ResendableInvalidOutput extends EngineRefusalError {
  constructor(finishReason: string) {
    super('stopped_by_google', { finishReason })
  }
}

export interface StreamRefusalOptions {
  log(diagnostic: string): void
  transformLine?(line: string): string
  onUsage?(usage: Record<string, unknown>): void
  allowEmpty?: boolean
}

/** Forward live content, then settle the first terminal after collecting trailing usage. */
export function enforceStreamRefusals(
  source: ReadableStream<Uint8Array>,
  { log, transformLine, onUsage, allowEmpty }: StreamRefusalOptions,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const usage: Record<string, unknown> = {}
  let buffer = ''
  let visible = false
  let closed = false
  let failure: EngineRefusalError | undefined
  let terminalLine: string | undefined
  let drain: Promise<typeof drainExpired> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const startDrain = () => {
    drain = new Promise((resolve) => {
      timer = setTimeout(() => resolve(drainExpired), USAGE_DRAIN_MS)
    })
  }

  const inspect = (line: string): string | undefined => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload) return
    if (payload === '[DONE]') {
      if (!drain) {
        failure = new EngineRefusalError(visible ? 'incomplete' : 'empty')
        startDrain()
      }
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
    const metadata = frame.usageMetadata
    if (metadata && typeof metadata === 'object') {
      Object.assign(usage, metadata)
      delete frame.usageMetadata
    }
    const candidate = primaryCandidate<any>(frame.candidates)
    const reason = candidate?.finishReason
    const blocked = frame.promptFeedback?.blockReason
    const embedded = envelope.error !== undefined || frame.error !== undefined
    if (drain) {
      if (embedded || blocked || reason)
        log(`Ignoring later Antigravity terminal frame: ${payload}`)
      return
    }
    if (embedded || blocked) {
      log(
        `Antigravity ${embedded ? 'embedded error' : 'prompt blocked'}: ${payload}`,
      )
      failure = embedded
        ? new EngineRefusalError('embedded_error')
        : new EngineRefusalError('stopped_by_google', { finishReason: blocked })
      startDrain()
      return
    }
    if (Array.isArray(frame.candidates)) {
      if (!candidate) delete frame.candidates
      else frame.candidates = [candidate]
    }
    if (Array.isArray(candidate?.content?.parts))
      visible ||= candidate.content.parts.some(
        (part: any) =>
          part?.functionCall ||
          (!part?.thought &&
            typeof part?.text === 'string' &&
            part.text.length > 0),
      )
    if (typeof reason === 'string' && reason) {
      startDrain()
      if (reason !== 'STOP' && reason !== 'MAX_TOKENS') {
        log(`Antigravity finish reason: ${JSON.stringify(reason)}`)
        failure =
          !visible && invalidOutputCodes.has(reason)
            ? new ResendableInvalidOutput(reason)
            : new EngineRefusalError('stopped_by_google', {
                finishReason: reason,
              })
        delete candidate.finishReason
      } else if (reason === 'STOP' && !visible && !allowEmpty) {
        failure = new EngineRefusalError('empty')
        delete candidate.finishReason
      } else {
        terminalLine = `data: ${JSON.stringify(envelope)}`
        return
      }
    }
    if (
      !Object.keys(frame).length ||
      (failure && !candidate?.content?.parts?.length)
    )
      return
    return `data: ${JSON.stringify(envelope)}`
  }

  const close = async (error?: unknown) => {
    if (closed) return
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    try {
      await reader.cancel(error).catch(() => {})
    } finally {
      reader.releaseLock()
    }
  }
  const encode = (line: string) =>
    encoder.encode(`${transformLine?.(line) ?? line}\n\n`)
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!closed) {
          const newline = buffer.indexOf('\n')
          if (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            const content = inspect(line)
            if (content) {
              controller.enqueue(encode(content))
              return
            }
          } else {
            const pending = reader.read()
            const next = drain
              ? await Promise.race([pending, drain])
              : await pending
            if (closed) return
            if (next === drainExpired) break
            if (next.done) {
              buffer += decoder.decode()
              if (buffer) {
                buffer += '\n'
                continue
              }
              break
            }
            buffer += decoder.decode(next.value, { stream: true })
          }
        }
      } catch (error) {
        if (closed) return
        log(`Antigravity body read failed: ${String(error)}`)
        if (!drain)
          failure = new EngineRefusalError(
            error instanceof AgyResponseIdleTimeoutError
              ? 'deadline'
              : 'transport_error',
          )
      }
      if (closed) return
      if (!terminalLine)
        failure ??= new EngineRefusalError(visible ? 'incomplete' : 'empty')
      await close(failure)
      if (failure) {
        controller.error(failure)
        return
      }
      const payload = JSON.parse(terminalLine!.slice(5))
      const frame = payload.response ?? payload
      if (Object.keys(usage).length) {
        frame.usageMetadata = usage
        onUsage?.(usage)
      } else {
        frame.usageMetadata = {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        }
      }
      controller.enqueue(encode(`data: ${JSON.stringify(payload)}`))
      controller.close()
    },
    cancel: close,
  })
}
