import { processImageData } from '../../image-saver'
import type {
  SignatureStore,
  StreamingCallbacks,
  StreamingOptions,
  StreamingUsageMetadata,
  ThoughtBuffer,
} from './types'

/**
 * Simple string hash for thinking deduplication.
 * Uses DJB2-like algorithm.
 */
function hashString(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i) /* hash * 33 + c */
  }
  return (hash >>> 0).toString(16)
}

export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>()
  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => buffer.set(index, text),
    clear: () => buffer.clear(),
  }
}

export function transformStreamingPayload(
  payload: string,
  transformThinkingParts?: (response: unknown) => unknown,
): string {
  return payload
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) {
        return line
      }
      const json = line.slice(5).trim()
      if (!json) {
        return line
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown }
        if (parsed.response !== undefined) {
          const transformed = transformThinkingParts
            ? transformThinkingParts(parsed.response)
            : parsed.response
          return `data: ${JSON.stringify(transformed)}`
        }
      } catch (_) {
        console.warn(
          '[antigravity] Malformed SSE chunk, passing through untransformed:',
          json.slice(0, 200),
        )
      }
      return line
    })
    .join('\n')
}
export function deduplicateThinkingText(
  response: unknown,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): unknown {
  if (!response || typeof response !== 'object') return response

  const resp = response as Record<string, unknown>

  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map(
      (candidate: unknown, index: number) => {
        const cand = candidate as Record<string, unknown> | null
        if (!cand?.content) return candidate

        const content = cand.content as Record<string, unknown>
        if (!Array.isArray(content.parts)) return candidate

        const newParts = content.parts.flatMap((part: unknown) => {
          const p = part as Record<string, unknown>

          // Handle image data - save to disk and return file path
          if (p.inlineData) {
            const inlineData = p.inlineData as Record<string, unknown>
            const result = processImageData({
              mimeType: inlineData.mimeType as string | undefined,
              data: inlineData.data as string | undefined,
            })
            if (result) {
              return { text: result }
            }
          }

          if (p.thought === true || p.type === 'thinking') {
            const fullText =
              typeof p.text === 'string'
                ? p.text
                : typeof p.thinking === 'string'
                  ? p.thinking
                  : ''

            if (displayedThinkingHashes) {
              const hash = hashString(fullText)
              if (displayedThinkingHashes.has(hash)) {
                sentBuffer.set(index, fullText)
                return []
              }
              displayedThinkingHashes.add(hash)
            }

            const sentText = sentBuffer.get(index) ?? ''

            if (fullText.startsWith(sentText)) {
              const delta = fullText.slice(sentText.length)
              sentBuffer.set(index, fullText)

              if (delta) {
                // Clean object — NO spread to prevent thinking: <object> leaking
                return { thought: true, text: delta }
              }
              return []
            }

            sentBuffer.set(index, fullText)
            return part
          }
          return [part]
        })

        return {
          ...cand,
          content: { ...content, parts: newParts },
        }
      },
    )

    return { ...resp, candidates: newCandidates }
  }

  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0
    const newContent = resp.content.flatMap((block: unknown) => {
      const b = block as Record<string, unknown> | null
      if (b?.type === 'thinking') {
        const fullText =
          typeof b.thinking === 'string'
            ? b.thinking
            : typeof b.text === 'string'
              ? b.text
              : ''

        if (displayedThinkingHashes) {
          const hash = hashString(fullText)
          if (displayedThinkingHashes.has(hash)) {
            sentBuffer.set(thinkingIndex, fullText)
            thinkingIndex++
            return []
          }
          displayedThinkingHashes.add(hash)
        }

        const sentText = sentBuffer.get(thinkingIndex) ?? ''

        if (fullText.startsWith(sentText)) {
          const delta = fullText.slice(sentText.length)
          sentBuffer.set(thinkingIndex, fullText)
          thinkingIndex++

          if (delta) {
            // Clean object — NO spread to prevent thinking: <object> leaking
            return { type: b.type, thinking: delta, text: delta }
          }
          return []
        }

        sentBuffer.set(thinkingIndex, fullText)
        thinkingIndex++
        return block
      }
      return [block]
    })

    return { ...resp, content: newContent }
  }

  return response
}

