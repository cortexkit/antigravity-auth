import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { type ContentPart, Media, Message } from '@opencode/ai'
import { make } from '@opencode/ai/promise'
import { configure } from '@opencode/ai/providers/google'
import { RequestExecutor } from '@opencode/ai/route/executor'
import { jsonSchema, type ModelMessage, streamText } from 'ai'
import { Effect } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import type { Conversation, Part } from './cases.ts'
import { placeholder } from './fixtures.ts'

export type Surface = {
  text: string
  thinking: string
  calls: { name: string; input: unknown; signature?: string }[]
  signatures: { channel: 'text' | 'thinking'; value: string }[]
  usage: {
    input: number
    output: number
    cacheRead: number
    reasoning: number
    total: number
  } | null
  terminal: string[]
  errors: string[]
  compaction: boolean
}

export function surface(): Surface {
  return {
    text: '',
    thinking: '',
    calls: [],
    signatures: [],
    usage: null,
    terminal: [],
    errors: [],
    compaction: false,
  }
}

export function sig(metadata: unknown): string | undefined {
  const value = (
    metadata as { google?: { thoughtSignature?: unknown } } | undefined
  )?.google?.thoughtSignature
  return typeof value === 'string' ? value : undefined
}

export function recordSignature(
  output: Surface,
  channel: 'text' | 'thinking',
  value: string | undefined,
) {
  if (
    value !== undefined &&
    !output.signatures.some(
      (entry) => entry.channel === channel && entry.value === value,
    )
  )
    output.signatures.push({ channel, value })
}

export function recordFailure(output: Surface, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  output.errors.push(message)
  const kind =
    /context.?(?:overflow|length)|prompt is too long|input token count .* exceeds/i.test(
      message,
    )
      ? 'context_overflow'
      : /pre.response deadline|timed out waiting|deadline/i.test(message)
        ? 'deadline'
        : /thinking.signature|thought.signature/i.test(message)
          ? 'signature_recovery_failed'
          : /reauthoriz|verification/i.test(message)
            ? 'account_reauthorize'
            : /does not exist|not found|not available for/i.test(message)
              ? 'model_not_found'
              : /empty response|no (?:visible )?(?:content|text|output)/i.test(
                    message,
                  )
                ? 'empty'
                : /incomplete|without a finish/i.test(message)
                  ? 'incomplete'
                  : /quota_exhausted|quota exhausted/i.test(message)
                    ? 'quota_exhausted'
                    : /rate.limit|quota/i.test(message)
                      ? 'quota_wait_exhausted'
                      : /stopped by google/i.test(message)
                        ? 'stopped_by_google'
                        : /embedded/i.test(message)
                          ? 'embedded_error'
                          : /cancel|abort/i.test(message)
                            ? 'cancelled'
                            : 'upstream_http'
  output.compaction ||= kind === 'context_overflow'
  if (!output.terminal.some((value) => value.startsWith('failure:')))
    output.terminal.push(`failure:${kind}`)
}

export function terminal(output: Surface, reason: string) {
  if (
    reason === 'error' &&
    output.terminal.some((value) => value.startsWith('failure:'))
  )
    return
  output.terminal.push(
    reason === 'stop' || reason === 'tool-calls'
      ? 'stop'
      : reason === 'length'
        ? 'length'
        : reason === 'content-filter'
          ? 'failure:stopped_by_google'
          : `failure:${reason}`,
  )
}

function providerMetadata(part: Part) {
  return 'signature' in part && part.signature
    ? { google: { thoughtSignature: part.signature } }
    : undefined
}

function aiSdkPart(part: Part) {
  const providerOptions = providerMetadata(part)
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, providerOptions }
    case 'image':
      return { type: 'image', image: part.data, mediaType: part.mediaType }
    case 'thinking':
      return { type: 'reasoning', text: part.text, providerOptions }
    case 'call':
      return {
        type: 'tool-call',
        toolCallId: part.id,
        toolName: part.name,
        input: part.args,
        providerOptions,
      }
    case 'result': {
      const value = part.content.map((item) =>
        item.type === 'text'
          ? { type: 'text', text: item.text }
          : { type: 'image-data', data: item.data, mediaType: item.mediaType },
      )
      const item = part.content[0]
      return {
        type: 'tool-result',
        toolCallId: part.id,
        toolName: part.name,
        output:
          part.content.length === 1 && item?.type === 'text'
            ? { type: 'text', value: item.text }
            : { type: 'content', value },
      }
    }
  }
}

