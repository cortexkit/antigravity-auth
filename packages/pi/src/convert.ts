import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
// Older Pi versions don't export the transcript helpers.
import * as piAi from '@earendil-works/pi-ai'
import {
  googleToolParameters,
  piGeminiToolParameters,
} from './google-tool-schema.ts'

type InlineImage = { inlineData: { mimeType: string; data: string } }
type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | InlineImage
  | {
      functionCall: { id?: string; name: string; args: Record<string, unknown> }
      thoughtSignature?: string
    }
  | {
      functionResponse: {
        id?: string
        name: string
        response: Record<string, unknown>
        parts?: InlineImage[]
      }
    }

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description: string
      parameters?: unknown
    }>
  }>
  generationConfig?: Record<string, unknown>
}

function inlineImage(image: ImageContent): InlineImage {
  return {
    inlineData: {
      mimeType: image.mimeType === 'image/*' ? 'image/jpeg' : image.mimeType,
      data: image.data,
    },
  }
}

export interface BuildGeminiRequestOptions {
  provider?: string
  model?: string
  generationConfig?: Record<string, unknown>
}

// Older Google models do not accept explicit function IDs. Newer models need
// them to keep parallel results tied to the calls that produced them.
function toolId(id: string, model?: string): { id?: string } {
  const version = /^gemini(?:-live)?-(\d+)/i.exec(model ?? '')?.[1]
  return version !== undefined && Number(version) < 3 ? {} : { id }
}

function convertAssistantParts(
  message: AssistantMessage,
  options?: BuildGeminiRequestOptions,
): GeminiPart[] {
  const sameModel =
    !options?.model ||
    !options.provider ||
    (message.provider === options.provider && message.model === options.model)
  const parts: GeminiPart[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'thinking':
        if (sameModel && block.thinking)
          parts.push({
            text: block.thinking,
            thought: true,
            thoughtSignature: block.thinkingSignature,
          })
        break
      case 'text':
        if (block.text.length > 0 || (sameModel && block.textSignature))
          parts.push({
            text: block.text,
            thoughtSignature: sameModel ? block.textSignature : undefined,
          })
        break
      case 'toolCall':
        parts.push({
          functionCall: {
            ...toolId(block.id, options?.model),
            name: block.name,
            args: block.arguments ?? {},
          },
          thoughtSignature: sameModel ? block.thoughtSignature : undefined,
        })
        break
    }
  }
  return parts
}

function toolResultParts(
  message: ToolResultMessage,
  model?: string,
): GeminiPart[] {
  const name = message.toolName
  const id = toolId(message.toolCallId, model)
  if (message.isError) {
    const error = message.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('\n')
    return [
      {
        functionResponse: {
          ...id,
          name,
          response: { error: error || 'Error' },
        },
      },
    ]
  }
  const response = (content: string, parts?: InlineImage[]): GeminiPart => ({
    functionResponse: {
      ...id,
      name,
      response: { name, content },
      ...(parts?.length && { parts }),
    },
  })
  if (!/gemini-2[.-]5(?:[.-]|$)/i.test(model ?? '')) {
    const texts = message.content.flatMap((item) =>
      item.type === 'text' ? [item.text] : [],
    )
    const images = message.content.flatMap((item) =>
      item.type === 'image' ? [inlineImage(item)] : [],
    )
    return [response(texts.join('\n'), images)]
  }
  return message.content.flatMap((item): GeminiPart[] =>
    item.type === 'text'
      ? [response(item.text)]
      : [
          inlineImage(item),
          {
            text: 'Tool executed successfully and returned this image as a response',
          },
        ],
  )
}

function convertMessages(
  messages: Message[],
  options?: BuildGeminiRequestOptions,
): GeminiContent[] {
  const contents: GeminiContent[] = []
  let results: GeminiContent | undefined
  for (const message of messages) {
    if (!message || message.role === 'system') continue
    if (message.role === 'toolResult') {
      if (!results) {
        results = { role: 'user', parts: [] }
        contents.push(results)
      }
      results.parts.push(...toolResultParts(message, options?.model))
      continue
    }
    results = undefined
    if (message.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: convertAssistantParts(message, options),
      })
    } else if (message.role === 'user') {
      contents.push({
        role: 'user',
        parts:
          typeof message.content === 'string'
            ? [{ text: message.content }]
            : message.content.map((item) =>
                item.type === 'image' ? inlineImage(item) : { text: item.text },
              ),
      })
    }
  }
  return contents
}

interface InstructionState {
  systemPrompt: string
  tools: Tool[]
}

/**
 * Resolve the system prompt and tool set the request must carry.
 *
 * Pi 0.86+ hands providers a transcript whose system messages hold the prompt
 * and tools: the leading one declares them and later ones append text, patch
 * named sections, and add or remove tools. When the transcript has any system
 * message it is the only authority, replayed with pi-ai's own helpers, so a
 * prompt or tool set emptied by later system messages stays empty even if
 * flat `systemPrompt`/`tools` fields are also present. Older Pi runtimes pass
 * a flat `Context` with no system messages, which is read as-is.
 */
function resolveInstructionState(context: Context): InstructionState {
  if (!context.messages.some((message) => message?.role === 'system')) {
    return {
      systemPrompt: context.systemPrompt ?? '',
      tools: context.tools ?? [],
    }
  }

  if (
    typeof piAi.getCurrentSystemPrompt !== 'function' ||
    typeof piAi.getCurrentTools !== 'function'
  ) {
    // Dropping the system messages would silently send a request with no
    // prompt and no tools, so refuse instead.
    throw new Error(
      'Pi transcript contains system messages but the installed @earendil-works/pi-ai does not export getCurrentSystemPrompt/getCurrentTools (requires >= 0.86)',
    )
  }

  return {
    systemPrompt: piAi.getCurrentSystemPrompt(context.messages),
    tools: piAi.getCurrentTools(context.messages),
  }
}

/** Build Google SDK ingress JSON; the engine performs all AGY transformations. */
export function buildGeminiRequest(
  context: Context,
  options?: BuildGeminiRequestOptions,
): GeminiRequest {
  const { systemPrompt, tools } = resolveInstructionState(context)
  return {
    generationConfig: options?.generationConfig ?? {},
    contents: convertMessages(context.messages, options),
    ...(systemPrompt && {
      systemInstruction: { parts: [{ text: systemPrompt }] },
    }),
    ...(tools.length && {
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            parameters:
              options?.model && !options.model.includes('claude')
                ? piGeminiToolParameters(tool.parameters, options.model)
                : googleToolParameters(tool.parameters),
          })),
        },
      ],
    }),
  }
}