type TransformSseLineResult = {
  line: string
  hasToolCall: boolean
  hasFinishReason: boolean
}

type PendingUsageLine = {
  line: string
  suffix: string
}

function extractUsageMetadataFromDataLine(
  line: string,
): Record<string, unknown> | undefined {
  if (!line.startsWith('data:')) return undefined
  const json = line.slice(5).trim()
  if (!json || json === '[DONE]') return undefined

  try {
    const parsed = JSON.parse(json) as unknown
    const response =
      parsed && typeof parsed === 'object' && 'response' in parsed
        ? (parsed as { response?: unknown }).response
        : parsed
    if (!response || typeof response !== 'object') return undefined
    const usage = (response as { usageMetadata?: unknown }).usageMetadata
    return usage && typeof usage === 'object'
      ? (usage as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function usageMetadataHasCacheRead(
  usageMetadata: Record<string, unknown> | undefined,
): boolean {
  return typeof usageMetadata?.cachedContentTokenCount === 'number'
}

function completeSseEventSuffix(suffix: string): string {
  if (suffix.includes('\n\n')) return suffix
  if (suffix.endsWith('\n')) return suffix + '\n'
  return suffix + '\n\n'
}

function mergeUsageMetadataIntoDataLine(
  line: string,
  usageMetadata: Record<string, unknown> | undefined,
): string {
  if (!usageMetadata || !line.startsWith('data:')) return line
  const json = line.slice(5).trim()
  if (!json || json === '[DONE]') return line

  try {
    const parsed = JSON.parse(json) as unknown
    const hasResponseWrapper =
      !!parsed && typeof parsed === 'object' && 'response' in parsed
    const response = hasResponseWrapper
      ? (parsed as { response?: unknown }).response
      : parsed
    if (!response || typeof response !== 'object') return line

    const mutableResponse = response as Record<string, unknown>
    const existing =
      mutableResponse.usageMetadata &&
      typeof mutableResponse.usageMetadata === 'object'
        ? (mutableResponse.usageMetadata as Record<string, unknown>)
        : {}
    mutableResponse.usageMetadata = { ...existing, ...usageMetadata }

    return `data: ${JSON.stringify(parsed)}`
  } catch {
    return line
  }
}

function responseHasToolCall(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const resp = response as Record<string, unknown>

  if (Array.isArray(resp.candidates)) {
    return resp.candidates.some((candidate) => {
      const cand = candidate as Record<string, unknown> | null
      const content = cand?.content as Record<string, unknown> | undefined
      const parts = content?.parts
      return (
        Array.isArray(parts) &&
        parts.some((part) => {
          const p = part as Record<string, unknown> | null
          return Boolean(p?.functionCall) || p?.type === 'tool_use'
        })
      )
    })
  }

  if (Array.isArray(resp.content)) {
    return resp.content.some((block) => {
      const b = block as Record<string, unknown> | null
      return Boolean(b?.functionCall) || b?.type === 'tool_use'
    })
  }

  return false
}

function responseHasFinishReason(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const resp = response as Record<string, unknown>

  if (Array.isArray(resp.candidates)) {
    return resp.candidates.some((candidate) => {
      const cand = candidate as Record<string, unknown> | null
      return (
        typeof cand?.finishReason === 'string' && cand.finishReason.length > 0
      )
    })
  }

  const stopReason = resp.stopReason ?? resp.stop_reason
  return typeof stopReason === 'string' && stopReason.length > 0
}

function transformSseLineWithMetadata(
  line: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
  usageState?: { lastUsage: StreamingUsageMetadata | null },
): TransformSseLineResult {
  if (!line.startsWith('data:')) {
    return { line, hasToolCall: false, hasFinishReason: false }
  }
  const json = line.slice(5).trim()
  if (!json) {
    return { line, hasToolCall: false, hasFinishReason: false }
  }

  try {
    const parsed = JSON.parse(json) as { response?: unknown }
    if (parsed.response !== undefined) {
      const hasToolCall = responseHasToolCall(parsed.response)
      const hasFinishReason = responseHasFinishReason(parsed.response)

      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature,
        )
      }

      // Extract usage metadata from streaming chunks
      if (usageState) {
        const resp = parsed.response as Record<string, unknown>
        const meta = resp.usageMetadata as Record<string, unknown> | undefined
        if (meta && typeof meta === 'object') {
          usageState.lastUsage = {
            cachedContentTokenCount:
              typeof meta.cachedContentTokenCount === 'number'
                ? meta.cachedContentTokenCount
                : 0,
            promptTokenCount:
              typeof meta.promptTokenCount === 'number'
                ? meta.promptTokenCount
                : 0,
            candidatesTokenCount:
              typeof meta.candidatesTokenCount === 'number'
                ? meta.candidatesTokenCount
                : 0,
            totalTokenCount:
              typeof meta.totalTokenCount === 'number'
                ? meta.totalTokenCount
                : 0,
          }
        }
      }

      let response: unknown = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes,
      )

      if (
        options.debugText &&
        callbacks.onInjectDebug &&
        !debugState.injected
      ) {
        response = callbacks.onInjectDebug(response, options.debugText)
        debugState.injected = true
      }
      // Note: onInjectSyntheticThinking removed - keep_thinking now uses debugText path

      const transformed = callbacks.transformThinkingParts
        ? callbacks.transformThinkingParts(response)
        : response
      return {
        line: `data: ${JSON.stringify(transformed)}`,
        hasToolCall,
        hasFinishReason,
      }
    }
  } catch (_) {
    console.warn(
      '[antigravity] Malformed SSE chunk in streaming transform, passing through untransformed:',
      json.slice(0, 200),
    )
  }
  return { line, hasToolCall: false, hasFinishReason: false }
}

