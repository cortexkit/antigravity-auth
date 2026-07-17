import {
  ANTIGRAVITY_ENDPOINT,
  AgyRequestSessionStore,
  buildAgyAgentRequestMetadata,
  buildAntigravityHarnessUserAgent,
  ensureProjectContext,
  fetchWithAgyCliTransport,
  orderAgyRequestPayloadInPlace,
  resolveModelForHeaderStyle,
  type AgyRequestScope,
} from "@cortexkit/antigravity-auth-core"
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ToolCall,
} from "@earendil-works/pi-ai"

import { buildGeminiRequest } from "./convert.ts"
import { getPackedRefresh } from "./credential-cache.ts"

const STREAM_ACTION = "streamGenerateContent"
const FALLBACK_SESSION_KEY = "__default__"
const requestSessions = new AgyRequestSessionStore("")

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "STOP":
      return "stop"
    case "MAX_TOKENS":
      return "length"
    default:
      return reason ? "stop" : "stop"
  }
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiResponsePart[] }
    finishReason?: string
  }>
  usageMetadata?: GeminiUsageMetadata
}

/**
 * Antigravity wraps each streamGenerateContent SSE chunk under a `response`
 * key: `data: {"response": {"candidates": [...], "usageMetadata": {...}}}`.
 * Unwrap it so downstream sees the plain Gemini chunk. MITM-verified against
 * agy 1.0.4 on 2026-06-13.
 */
function unwrapChunk(raw: unknown): GeminiStreamChunk {
  if (raw && typeof raw === "object" && "response" in raw) {
    const inner = (raw as { response?: unknown }).response
    if (inner && typeof inner === "object") {
      return inner as GeminiStreamChunk
    }
  }
  return raw as GeminiStreamChunk
}

interface GeminiResponsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
}

export function updateUsage(model: Model<Api>, output: AssistantMessage, usage?: GeminiUsageMetadata): void {
  if (!usage) return
  const cacheRead = usage.cachedContentTokenCount ?? output.usage.cacheRead
  // Antigravity reports promptTokenCount as the full (uncached + cached) prompt.
  const promptTotal = usage.promptTokenCount ?? output.usage.input + output.usage.cacheRead
  output.usage.input = Math.max(0, promptTotal - cacheRead)
  // candidatesTokenCount excludes thinking; thoughtsTokenCount is billed as
  // output too. totalTokenCount = prompt + candidates + thoughts (MITM-verified).
  if (usage.candidatesTokenCount !== undefined || usage.thoughtsTokenCount !== undefined) {
    output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
  }
  output.usage.cacheRead = cacheRead
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite
  calculateCost(model, output.usage)
}

export async function* parseGeminiSse(response: Response): AsyncGenerator<GeminiStreamChunk> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const parseFrame = function* (frame: string): Generator<GeminiStreamChunk> {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue
      try {
        yield unwrapChunk(JSON.parse(data))
      } catch {
        // Ignore malformed SSE frames.
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Antigravity uses CRLF line endings (`\r\n\r\n` frame separators);
      // normalize so a single boundary check works for both LF and CRLF.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")
        yield* parseFrame(frame)
      }
    }
    // Flush any trailing frame that did not end with a blank-line separator.
    if (buffer.trim()) {
      yield* parseFrame(buffer)
    }
  } finally {
    reader.releaseLock()
  }
}

function getRequestSessionKey(context: Context, options?: SimpleStreamOptions): string {
  if (options?.sessionId) {
    return options.sessionId
  }
  const firstTimestamp = context.messages[0]?.timestamp
  return firstTimestamp !== undefined ? `message:${firstTimestamp}` : FALLBACK_SESSION_KEY
}

export function finalizePiAntigravityRequest(
  request: Record<string, unknown>,
  wireModel: string,
  scope: AgyRequestScope,
): string {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } }
  }

  const metadata = buildAgyAgentRequestMetadata(
    scope.session,
    request,
    wireModel,
    scope.timestamp,
  )
  request.labels = metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)
  return metadata.requestId
}

