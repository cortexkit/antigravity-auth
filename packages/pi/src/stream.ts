import {
  type AgyRequestScope,
  AgyRequestSessionStore,
  ANTIGRAVITY_ENDPOINT,
  applyAgyNativeGenerationConfig,
  buildAgyAgentRequestMetadata,
  buildAntigravityHarnessUserAgent,
  ensureProjectContext,
  fetchWithAgyCliTransport,
  forwardAbort,
  isRetiredAgyModel,
  orderAgyRequestPayloadInPlace,
  RETIRED_AGY_MODEL_MESSAGE,
  redactCredentialError,
  redactCredentialText,
  resolveModelForHeaderStyle,
} from '@cortexkit/antigravity-auth-core'
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ThinkingLevel,
  type ToolCall,
} from '@earendil-works/pi-ai'

import { buildGeminiRequest } from './convert.ts'
import { getPackedRefresh } from './credential-cache.ts'

const STREAM_ACTION = 'streamGenerateContent'
const FALLBACK_SESSION_KEY = '__default__'
const TRAILING_USAGE_TIMEOUT_MS = 1_000
const requestSessions = new AgyRequestSessionStore('')

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<IteratorResult<T> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          onTimeout()
          resolve(undefined)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    default:
      return reason ? 'stop' : 'stop'
  }
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
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
    stopReason: 'stop',
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
  error?: unknown
  promptFeedback?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function describeEmbeddedStreamFailure(
  chunk: GeminiStreamChunk,
): string | undefined {
  if (chunk.error !== undefined) {
    const error = asRecord(chunk.error)
    if (!error) {
      const detail = typeof chunk.error === 'string' ? `: ${chunk.error}` : ''
      return `Antigravity stream error${detail}`
    }

    const labels: string[] = []
    if (typeof error.status === 'string') labels.push(error.status)
    if (typeof error.code === 'number' || typeof error.code === 'string') {
      labels.push(`code ${String(error.code)}`)
    }
    const details = Array.isArray(error.details) ? error.details : []
    const reason = details
      .map((detail) => asRecord(detail)?.reason)
      .find((value): value is string => typeof value === 'string')
    if (reason && !labels.includes(reason)) labels.push(reason)

    const label = labels.length > 0 ? ` (${labels.join(', ')})` : ''
    const message =
      typeof error.message === 'string' && error.message.length > 0
        ? `: ${error.message}`
        : ''
    return `Antigravity stream error${label}${message}`
  }

  const promptFeedback = asRecord(chunk.promptFeedback)
  if (!promptFeedback) return undefined
  const reason =
    typeof promptFeedback.blockReason === 'string'
      ? promptFeedback.blockReason
      : undefined
  const message =
    typeof promptFeedback.blockReasonMessage === 'string'
      ? promptFeedback.blockReasonMessage
      : undefined
  if (!reason && !message) return undefined

  return `Antigravity prompt blocked${reason ? ` (${reason})` : ''}${message ? `: ${message}` : ''}`
}

/**
 * Antigravity wraps each streamGenerateContent SSE chunk under a `response`
 * key: `data: {"response": {"candidates": [...], "usageMetadata": {...}}}`.
 * Unwrap it so downstream sees the plain Gemini chunk. MITM-verified against
 * agy 1.0.4 on 2026-06-13.
 */
function unwrapChunk(raw: unknown): GeminiStreamChunk {
  if (raw && typeof raw === 'object' && 'response' in raw) {
    const inner = (raw as { response?: unknown }).response
    if (inner && typeof inner === 'object') {
      return inner as GeminiStreamChunk
    }
  }
  return raw as GeminiStreamChunk
}

export interface GeminiResponsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name?: string; args?: JsonObject; id?: string }
}

export interface GeminiToolCallState {
  pendingThoughtSignature?: string
}