export async function google1(
  input: Conversation,
  receive: (request: Request) => Promise<Response>,
  signal?: AbortSignal,
) {
  const output = surface()
  const options = input.options
  const google = createGoogleGenerativeAI({
    apiKey: placeholder,
    fetch: ((url, init) => receive(new Request(url, init))) as typeof fetch,
  })
  try {
    const result = streamText({
      model: google(input.model),
      system: input.prompt,
      messages: input.messages.map(({ role, parts }) => ({
        role,
        content: parts.map(aiSdkPart),
      })) as ModelMessage[],
      tools: Object.fromEntries(
        input.tools.map(({ name, description, schema }) => [
          name,
          { description, inputSchema: jsonSchema(schema) },
        ]),
      ),
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxTokens,
      providerOptions: {
        google: {
          ...(options.level || options.budget !== undefined
            ? {
                thinkingConfig: {
                  includeThoughts: true,
                  ...(options.budget === undefined
                    ? { thinkingLevel: options.level! }
                    : { thinkingBudget: options.budget }),
                },
              }
            : {}),
        },
      },
      abortSignal: signal,
      maxRetries: 0,
      onError() {},
    })
    for await (const event of result.fullStream) {
      switch (event.type) {
        case 'text-delta':
          output.text += event.text
          recordSignature(output, 'text', sig(event.providerMetadata))
          break
        case 'text-end':
          recordSignature(output, 'text', sig(event.providerMetadata))
          break
        case 'reasoning-delta':
          output.thinking += event.text
          recordSignature(output, 'thinking', sig(event.providerMetadata))
          break
        case 'reasoning-end':
          recordSignature(output, 'thinking', sig(event.providerMetadata))
          break
        case 'tool-call':
          output.calls.push({
            name: event.toolName,
            input: event.input,
            signature: sig(event.providerMetadata),
          })
          break
        case 'error':
          recordFailure(output, event.error)
          break
        case 'abort':
          recordFailure(output, 'cancelled')
          break
        case 'finish': {
          const usage = event.totalUsage
          if (
            usage.totalTokens !== undefined ||
            usage.inputTokens !== undefined ||
            usage.outputTokens !== undefined
          ) {
            output.usage = {
              input:
                usage.inputTokenDetails.noCacheTokens ?? usage.inputTokens ?? 0,
              cacheRead: usage.inputTokenDetails.cacheReadTokens ?? 0,
              output: usage.outputTokens ?? 0,
              reasoning: usage.outputTokenDetails.reasoningTokens ?? 0,
              total: usage.totalTokens ?? 0,
            }
          }
          terminal(output, event.finishReason)
          break
        }
      }
    }
  } catch (error) {
    recordFailure(output, error)
  }
  return output
}

function gaPart(part: Part): ContentPart {
  const metadata = providerMetadata(part)
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, providerMetadata: metadata }
    case 'image':
      return Message.media(Media.base64(part.data, part.mediaType))
    case 'thinking':
      return { type: 'reasoning', text: part.text, providerMetadata: metadata }
    case 'call':
      return {
        type: 'tool-call',
        id: part.id,
        name: part.name,
        input: part.args,
        providerMetadata: metadata,
      }
    case 'result': {
      const item = part.content[0]
      return {
        type: 'tool-result',
        id: part.id,
        name: part.name,
        result:
          part.content.length === 1 && item?.type === 'text'
            ? { type: 'text', value: item.text }
            : {
                type: 'content',
                value: part.content.map((entry) =>
                  entry.type === 'text'
                    ? entry
                    : {
                        type: 'file',
                        uri: `data:${entry.mediaType};base64,${entry.data}`,
                        mime: entry.mediaType,
                      },
                ),
              },
      }
    }
  }
}

export async function google2(
  input: Conversation,
  receive: (request: Request) => Promise<Response>,
  signal?: AbortSignal,
  apiKey = placeholder,
) {
  const output = surface()
  const ai = make({
    layer: RequestExecutor.middleware((request) =>
      Effect.flatMap(HttpClientRequest.toWeb(request, { signal }), (web) =>
        Effect.tryPromise({
          try: async () =>
            HttpClientResponse.fromWeb(request, await receive(web)),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
      ),
    ),
  })
  const { temperature, topP, maxTokens, budget } = input.options
  try {
    const events = ai.llm.stream(
      {
        model: configure({ apiKey }).model(input.model),
        system: input.prompt,
        messages: input.messages.map(({ role, parts }) =>
          Message.make({ role, content: parts.map(gaPart) }),
        ),
        tools: input.tools.map(({ name, description, schema }) => ({
          name,
          description,
          inputSchema: schema,
        })),
        generation: { temperature, topP, maxTokens },
        providerOptions: {
          google:
            budget === undefined
              ? {}
              : {
                  thinkingConfig: {
                    thinkingBudget: budget,
                    includeThoughts: true,
                  },
                },
        },
        http: { headerTimeout: false, chunkTimeout: false },
      },
      { signal },
    )
    for await (const event of events) {
      switch (event.type) {
        case 'text-delta':
          output.text += event.text
          recordSignature(output, 'text', sig(event.providerMetadata))
          break
        case 'text-end':
          recordSignature(output, 'text', sig(event.providerMetadata))
          break
        case 'reasoning-delta':
          output.thinking += event.text
          recordSignature(output, 'thinking', sig(event.providerMetadata))
          break
        case 'reasoning-end':
          recordSignature(output, 'thinking', sig(event.providerMetadata))
          break
        case 'tool-call':
          output.calls.push({
            name: event.name,
            input: event.input,
            signature: sig(event.providerMetadata),
          })
          break
        case 'provider-error':
          recordFailure(output, event.message)
          output.compaction ||= event.classification === 'context-overflow'
          break
        case 'finish': {
          const usage = event.usage
          if (usage) {
            output.usage = {
              input: usage.nonCachedInputTokens ?? usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              total: usage.totalTokens ?? 0,
              cacheRead: usage.cacheReadInputTokens ?? 0,
              reasoning: usage.reasoningTokens ?? 0,
            }
          }
          terminal(output, event.reason.normalized)
          break
        }
      }
    }
  } catch (error) {
    recordFailure(output, error)
  } finally {
    await ai.dispose()
  }
  return output
}
