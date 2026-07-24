/**
 * Resolve prompt context for synthetic OpenCode user messages.
 *
 * OpenCode records ignored/noReply prompt messages. If a plugin sends one
 * without the active model/variant, the next prompt can inherit the default
 * model and unexpectedly switch providers. Preserve the latest prompt context
 * for hidden slash-command replies.
 */
export interface ResolvedPromptContext {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

interface RawInfo {
  role?: string
  agent?: string
  variant?: string
  providerID?: string
  modelID?: string
  model?: { providerID?: string; modelID?: string; variant?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractMessages(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (isRecord(response) && Array.isArray(response.data)) return response.data
  return []
}

function getRole(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.info)) return undefined
  return typeof message.info.role === 'string' ? message.info.role : undefined
}

function extractFromMessage(message: unknown): ResolvedPromptContext | null {
  if (!isRecord(message) || !isRecord(message.info)) return null
  const info = message.info as RawInfo
  const modelInfo = isRecord(info.model) ? info.model : undefined

  const agent = typeof info.agent === 'string' ? info.agent : undefined
  const providerID =
    typeof modelInfo?.providerID === 'string'
      ? modelInfo.providerID
      : typeof info.providerID === 'string'
        ? info.providerID
        : undefined
  const modelID =
    typeof modelInfo?.modelID === 'string'
      ? modelInfo.modelID
      : typeof info.modelID === 'string'
        ? info.modelID
        : undefined
  const variant =
    typeof modelInfo?.variant === 'string'
      ? modelInfo.variant
      : typeof info.variant === 'string'
        ? info.variant
        : undefined

  if (!agent && (!providerID || !modelID) && !variant) return null
  const context: ResolvedPromptContext = {}
  if (agent) context.agent = agent
  if (providerID && modelID) context.model = { providerID, modelID }
  if (variant) context.variant = variant
  return context
}

function mergeContexts(
  base: ResolvedPromptContext,
  patch: ResolvedPromptContext,
): ResolvedPromptContext {
  return {
    agent: base.agent ?? patch.agent,
    model: base.model ?? patch.model,
    variant: base.variant ?? patch.variant,
  }
}

function isComplete(context: ResolvedPromptContext) {
  return Boolean(context.agent && context.model && context.variant)
}

export async function resolvePromptContext(
  client: unknown,
  sessionId: string,
): Promise<ResolvedPromptContext | null> {
  if (!client || !sessionId) return null
  const typedClient = client as {
    session?: {
      messages?: (input: {
        path: { id: string }
        query?: { limit?: number }
      }) =>
        | Promise<{ data?: unknown[] } | unknown[]>
        | { data?: unknown[] }
        | unknown[]
    }
  }
  if (typeof typedClient.session?.messages !== 'function') return null

  let messages: unknown[] = []
  try {
    messages = extractMessages(
      await Promise.resolve(
        typedClient.session.messages({
          path: { id: sessionId },
          query: { limit: 100 },
        }),
      ),
    )
  } catch {
    return null
  }
  if (messages.length === 0) return null

  let result: ResolvedPromptContext = {}
  for (let index = messages.length - 1; index >= 0; index--) {
    if (getRole(messages[index]) !== 'assistant') continue
    const context = extractFromMessage(messages[index])
    if (!context) continue
    result = mergeContexts(result, context)
    if (isComplete(result)) return result
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const context = extractFromMessage(messages[index])
    if (!context) continue
    result = mergeContexts(result, context)
    if (isComplete(result)) return result
  }

  if (!result.agent && !result.model && !result.variant) return null
  return result
}