export function convertGeminiToolCallPart(
  part: GeminiResponsePart,
  state: GeminiToolCallState,
): ToolCall | undefined {
  // Antigravity emits a batch signature on a preceding empty thought part;
  // native replay attaches it to the first function call in that batch.
  if (part.thought && !part.text && part.thoughtSignature) {
    state.pendingThoughtSignature = part.thoughtSignature
  }

  if (!part.functionCall) return undefined

  const thoughtSignature =
    part.thoughtSignature ?? state.pendingThoughtSignature
  state.pendingThoughtSignature = undefined

  return {
    type: 'toolCall',
    id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
    name: part.functionCall.name ?? '',
    arguments: part.functionCall.args ?? {},
    ...(thoughtSignature ? { thoughtSignature } : {}),
  }
}

export function updateUsage(
  model: Model<Api>,
  output: AssistantMessage,
  usage?: GeminiUsageMetadata,
): void {
  if (!usage) return
  const cacheRead = usage.cachedContentTokenCount ?? output.usage.cacheRead
  // Antigravity reports promptTokenCount as the full (uncached + cached) prompt.
  const promptTotal =
    usage.promptTokenCount ?? output.usage.input + output.usage.cacheRead
  output.usage.input = Math.max(0, promptTotal - cacheRead)
  // candidatesTokenCount excludes thinking; thoughtsTokenCount is billed as
  // output too. totalTokenCount = prompt + candidates + thoughts.
  if (
    usage.candidatesTokenCount !== undefined ||
    usage.thoughtsTokenCount !== undefined
  ) {
    output.usage.output =
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
  }
  output.usage.cacheRead = cacheRead
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite
  calculateCost(model, output.usage)
}

export async function* parseGeminiSse(
  response: Response,
): AsyncGenerator<GeminiStreamChunk> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const parseFrame = function* (frame: string): Generator<GeminiStreamChunk> {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
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
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
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

function getRequestSessionKey(
  context: Context,
  options?: SimpleStreamOptions,
): string {
  if (options?.sessionId) {
    return options.sessionId
  }
  // Pi 0.86+ gives every leading system message timestamp 0. A session key
  // based on that value would make unrelated conversations share one request-
  // metadata entry. Use the first non-system message's timestamp instead.
  const firstTimestamp = context.messages.find(
    (message) => message.role !== 'system',
  )?.timestamp
  return firstTimestamp !== undefined
    ? `message:${firstTimestamp}`
    : FALLBACK_SESSION_KEY
}

export function finalizePiAntigravityRequest(
  request: Record<string, unknown>,
  wireModel: string,
  scope: AgyRequestScope,
): string {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }
  }

  const metadata = buildAgyAgentRequestMetadata(
    scope.session,
    request,
    wireModel,
    scope.timestamp,
    { stepCountMode: 'cli' },
  )
  request.labels = metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)
  return metadata.requestId
}

export function resolvePiAntigravityModel(
  model: Model<Api>,
  reasoning?: ThinkingLevel,
) {
  const lower = model.id.toLowerCase()
  const supportsAgyTiers =
    model.reasoning &&
    (lower.includes('gemini-3') ||
      (lower.includes('claude') &&
        (lower.includes('thinking') || /claude-(opus|sonnet)-5-5/.test(lower))))

  if (!supportsAgyTiers || !reasoning) {
    return resolveModelForHeaderStyle(model.id, 'antigravity')
  }

  const tier =
    reasoning === 'minimal' ? 'low' : reasoning === 'xhigh' ? 'high' : reasoning
  const baseModel = model.id.replace(/-(minimal|low|medium|high|xhigh)$/i, '')
  return resolveModelForHeaderStyle(`${baseModel}-${tier}`, 'antigravity')
}

/** A request body built once per logical request, before any credential is chosen. */
interface PreparedAntigravityRequest {
  readonly wireModel: string
  readonly requestId: string
  readonly request: Record<string, unknown>
}

/**
 * The bearer and Antigravity project for one physical send. Both must come
 * from the same source: the local login, or one vault receipt.
 */
export interface AntigravitySendCredential {
  readonly accessToken: string
  readonly projectId: string
}

