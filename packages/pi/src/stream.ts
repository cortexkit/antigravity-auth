import {
  HostRefusalError,
  hostFailure,
  isGeminiArgonModel,
  isGeminiCarbonModel,
  isRetiredAgyModel,
  type PreResponseClock,
  RETIRED_AGY_MODEL_MESSAGE,
  resolveAntigravityModel,
  supportsGeminiXHigh,
} from '@cortexkit/antigravity-auth-core'
import { readRequestEvents } from '@cortexkit/antigravity-auth-core/engine'
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { buildGeminiRequest } from './convert.ts'
import {
  createPiRequestEngine,
  type PiRequestEngine,
  type PiVaultSelection,
} from './request-engine.ts'

type PiGenerationOptions = SimpleStreamOptions & { topP?: number }

export function resolvePiAntigravityModel(
  model: Model<Api>,
  reasoning?: ThinkingLevel,
) {
  const lower = model.id.toLowerCase()
  const supportsAgyTiers =
    model.reasoning &&
    (isGeminiArgonModel(lower) ||
      isGeminiCarbonModel(lower) ||
      supportsGeminiXHigh(lower) ||
      lower.includes('gemini-3') ||
      (lower.includes('claude') &&
        (lower.includes('thinking') || /claude-(opus|sonnet)-5-5/.test(lower))))

  if (!supportsAgyTiers || !reasoning) {
    return resolveAntigravityModel(model.id)
  }

  const tier =
    reasoning === 'minimal'
      ? 'low'
      : reasoning === 'xhigh' && !supportsGeminiXHigh(lower)
        ? 'high'
        : reasoning
  const baseModel = model.id.replace(/-(minimal|low|medium|high|xhigh)$/i, '')
  return resolveAntigravityModel(`${baseModel}-${tier}`)
}

function googleRequest(
  model: Model<Api>,
  context: Context,
  options?: PiGenerationOptions,
) {
  const reasoning = options?.reasoning
  const budgets = options?.thinkingBudgets
  const budget = reasoning && budgets?.[reasoning as keyof typeof budgets]
  const level =
    reasoning === 'xhigh' && !supportsGeminiXHigh(model.id) ? 'high' : reasoning
  return buildGeminiRequest(context, {
    model: model.id,
    provider: model.provider,
    generationConfig: {
      maxOutputTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      thinkingConfig:
        model.reasoning && level
          ? {
              includeThoughts: true,
              ...(typeof budget === 'number'
                ? { thinkingBudget: budget }
                : { thinkingLevel: level }),
            }
          : undefined,
    },
  })
}

const defaultEngine = createPiRequestEngine()

export function streamCortexKitAntigravity(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  assertAdmission?: () => Promise<void>,
  preResponseClock?: PreResponseClock,
  engine = preResponseClock
    ? createPiRequestEngine({ preResponseClock })
    : defaultEngine,
): AssistantMessageEventStream {
  return run(model, context, options, engine, {
    domain: 'local',
    accessToken: options?.apiKey ?? '',
    assertAdmission,
  })
}

export function createCortexKitAntigravityVaultStream(
  select: (signal: AbortSignal, modelId?: string) => Promise<PiVaultSelection>,
  placeholderKey: string,
  preResponseClock?: PreResponseClock,
  engine = createPiRequestEngine({ preResponseClock }),
) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    run(model, context, options, engine, {
      domain: 'vault',
      select(signal) {
        if (options?.apiKey !== placeholderKey)
          throw new HostRefusalError(
            'The native Google credential slot is not synchronized for vault mode. No request was sent.',
          )
        return select(signal, model.id)
      },
    })
}

