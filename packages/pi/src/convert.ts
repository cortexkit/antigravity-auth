import { toGeminiSchema } from '@cortexkit/antigravity-auth-core'
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
// Namespace import so the transcript helpers can be feature-detected: a named
// import of an export that an older installed pi-ai lacks fails at module link
// time and would stop the extension from loading at all.
import * as piAi from '@earendil-works/pi-ai'

/** Gemini `contents` part shapes. */
type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: { name: string; args: Record<string, unknown>; id: string }
      thoughtSignature?: string
    }
  | {
      functionResponse: {
        name: string
        response: Record<string, unknown>
        id: string
      }
    }

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters?: unknown
  }>
}

export interface GeminiRequest {
  contents: GeminiContent[]
  tools?: GeminiTool[]
  systemInstruction?: { parts: GeminiPart[] }
}

function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
}

function convertUserParts(
  content: Array<TextContent | ImageContent>,
): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const item of content) {
    if (item.type === 'text') {
      if (item.text) parts.push({ text: sanitize(item.text) })
    } else if (item.type === 'image' && item.data) {
      parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } })
    }
  }
  return parts
}

function convertAssistantParts(
  message: AssistantMessage,
  preserveSignedHistory: boolean,
): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const block of message.content) {
    if (block.type === 'thinking') {
      if (preserveSignedHistory && block.thinking) {
        parts.push({
          text: sanitize(block.thinking),
          thought: true,
          ...(block.thinkingSignature
            ? { thoughtSignature: block.thinkingSignature }
            : {}),
        })
      }
    } else if (block.type === 'text' && block.text.trim()) {
      parts.push({
        text: sanitize(block.text),
        ...(preserveSignedHistory && block.textSignature
          ? { thoughtSignature: block.textSignature }
          : {}),
      })
    } else if (block.type === 'toolCall') {
      parts.push({
        functionCall: {
          name: block.name,
          args: (block.arguments ?? {}) as Record<string, unknown>,
          id: block.id,
        },
        ...(preserveSignedHistory && block.thoughtSignature
          ? { thoughtSignature: block.thoughtSignature }
          : {}),
      })
    }
  }
  return parts
}

function toolResultResponse(
  message: ToolResultMessage,
): Record<string, unknown> {
  const text = message.content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (message.isError) {
    return { error: text || 'Error' }
  }
  return { output: text }
}

export interface BuildGeminiRequestOptions {
  provider?: string
  model?: string
}

function isSameTargetModel(
  message: AssistantMessage,
  options: BuildGeminiRequestOptions | undefined,
): boolean {
  if (!options?.provider || !options.model) return true
  return (
    message.provider === options.provider && message.model === options.model
  )
}

function convertMessages(
  messages: Message[],
  options?: BuildGeminiRequestOptions,
): GeminiContent[] {
  const contents: GeminiContent[] = []
  const callMatchesTarget = new Map<string, boolean>()

  for (const message of messages) {
    if (message?.role !== 'assistant') continue
    const matchesTarget = isSameTargetModel(message, options)
    for (const block of message.content) {
      if (block.type === 'toolCall') {
        callMatchesTarget.set(block.id, matchesTarget)
      }
    }
  }

  for (const message of messages) {
    if (!message) continue

    // System messages carry the prompt and tool state, which
    // resolveInstructionState replays into systemInstruction and tools.
    if (message.role === 'system') continue

    if (message.role === 'user') {
      const parts =
        typeof message.content === 'string'
          ? message.content.trim()
            ? [{ text: sanitize(message.content) }]
            : []
          : convertUserParts(
              message.content as Array<TextContent | ImageContent>,
            )
      if (parts.length) contents.push({ role: 'user', parts })
      continue
    }

    if (message.role === 'assistant') {
      const parts = convertAssistantParts(
        message,
        isSameTargetModel(message, options),
      )
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }

    if (message.role === 'toolResult') {
      const role =
        callMatchesTarget.get(message.toolCallId) === true ? 'model' : 'user'
      const part: GeminiPart = {
        functionResponse: {
          name: message.toolName,
          response: toolResultResponse(message),
          id: message.toolCallId,
        },
      }
      // Gemini groups consecutive function responses into one user turn.
      const last = contents[contents.length - 1]
      if (
        last &&
        last.role === role &&
        last.parts.every((p) => 'functionResponse' in p)
      ) {
        last.parts.push(part)
      } else {
        contents.push({ role, parts: [part] })
      }
    }
  }

  return contents
}

function convertTools(tools: Tool[] | undefined): GeminiTool[] | undefined {
  if (!tools?.length) return undefined
  return [
    {
      // Match the agy wire format (MITM-verified): field name is `parameters`
      // (not `parametersJsonSchema`) and schemas are sanitized to Gemini shape
      // (UPPERCASE types, unsupported keywords stripped) via core's toGeminiSchema.
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.parameters),
      })),
    },
  ]
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

/**
 * Convert a pi request context into a Gemini `generateContent` request body
 * (the inner `request` object of the Antigravity envelope). Accepts both the
 * transcript form Pi 0.86+ passes to providers and the flat `Context` of
 * older runtimes.
 */
export function buildGeminiRequest(
  context: Context,
  options?: BuildGeminiRequestOptions,
): GeminiRequest {
  const request: GeminiRequest = {
    contents: convertMessages(context.messages, options),
  }

  const { systemPrompt, tools } = resolveInstructionState(context)

  const geminiTools = convertTools(tools)
  if (geminiTools) request.tools = geminiTools

  if (systemPrompt.trim()) {
    request.systemInstruction = {
      parts: [{ text: sanitize(systemPrompt) }],
    }
  }

  return request
}