export function transformSseLine(
  line: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
  usageState?: { lastUsage: StreamingUsageMetadata | null },
): string {
  return transformSseLineWithMetadata(
    line,
    signatureStore,
    thoughtBuffer,
    sentThinkingBuffer,
    callbacks,
    options,
    debugState,
    usageState,
  ).line
}

export function cacheThinkingSignaturesFromResponse(
  response: unknown,
  signatureSessionKey: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  onCacheSignature?: (
    sessionKey: string,
    text: string,
    signature: string,
  ) => void,
): void {
  if (!response || typeof response !== 'object') return

  const resp = response as Record<string, unknown>

  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null
      if (!cand?.content) return
      const content = cand.content as Record<string, unknown>
      if (!Array.isArray(content.parts)) return

      content.parts.forEach((part: unknown) => {
        const p = part as Record<string, unknown>
        if (p.thought === true || p.type === 'thinking') {
          const text =
            typeof p.text === 'string'
              ? p.text
              : typeof p.thinking === 'string'
                ? p.thinking
                : ''
          if (text) {
            const current = thoughtBuffer.get(index) ?? ''
            thoughtBuffer.set(index, current + text)
          }
        }
        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? ''
          if (fullText) {
            const signature = p.thoughtSignature as string
            onCacheSignature?.(signatureSessionKey, fullText, signature)
            signatureStore.set(signatureSessionKey, {
              text: fullText,
              signature,
            })
          }
        }
      })
    })
  }

  if (Array.isArray(resp.content)) {
    // Use thoughtBuffer to accumulate thinking text across SSE events
    // Claude streams thinking content and signature in separate events
    const CLAUDE_BUFFER_KEY = 0 // Use index 0 for Claude's single-stream content
    resp.content.forEach((block: unknown) => {
      const b = block as Record<string, unknown> | null
      if (b?.type === 'thinking') {
        const text =
          typeof b.thinking === 'string'
            ? b.thinking
            : typeof b.text === 'string'
              ? b.text
              : ''
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? ''
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text)
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? ''
        if (fullText) {
          const signature = b.signature as string
          onCacheSignature?.(signatureSessionKey, fullText, signature)
          signatureStore.set(signatureSessionKey, { text: fullText, signature })
        }
      }
    })
  }
}