function run(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  engine: PiRequestEngine,
  selection: Parameters<PiRequestEngine['execute']>[0],
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const output: AssistantMessage = {
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
  let openIndex: number | undefined
  const closeBlock = () => {
    if (openIndex === undefined) return
    const block = output.content[openIndex]
    if (block?.type === 'text')
      stream.push({
        type: 'text_end',
        contentIndex: openIndex,
        content: block.text,
        partial: output,
      })
    if (block?.type === 'thinking')
      stream.push({
        type: 'thinking_end',
        contentIndex: openIndex,
        content: block.thinking,
        partial: output,
      })
    openIndex = undefined
  }
  stream.push({ type: 'start', partial: output })
  void (async () => {
    try {
      options?.signal?.throwIfAborted()
      if (isRetiredAgyModel(model.id))
        throw new HostRefusalError(RETIRED_AGY_MODEL_MESSAGE)
      const request = googleRequest(model, context, options)
      const response = await engine.execute(
        selection,
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model.id) +
          ':streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: options?.signal,
        },
        {
          session: {
            sessionId: options?.sessionId ?? null,
            parentSessionId: null,
          },
          // Pi's provider callbacks receive the same shape as its native providers.
          onPayload:
            options?.onPayload &&
            ((payload) => options.onPayload?.(payload, model)),
          onResponse:
            options?.onResponse &&
            ((response) =>
              options.onResponse?.(
                {
                  status: response.status,
                  headers: Object.fromEntries(response.headers),
                },
                model,
              )),
        },
      )
      for await (const event of readRequestEvents(response)) {
        switch (event.type) {
          case 'text': {
            let block =
              openIndex === undefined ? undefined : output.content[openIndex]
            if (block?.type !== 'text') {
              closeBlock()
              block = { type: 'text', text: '' }
              openIndex = output.content.push(block) - 1
              stream.push({
                type: 'text_start',
                contentIndex: openIndex,
                partial: output,
              })
            }
            block.text += event.delta
            if (event.signature) block.textSignature = event.signature
            if (event.delta)
              stream.push({
                type: 'text_delta',
                contentIndex: openIndex!,
                delta: event.delta,
                partial: output,
              })
            break
          }
          case 'thinking': {
            let block =
              openIndex === undefined ? undefined : output.content[openIndex]
            if (block?.type !== 'thinking') {
              closeBlock()
              block = { type: 'thinking', thinking: '' }
              openIndex = output.content.push(block) - 1
              stream.push({
                type: 'thinking_start',
                contentIndex: openIndex,
                partial: output,
              })
            }
            block.thinking += event.delta
            if (event.signature) block.thinkingSignature = event.signature
            if (event.delta)
              stream.push({
                type: 'thinking_delta',
                contentIndex: openIndex!,
                delta: event.delta,
                partial: output,
              })
            break
          }
          case 'toolCall': {
            closeBlock()
            const toolCall = {
              type: 'toolCall' as const,
              id: event.id,
              name: event.name,
              arguments: event.arguments as ToolCall['arguments'],
              thoughtSignature: event.signature,
            }
            const contentIndex = output.content.push(toolCall) - 1
            stream.push({
              type: 'toolcall_start',
              contentIndex,
              partial: output,
            })
            stream.push({
              type: 'toolcall_end',
              contentIndex,
              toolCall,
              partial: output,
            })
            break
          }
          case 'metadata':
            if (event.responseId !== undefined)
              output.responseId = event.responseId
            if (event.rawStopReason !== undefined)
              output.rawStopReason = event.rawStopReason
            break
          case 'usage':
            Object.assign(output.usage, event.usage)
            calculateCost(model, output.usage)
            break
          case 'terminal':
            closeBlock()
            output.stopReason = event.reason
            stream.push({ type: 'done', reason: event.reason, message: output })
            break
          case 'failure':
            throw event.error
        }
      }
    } catch (error) {
      closeBlock()
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = options?.signal?.aborted
        ? 'Request was aborted'
        : hostFailure(error, (diagnostic) => engine.logger.error(diagnostic))
            .message
      stream.push({ type: 'error', reason: output.stopReason, error: output })
    } finally {
      stream.end()
    }
  })()
  return stream
}
