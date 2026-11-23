import { EngineRefusalError, responseRefusal } from '../refusals.ts'
import { getResponseCleanup } from '../request-cancellation.ts'

export interface RequestUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoningTokens: number
  totalTokens: number
}

type UsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export interface GeminiResponsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string }
}

interface Frame {
  responseId?: string
  candidates?: Array<{
    content?: { parts?: GeminiResponsePart[] }
    finishReason?: string
  }>
  usageMetadata?: UsageMetadata
  error?:
    | {
        status?: string
        code?: number | string
        details?: unknown
        message?: string
      }
    | string
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string }
}

export type RequestTerminal = 'stop' | 'length' | 'toolUse'
export type RequestEvent =
  | { type: 'text' | 'thinking'; delta: string; signature?: string }
  | {
      type: 'toolCall'
      id: string
      name: string
      arguments: Record<string, unknown>
      signature?: string
    }
  | { type: 'usage'; usage: RequestUsage }
  | { type: 'metadata'; responseId?: string; rawStopReason?: string }
  | { type: 'terminal'; reason: RequestTerminal }
  | { type: 'failure'; error: EngineRefusalError }

function decodeFrame(line: string): Frame | undefined {
  if (!line.startsWith('data:')) return
  try {
    const raw = JSON.parse(line.slice(5))
    if (!raw || typeof raw !== 'object') return
    if (raw.response && typeof raw.response === 'object') {
      const responseId = raw.response.responseId ?? raw.responseId
      return { ...raw.response, ...(responseId && { responseId }) }
    }
    return raw
  } catch {
    // The response transform preserves malformed lines for diagnostics.
    return undefined
  }
}

/** Decode the transformed response, not the raw upstream response. */
export async function* parseGeminiSse(
  response: Response,
): AsyncGenerator<Frame> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  function* decodeEvent(event: string) {
    for (const line of event.split('\n')) {
      const frame = decodeFrame(line)
      if (frame) yield frame
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        yield* decodeEvent(buffer + decoder.decode())
        break
      }
      const text = decoder.decode(value, { stream: true })
      if (text.startsWith('\n') && buffer.endsWith('\r'))
        buffer = buffer.slice(0, -1)
      buffer += text.replace(/\r\n/g, '\n')
      for (
        let boundary = buffer.indexOf('\n\n');
        boundary >= 0;
        boundary = buffer.indexOf('\n\n')
      ) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        yield* decodeEvent(event)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function mapRequestUsage(metadata: UsageMetadata): RequestUsage {
  const cacheRead = metadata.cachedContentTokenCount ?? 0
  const input = Math.max(0, (metadata.promptTokenCount ?? 0) - cacheRead)
  const reasoningTokens = metadata.thoughtsTokenCount ?? 0
  const output = (metadata.candidatesTokenCount ?? 0) + reasoningTokens
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoningTokens,
    totalTokens: metadata.totalTokenCount ?? input + cacheRead + output,
  }
}

export interface GeminiToolCallState {
  pendingThoughtSignature?: string
}

export function convertGeminiToolCallPart(
  part: GeminiResponsePart,
  state: GeminiToolCallState,
) {
  if (part.thought && !part.text && part.thoughtSignature)
    state.pendingThoughtSignature = part.thoughtSignature
  if (!part.functionCall) return undefined
  const signature = part.thoughtSignature ?? state.pendingThoughtSignature
  state.pendingThoughtSignature = undefined
  return {
    type: 'toolCall' as const,
    id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
    name: part.functionCall.name ?? '',
    arguments: part.functionCall.args ?? {},
    ...(signature && { thoughtSignature: signature }),
  }
}

/** Read typed events from the same transformed response used by the HTTP adapter. */
export async function* readRequestEvents(
  response: Response,
): AsyncGenerator<RequestEvent> {
  const close = async () => {
    await response.body?.cancel().catch(() => {})
    await getResponseCleanup(response)
  }
  try {
    if (!response.ok) {
      throw responseRefusal(response) ?? new EngineRefusalError('upstream_http')
    }
    const toolState: GeminiToolCallState = {}
    let lastBlock: 'text' | 'thinking' | 'toolCall' | undefined
    let usedTool = false
    let finish: string | undefined
    let usage: RequestUsage | undefined
    for await (const frame of parseGeminiSse(response)) {
      if (frame.responseId)
        yield { type: 'metadata', responseId: frame.responseId }
      if (frame.usageMetadata) usage = mapRequestUsage(frame.usageMetadata)
      if (frame.error !== undefined)
        throw new EngineRefusalError('embedded_error')
      if (frame.promptFeedback?.blockReason)
        throw new EngineRefusalError('stopped_by_google', {
          finishReason: frame.promptFeedback.blockReason,
        })
      const candidate = frame.candidates?.[0]
      if (finish) continue
      for (const part of candidate?.content?.parts ?? []) {
        const call = convertGeminiToolCallPart(part, toolState)
        if (call) {
          usedTool = true
          lastBlock = 'toolCall'
          yield {
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            signature: call.thoughtSignature,
          }
        } else if (part.thought) {
          if (part.text) {
            lastBlock = 'thinking'
            yield {
              type: 'thinking',
              delta: part.text ?? '',
              signature: part.thoughtSignature,
            }
          }
        } else if (
          part.text ||
          (lastBlock === 'text' && part.thoughtSignature)
        ) {
          lastBlock = 'text'
          const signature =
            part.thoughtSignature ?? toolState.pendingThoughtSignature
          toolState.pendingThoughtSignature = undefined
          yield { type: 'text', delta: part.text ?? '', signature }
        } else if (part.thoughtSignature) {
          toolState.pendingThoughtSignature = part.thoughtSignature
        }
      }
      finish = candidate?.finishReason
    }
    if (usage) yield { type: 'usage', usage }
    if (!finish)
      throw new EngineRefusalError(lastBlock ? 'incomplete' : 'empty')
    if (finish !== 'STOP' && finish !== 'MAX_TOKENS')
      throw new EngineRefusalError('stopped_by_google', {
        finishReason: finish,
      })
    yield { type: 'metadata', rawStopReason: finish }
    await close()
    yield {
      type: 'terminal',
      reason: finish === 'STOP' ? (usedTool ? 'toolUse' : 'stop') : 'length',
    }
  } catch (error) {
    await close()
    yield {
      type: 'failure',
      error:
        error instanceof EngineRefusalError
          ? error
          : new EngineRefusalError('transport_error'),
    }
  } finally {
    await close()
  }
}