async function sendAntigravityRequest(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  accessToken: string
}): Promise<Response> {
  const resolved = resolveModelForHeaderStyle(options.model.id, "antigravity")
  const wireModel = resolved.actualModel

  // Recover the packed refresh (refreshToken|projectId|managedProjectId) that
  // login/refresh resolved; pi only hands the stream the bare access token.
  // With it, ensureProjectContext returns the cached managedProjectId directly
  // instead of re-running loadCodeAssist every turn.
  const packedRefresh = getPackedRefresh(options.accessToken) ?? ""
  const projectContext = await ensureProjectContext({
    type: "oauth",
    refresh: packedRefresh,
    access: options.accessToken,
    expires: Date.now() + 60_000,
  })

  const request = buildGeminiRequest(options.context) as unknown as Record<string, unknown>
  const generationConfig: Record<string, unknown> = {}

  if (resolved.thinkingLevel) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: resolved.thinkingLevel,
    }
  } else if (typeof resolved.thinkingBudget === "number") {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: resolved.thinkingBudget,
    }
  }

  const maxTokens = options.streamOptions?.maxTokens ?? options.model.maxTokens
  if (typeof maxTokens === "number") {
    generationConfig.maxOutputTokens = maxTokens
  }

  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig
  }

  const requestScope = requestSessions.beginRequest(
    getRequestSessionKey(options.context, options.streamOptions),
  )
  const requestId = finalizePiAntigravityRequest(request, wireModel, requestScope)

  const envelope = {
    project: projectContext.effectiveProjectId,
    requestId,
    request,
    model: wireModel,
    userAgent: "antigravity",
    requestType: "agent",
  }

  const url = `${ANTIGRAVITY_ENDPOINT}/v1internal:${STREAM_ACTION}?alt=sse`

  return fetchWithAgyCliTransport(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": buildAntigravityHarnessUserAgent(),
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify(envelope),
    },
    { signal: options.streamOptions?.signal ?? null },
  )
}

export function streamCortexKitAntigravity(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createOutput(model)
    stream.push({ type: "start", partial: output })

    try {
      const accessToken = options?.apiKey ?? ""
      if (!accessToken) throw new Error("Missing Antigravity OAuth access token")

      const response = await sendAntigravityRequest({
        model,
        context,
        streamOptions: options,
        accessToken,
      })

      if (!response.ok) {
        throw new Error(`Antigravity request failed: HTTP ${response.status} ${await response.text()}`)
      }

      const content = output.content as Array<TextContent | ToolCall>
      let textIndex = -1
      let finished = false

      for await (const chunk of parseGeminiSse(response)) {
        updateUsage(model, output, chunk.usageMetadata)

        const candidate = chunk.candidates?.[0]
        const parts = candidate?.content?.parts ?? []

        for (const part of parts) {
          if (part.functionCall) {
            const toolCall: ToolCall = {
              type: "toolCall",
              id: `call_${crypto.randomUUID()}`,
              name: part.functionCall.name ?? "",
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            }
            content.push(toolCall)
            const idx = content.length - 1
            textIndex = -1
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: output })
            stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output })
            output.stopReason = "toolUse"
          } else if (typeof part.text === "string" && part.text.length > 0 && !part.thought) {
            if (textIndex === -1) {
              content.push({ type: "text", text: "" })
              textIndex = content.length - 1
              stream.push({ type: "text_start", contentIndex: textIndex, partial: output })
            }
            const block = content[textIndex]
            if (block && block.type === "text") {
              block.text += part.text
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: part.text,
                partial: output,
              })
            }
          }
        }

        if (candidate?.finishReason) {
          if (textIndex !== -1) {
            const block = content[textIndex]
            if (block && block.type === "text") {
              stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output })
            }
            textIndex = -1
          }
          if (output.stopReason !== "toolUse") {
            output.stopReason = mapFinishReason(candidate.finishReason)
          }
          // The AGY raw-socket transport may keep the response body open after
          // the terminal chunk, which would hang the SSE reader. Stop consuming
          // once a finishReason arrives so the turn terminates promptly.
          finished = true
          break
        }
      }

      if (finished) {
        await response.body?.cancel().catch(() => {})
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted")

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      })
      stream.end()
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error"
      output.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({ type: "error", reason: output.stopReason, error: output })
      stream.end()
    }
  })()

  return stream
}