function prepareAntigravityRequest(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  sessionKey: string
}): PreparedAntigravityRequest {
  const resolved = resolvePiAntigravityModel(
    options.model,
    options.streamOptions?.reasoning,
  )
  const wireModel = resolved.actualModel
  if (isRetiredAgyModel(options.model.id) || isRetiredAgyModel(wireModel)) {
    throw new Error(RETIRED_AGY_MODEL_MESSAGE)
  }

  const request: Record<string, unknown> = {
    ...buildGeminiRequest(options.context, {
      provider: options.model.provider,
      model: options.model.id,
    }),
  }
  const generationConfig: Record<string, unknown> = {}

  if (resolved.thinkingLevel) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: resolved.thinkingLevel,
    }
  } else if (typeof resolved.thinkingBudget === 'number') {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: resolved.thinkingBudget,
    }
  }

  const maxTokens = options.streamOptions?.maxTokens ?? options.model.maxTokens
  if (typeof maxTokens === 'number') {
    generationConfig.maxOutputTokens = maxTokens
  }
  applyAgyNativeGenerationConfig(wireModel, generationConfig)

  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig
  }

  const requestScope = requestSessions.beginRequest(options.sessionKey)
  const requestId = finalizePiAntigravityRequest(
    request,
    wireModel,
    requestScope,
  )
  return { wireModel, requestId, request }
}

/** One physical send of a prepared request with one credential. */
function dispatchAntigravityRequest(
  prepared: PreparedAntigravityRequest,
  credential: AntigravitySendCredential,
  signal: AbortSignal | null,
): Promise<Response> {
  const envelope = {
    project: credential.projectId,
    requestId: prepared.requestId,
    request: prepared.request,
    model: prepared.wireModel,
    userAgent: 'antigravity',
    requestType: 'agent',
  }

  const url = `${ANTIGRAVITY_ENDPOINT}/v1internal:${STREAM_ACTION}?alt=sse`

  return fetchWithAgyCliTransport(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': buildAntigravityHarnessUserAgent(),
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify(envelope),
    },
    { signal },
  )
}

/** Local mode only; custody sends never reach this path. */
async function sendAntigravityRequest(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  accessToken: string
  sessionKey: string
  signal?: AbortSignal
  assertAdmission?: () => Promise<void>
}): Promise<Response> {
  if (isRetiredAgyModel(options.model.id)) {
    throw new Error(RETIRED_AGY_MODEL_MESSAGE)
  }
  // Pi passes only the access token; the packed refresh
  // `refreshToken|projectId|managedProjectId` saved at getApiKey supplies
  // the managed project without a loadCodeAssist call per turn.
  const packedRefresh = getPackedRefresh(options.accessToken) ?? ''
  const projectContext = await ensureProjectContext({
    type: 'oauth',
    refresh: packedRefresh,
    access: options.accessToken,
    expires: Date.now() + 60_000,
  })

  const prepared = prepareAntigravityRequest(options)
  await options.assertAdmission?.()
  return dispatchAntigravityRequest(
    prepared,
    {
      accessToken: options.accessToken,
      projectId: projectContext.effectiveProjectId,
    },
    options.signal ?? options.streamOptions?.signal ?? null,
  )
}

/**
 * Vault (custody) mode: sends a prepared request through the vault. `send`
 * must call `dispatch` once per physical send, each time with the token and
 * project of a fresh vault receipt, and returns the response that was
 * finally served.
 */
export type AntigravityVaultSend = (
  dispatch: (
    credential: AntigravitySendCredential,
    signal?: AbortSignal,
  ) => Promise<Response>,
  signal: AbortSignal,
) => Promise<Response>

type OpenAntigravityResponse = (
  sessionKey: string,
  signal: AbortSignal,
  selectedCredentials: Set<string>,
) => Promise<Response>

export function streamCortexKitAntigravity(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  assertAdmission?: () => Promise<void>,
): AssistantMessageEventStream {
  return runAntigravityStream(
    model,
    context,
    options,
    async (sessionKey, signal) => {
      await assertAdmission?.()
      const accessToken = options?.apiKey ?? ''
      if (!accessToken)
        throw new Error('Missing Antigravity OAuth access token')
      return sendAntigravityRequest({
        model,
        context,
        streamOptions: options,
        accessToken,
        sessionKey,
        signal,
        assertAdmission,
      })
    },
  )
}

