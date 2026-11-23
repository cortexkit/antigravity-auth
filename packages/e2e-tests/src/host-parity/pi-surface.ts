import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { rememberPackedRefresh } from '../../../pi/src/credential-cache.ts'
import type * as PiStream from '../../../pi/src/stream.ts'
import type { Conversation, Custody, Part } from './cases.ts'
import type { Environment } from './environment.ts'
import { credential, placeholder } from './fixtures.ts'
import {
  recordFailure,
  recordSignature,
  surface,
  terminal,
} from './native-google.ts'

let activation = 0

function content(part: Part): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, textSignature: part.signature }
    case 'image':
      return { type: 'image', data: part.data, mimeType: part.mediaType }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: part.text,
        thinkingSignature: part.signature,
      }
    case 'call':
      return {
        type: 'toolCall',
        id: part.id,
        name: part.name,
        arguments: part.args,
        thoughtSignature: part.signature,
      }
    case 'result':
      return {
        type: 'toolResult',
        toolCallId: part.id,
        toolName: part.name,
        content: part.content.map(content),
        isError: false,
      }
  }
}

export function piContext(input: Conversation, transcript: boolean): Context {
  const tools = input.tools.map(({ name, description, schema }) => ({
    name,
    description,
    parameters: schema,
  }))
  const messages = input.messages.flatMap(({ role, parts }, offset) => {
    // Equal input timestamps across distinct requests catch fallback session
    // identity that accidentally depends on timestamp rather than ownership.
    const timestamp = offset + 1
    return role === 'tool'
      ? parts.map((part) => ({
          ...content(part),
          role: 'toolResult',
          timestamp,
        }))
      : [
          {
            role,
            content: parts.map(content),
            timestamp,
            ...(role === 'assistant'
              ? {
                  api: 'google-generative-ai',
                  provider: 'google',
                  model: input.model,
                  stopReason: 'stop',
                }
              : {}),
          },
        ]
  })
  return (transcript
    ? {
        messages: [
          {
            role: 'system',
            content: input.prompt,
            toolsAdded: tools,
            timestamp: 0,
          },
          ...messages,
        ],
      }
    : { systemPrompt: input.prompt, messages, tools }) as unknown as Context
}

export async function piAdapter(
  environment: Environment,
  custody: Custody,
  transcript: boolean,
) {
  // Pi's active module holds the baseline session store. Import a separate
  // activation for a separate scenario, not for each request in a scenario.
  const module = (await import(
    `../../../pi/src/stream.ts?host-parity=${++activation}`
  )) as typeof PiStream
  rememberPackedRefresh(
    credential.accessToken,
    `fixture-refresh|${credential.projectId}|${credential.projectId}`,
  )
  const stream =
    custody === 'local'
      ? module.streamCortexKitAntigravity
      : module.createCortexKitAntigravityVaultStream(
          (dispatch, signal) => dispatch(credential, signal),
          placeholder,
        )
  return {
    async run(input: Conversation, session?: string, signal?: AbortSignal) {
      const output = surface()
      const model = {
        id: input.model,
        name: input.model,
        api: 'google-generative-ai',
        provider: 'google',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as Model<Api>
      const { level, budget, temperature, topP, maxTokens } = input.options
      const options = {
        apiKey: custody === 'local' ? credential.accessToken : placeholder,
        sessionId: session,
        signal,
        reasoning: level,
        thinkingBudgets:
          level && budget !== undefined ? { [level]: budget } : undefined,
        temperature,
        topP,
        maxTokens,
        onPayload(payload: unknown) {
          environment.hooks.push({ payload })
          return { ignored: true }
        },
        onResponse(response: unknown) {
          environment.hooks.push({ response })
        },
      } as SimpleStreamOptions
      try {
        for await (const event of stream(
          model,
          piContext(input, transcript),
          options,
        )) {
          switch (event.type) {
            case 'text_delta':
              output.text += event.delta
              break
            case 'thinking_delta':
              output.thinking += event.delta
              break
            case 'toolcall_end': {
              const block = event.toolCall
              output.calls.push({
                name: block.name,
                input: block.arguments,
                signature: block.thoughtSignature,
              })
              break
            }
            case 'done':
            case 'error': {
              const message =
                event.type === 'done' ? event.message : event.error
              const { usage } = message
              output.usage = {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                reasoning:
                  (usage as typeof usage & { reasoningTokens?: number })
                    .reasoningTokens ?? 0,
                total: usage.totalTokens,
              }
              for (const block of message.content) {
                if (block.type === 'text')
                  recordSignature(output, 'text', block.textSignature)
                if (block.type === 'thinking')
                  recordSignature(output, 'thinking', block.thinkingSignature)
              }
              if (event.type === 'error')
                recordFailure(output, message.errorMessage ?? event.reason)
              else
                terminal(
                  output,
                  event.reason === 'toolUse' ? 'stop' : event.reason,
                )
              break
            }
          }
        }
      } catch (error) {
        recordFailure(output, error)
      }
      return output
    },
    async dispose() {},
  }
}
