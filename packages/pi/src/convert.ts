import { toGeminiSchema } from "@cortexkit/antigravity-auth-core"
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai"

/** Gemini `contents` part shapes. */
type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: { name: string; args: Record<string, unknown>; id: string }
      thoughtSignature?: string
    }
  | { functionResponse: { name: string; response: Record<string, unknown>; id: string } }

interface GeminiContent {
  role: "user" | "model"
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
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD")
}

function convertUserParts(content: Array<TextContent | ImageContent>): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const item of content) {
    if (item.type === "text") {
      if (item.text) parts.push({ text: sanitize(item.text) })
    } else if (item.type === "image" && item.data) {
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
    if (block.type === "thinking") {
      if (preserveSignedHistory && block.thinking) {
        parts.push({
          text: sanitize(block.thinking),
          thought: true,
          ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
        })
      }
    } else if (block.type === "text" && block.text.trim()) {
      parts.push({
        text: sanitize(block.text),
        ...(preserveSignedHistory && block.textSignature
          ? { thoughtSignature: block.textSignature }
          : {}),
      })
    } else if (block.type === "toolCall") {
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

function toolResultResponse(message: ToolResultMessage): Record<string, unknown> {
  const text = message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
  if (message.isError) {
    return { error: text || "Error" }
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
  return message.provider === options.provider && message.model === options.model
}

function convertMessages(
  messages: Message[],
  options?: BuildGeminiRequestOptions,
): GeminiContent[] {
  const contents: GeminiContent[] = []
  const callMatchesTarget = new Map<string, boolean>()

  for (const message of messages) {
    if (message?.role !== "assistant") continue
    const matchesTarget = isSameTargetModel(message, options)
    for (const block of message.content) {
      if (block.type === "toolCall") {
        callMatchesTarget.set(block.id, matchesTarget)
      }
    }
  }

  for (const message of messages) {
    if (!message) continue

    if (message.role === "user") {
      const parts =
        typeof message.content === "string"
          ? message.content.trim()
            ? [{ text: sanitize(message.content) }]
            : []
          : convertUserParts(message.content as Array<TextContent | ImageContent>)
      if (parts.length) contents.push({ role: "user", parts })
      continue
    }

    if (message.role === "assistant") {
      const parts = convertAssistantParts(message, isSameTargetModel(message, options))
      if (parts.length) contents.push({ role: "model", parts })
      continue
    }

    if (message.role === "toolResult") {
      const role = callMatchesTarget.get(message.toolCallId) === false ? "model" : "user"
      const part: GeminiPart = {
        functionResponse: {
          name: message.toolName,
          response: toolResultResponse(message),
          id: message.toolCallId,
        },
      }
      // Gemini groups consecutive function responses into one user turn.
      const last = contents[contents.length - 1]
      if (last && last.role === role && last.parts.every((p) => "functionResponse" in p)) {
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

/**
 * Convert a pi `Context` into a Gemini `generateContent` request body
 * (the inner `request` object of the Antigravity envelope).
 */
export function buildGeminiRequest(
  context: Context,
  options?: BuildGeminiRequestOptions,
): GeminiRequest {
  const request: GeminiRequest = {
    contents: convertMessages(context.messages, options),
  }

  const tools = convertTools(context.tools)
  if (tools) request.tools = tools

  if (context.systemPrompt?.trim()) {
    request.systemInstruction = { parts: [{ text: sanitize(context.systemPrompt) }] }
  }

  return request
}