export function createStreamingTransformer(
  signatureStore: SignatureStore,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const thoughtBuffer = createThoughtBuffer()
  const sentThinkingBuffer = createThoughtBuffer()
  const debugState = { injected: false }
  let hasSeenUsageMetadata = false
  let terminatedAfterFinishReason = false
  const pendingUsageLines: PendingUsageLine[] = []
  const usageState: { lastUsage: StreamingUsageMetadata | null } = {
    lastUsage: null,
  }

  const emitSyntheticUsageIfMissing = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (hasSeenUsageMetadata) return
    const syntheticUsage = {
      response: {
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      },
    }
    controller.enqueue(
      encoder.encode(`\ndata: ${JSON.stringify(syntheticUsage)}\n\n`),
    )
    hasSeenUsageMetadata = true
  }

  const emitUsageCallback = () => {
    if (usageState.lastUsage && callbacks.onUsageMetadata) {
      callbacks.onUsageMetadata(usageState.lastUsage)
    }
  }

  const emitPendingUsageLines = (
    controller: TransformStreamDefaultController<Uint8Array>,
    finalUsage?: Record<string, unknown>,
  ) => {
    while (pendingUsageLines.length > 0) {
      const pending = pendingUsageLines.shift()
      if (!pending) continue
      const line = mergeUsageMetadataIntoDataLine(pending.line, finalUsage)
      controller.enqueue(encoder.encode(line + pending.suffix))
    }
  }

  const processLine = (
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>,
    suffix: string,
  ): boolean => {
    if (pendingUsageLines.length > 0 && line.trim() === '') {
      const lastPending = pendingUsageLines[pendingUsageLines.length - 1]
      if (lastPending) lastPending.suffix += suffix
      return false
    }

    if (line.includes('usageMetadata')) {
      hasSeenUsageMetadata = true
    }

    const result = transformSseLineWithMetadata(
      line,
      signatureStore,
      thoughtBuffer,
      sentThinkingBuffer,
      callbacks,
      options,
      debugState,
      usageState,
    )

    if (!result.hasFinishReason && pendingUsageLines.length > 0) {
      emitPendingUsageLines(controller)
    }

    const lineUsage = extractUsageMetadataFromDataLine(result.line)
    if (
      !result.hasFinishReason &&
      lineUsage &&
      !usageMetadataHasCacheRead(lineUsage)
    ) {
      // Gemini often reports partial usage on the content/functionCall event,
      // then reports cachedContentTokenCount only on the terminal STOP event.
      // Some OpenCode/AI SDK paths attach step usage from the latest content
      // event they saw before halt, so keep a one-line delay and merge the
      // terminal cache usage when it arrives.
      pendingUsageLines.push({ line: result.line, suffix })
      return false
    }

    if (result.hasFinishReason) {
      const finalUsage = lineUsage
      emitPendingUsageLines(controller, finalUsage)
      controller.enqueue(
        encoder.encode(result.line + completeSseEventSuffix(suffix)),
      )
      // Antigravity can leave the HTTP response open after a terminal candidate event.
      // Forward a complete SSE frame before closing; downstream parsers only dispatch
      // the terminal STOP event after the blank event separator is seen.
      // OpenCode only records step-finish and exits/continues after the provider stream closes,
      // so terminate once the finished event has been forwarded.
      emitSyntheticUsageIfMissing(controller)
      emitUsageCallback()
      terminatedAfterFinishReason = true
      controller.terminate()
      return true
    }

    emitPendingUsageLines(controller)
    controller.enqueue(encoder.encode(result.line + suffix))
    return false
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (terminatedAfterFinishReason) return
      buffer += decoder.decode(chunk, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (processLine(line, controller, '\n')) {
          return
        }
      }
    },
    flush(controller) {
      if (terminatedAfterFinishReason) return
      buffer += decoder.decode()

      if (buffer && processLine(buffer, controller, '')) {
        return
      }

      emitPendingUsageLines(controller)
      // Inject synthetic usage metadata if missing (fixes "Context % used: 0%" issue)
      emitSyntheticUsageIfMissing(controller)
      emitUsageCallback()
    },
  })
}