/**
 * In vault mode, Pi's Google auth slot contains a fixed API-key marker,
 * not a real credential. Refuse any other resolved key so a stale local
 * login cannot enter this stream. Each physical request obtains its bearer
 * and project from the vault; local credentials and project caches are unused.
 */
export function createCortexKitAntigravityVaultStream(
  send: AntigravityVaultSend,
  placeholderKey: string,
) {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream =>
    runAntigravityStream(
      model,
      context,
      options,
      (sessionKey, signal, selectedCredentials) => {
        if (options?.apiKey !== placeholderKey)
          throw new Error(
            'The native Google credential slot is not synchronized for vault mode. No request was sent.',
          )
        const prepared = prepareAntigravityRequest({
          model,
          context,
          streamOptions: options,
          sessionKey,
        })
        return send(async (credential, sendSignal) => {
          selectedCredentials.add(credential.accessToken)
          try {
            return await dispatchAntigravityRequest(
              prepared,
              credential,
              sendSignal ?? signal,
            )
          } catch (error) {
            throw redactCredentialError(error, [...selectedCredentials])
          }
        }, signal)
      },
    )
}

function runAntigravityStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  open: OpenAntigravityResponse,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createOutput(model)
    const selectedCredentials = new Set<string>(
      options?.apiKey ? [options.apiKey] : [],
    )
    stream.push({ type: 'start', partial: output })
    let response: Response | undefined
    let requestAbort: AbortController | undefined
    let chunkIterator: AsyncIterator<GeminiStreamChunk> | undefined
    let detachCaller = () => {}

    try {
      const sessionKey = getRequestSessionKey(context, options)
      requestAbort = new AbortController()
      detachCaller = forwardAbort(options?.signal, requestAbort)
      response = await open(
        sessionKey,
        requestAbort.signal,
        selectedCredentials,
      )

      if (!response.ok) {
        throw new Error(
          `Antigravity request failed: HTTP ${response.status} ${await response.text()}`,
        )
      }

      const content = output.content as Array<
        TextContent | ThinkingContent | ToolCall
      >
      const toolCallState: GeminiToolCallState = {}
      let textIndex = -1
      let thinkingIndex = -1
      let terminalSeen = false

      const closeText = () => {
        if (textIndex === -1) return
        const block = content[textIndex]
        if (block?.type === 'text') {
          stream.push({
            type: 'text_end',
            contentIndex: textIndex,
            content: block.text,
            partial: output,
          })
        }
        textIndex = -1
      }

      const closeThinking = () => {
        if (thinkingIndex === -1) return
        const block = content[thinkingIndex]
        if (block?.type === 'thinking') {
          stream.push({
            type: 'thinking_end',
            contentIndex: thinkingIndex,
            content: block.thinking,
            partial: output,
          })
        }
        thinkingIndex = -1
      }

      chunkIterator = parseGeminiSse(response)[Symbol.asyncIterator]()
      let terminalFinishReason: string | undefined
      while (true) {
        const next = terminalSeen
          ? await nextWithTimeout(
              chunkIterator,
              TRAILING_USAGE_TIMEOUT_MS,
              () => requestAbort?.abort(),
            )
          : await chunkIterator.next()
        if (!next) break
        if (next.done) break

        const chunk = next.value
        const embeddedFailure = describeEmbeddedStreamFailure(chunk)
        if (embeddedFailure) throw new Error(embeddedFailure)
        updateUsage(model, output, chunk.usageMetadata)

        if (terminalSeen) {
          if (chunk.usageMetadata) break
          continue
        }

        const candidate = chunk.candidates?.[0]
        const parts = candidate?.content?.parts ?? []

        for (const part of parts) {
          if (
            !part.thought &&
            !part.functionCall &&
            !part.text &&
            part.thoughtSignature
          ) {
            const block = textIndex === -1 ? undefined : content[textIndex]
            if (block?.type === 'text') {
              block.textSignature = part.thoughtSignature
            } else {
              toolCallState.pendingThoughtSignature = part.thoughtSignature
            }
            continue
          }

          const toolCall = convertGeminiToolCallPart(part, toolCallState)
          if (toolCall) {
            closeText()
            closeThinking()
            content.push(toolCall)
            const idx = content.length - 1
            stream.push({
              type: 'toolcall_start',
              contentIndex: idx,
              partial: output,
            })
            stream.push({
              type: 'toolcall_end',
              contentIndex: idx,
              toolCall,
              partial: output,
            })
            output.stopReason = 'toolUse'
            continue
          }

          if (part.thought) {
            if (typeof part.text !== 'string' || part.text.length === 0)
              continue
            closeText()
            if (thinkingIndex === -1) {
              content.push({
                type: 'thinking',
                thinking: '',
                ...(part.thoughtSignature
                  ? { thinkingSignature: part.thoughtSignature }
                  : {}),
              })
              thinkingIndex = content.length - 1
              stream.push({
                type: 'thinking_start',
                contentIndex: thinkingIndex,
                partial: output,
              })
            }
            const block = content[thinkingIndex]
            if (block?.type === 'thinking') {
              block.thinking += part.text
              if (part.thoughtSignature)
                block.thinkingSignature = part.thoughtSignature
              stream.push({
                type: 'thinking_delta',
                contentIndex: thinkingIndex,
                delta: part.text,
                partial: output,
              })
            }
            continue
          }

          if (typeof part.text === 'string' && part.text.length > 0) {
            closeThinking()
            if (textIndex === -1) {
              const textSignature =
                part.thoughtSignature ?? toolCallState.pendingThoughtSignature
              toolCallState.pendingThoughtSignature = undefined
              content.push({
                type: 'text',
                text: '',
                ...(textSignature ? { textSignature } : {}),
              })
              textIndex = content.length - 1
              stream.push({
                type: 'text_start',
                contentIndex: textIndex,
                partial: output,
              })
            }
            const block = content[textIndex]
            if (block?.type === 'text') {
              block.text += part.text
              if (part.thoughtSignature)
                block.textSignature = part.thoughtSignature
              stream.push({
                type: 'text_delta',
                contentIndex: textIndex,
                delta: part.text,
                partial: output,
              })
            }
          }
        }

        if (candidate?.finishReason) {
          closeText()
          closeThinking()
          if (output.stopReason !== 'toolUse') {
            output.stopReason = mapFinishReason(candidate.finishReason)
          }
          terminalSeen = true
          terminalFinishReason = candidate.finishReason
          const needsTrailingUsage =
            model.id.toLowerCase().includes('gpt-oss') && !chunk.usageMetadata
          if (!needsTrailingUsage) break
        }
      }

      if (terminalSeen) {
        try {
          await chunkIterator.return?.(undefined)
        } catch (error) {
          if (!requestAbort.signal.aborted) throw error
        }
        await response.body?.cancel().catch(() => {})
      }

      if (options?.signal?.aborted) throw new Error('Request was aborted')
      if (!terminalSeen) {
        throw new Error(
          'Antigravity stream ended without a terminal candidate response',
        )
      }
      if (content.length === 0) {
        throw new Error(
          `Antigravity returned an empty response${terminalFinishReason ? ` (${terminalFinishReason})` : ''}`,
        )
      }

      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      })
      if (output.stopReason === 'stop' || output.stopReason === 'length') {
        requestSessions.completeExecution(sessionKey)
      }
      stream.end()
    } catch (error) {
      requestAbort?.abort()
      await chunkIterator?.return?.(undefined).catch(() => {})
      await response?.body?.cancel().catch(() => {})
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = redactCredentialText(
        error instanceof Error ? error.message : String(error),
        [...selectedCredentials],
      )
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    } finally {
      detachCaller()
    }
  })()

  return stream
}
