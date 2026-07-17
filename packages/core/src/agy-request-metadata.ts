import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV1A_64_PRIME = 0x100000001b3n
const DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_SESSION_STATES = 256

const AGY_REQUEST_FIELD_ORDER = [
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "labels",
  "generationConfig",
  "sessionId",
] as const

const AGY_MODEL_ENUM_BY_WIRE_MODEL: Readonly<Record<string, string>> = {
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  "gemini-3.1-flash-image": "MODEL_PLACEHOLDER_M21",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
}

export interface AgyRequestSessionContext {
  conversationId: string
  trajectoryId: string
  numericSessionId: string
  usedClaude?: boolean
  usedNonGeminiModel?: boolean
}

interface StoredAgyRequestSession {
  context: AgyRequestSessionContext
  lastAccessedAt: number
  lastRequestTimestamp: number
}

export interface AgyRequestSessionStoreOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

export interface AgyRequestScope {
  session: AgyRequestSessionContext
  timestamp: number
}

export interface AgyRequestLabels {
  last_step_index: string
  model_enum?: string
  trajectory_id: string
  used_claude: "true" | "false"
  used_claude_conservative: "true" | "false"
  used_non_gemini_model: "true" | "false"
}

export interface AgyAgentRequestMetadata {
  requestId: string
  sessionId: string
  labels: AgyRequestLabels
  lastStepIndex: number
}

export function fnv1a64Signed(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME)
  }
  return BigInt.asIntN(64, hash).toString()
}

export function createAgyRequestSessionContext(
  workspaceUri: string,
  ids: { conversationId?: string; trajectoryId?: string } = {},
): AgyRequestSessionContext {
  return {
    conversationId: ids.conversationId ?? randomUUID(),
    trajectoryId: ids.trajectoryId ?? randomUUID(),
    numericSessionId: fnv1a64Signed(workspaceUri),
  }
}

export class AgyRequestSessionStore {
  private readonly entries = new Map<string, StoredAgyRequestSession>()
  private readonly workspaceUri: string
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(workspaceUri: string, options: AgyRequestSessionStoreOptions = {}) {
    this.workspaceUri = workspaceUri
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_STATE_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_STATES
    this.now = options.now ?? Date.now
  }

  getOrCreate(key: string): AgyRequestSessionContext {
    const timestamp = this.now()
    this.prune(timestamp, key)

    const existing = this.entries.get(key)
    if (existing) {
      existing.lastAccessedAt = timestamp
      return existing.context
    }

    const context = createAgyRequestSessionContext(this.workspaceUri)
    this.entries.set(key, {
      context,
      lastAccessedAt: timestamp,
      lastRequestTimestamp: 0,
    })
    return context
  }

  beginRequest(key: string): AgyRequestScope {
    const session = this.getOrCreate(key)
    const stored = this.entries.get(key)!
    const timestamp = Math.max(stored.lastAccessedAt, stored.lastRequestTimestamp + 1)
    stored.lastRequestTimestamp = timestamp
    return { session, timestamp }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }

  private prune(timestamp: number, preservedKey: string): void {
    const expiry = timestamp - this.ttlMs
    for (const [key, value] of this.entries) {
      if (key !== preservedKey && value.lastAccessedAt < expiry) {
        this.entries.delete(key)
      }
    }

    while (this.entries.size >= this.maxEntries && !this.entries.has(preservedKey)) {
      let oldestKey: string | null = null
      let oldestAccess = Number.POSITIVE_INFINITY
      for (const [key, value] of this.entries) {
        if (key !== preservedKey && value.lastAccessedAt < oldestAccess) {
          oldestKey = key
          oldestAccess = value.lastAccessedAt
        }
      }
      if (!oldestKey) {
        break
      }
      this.entries.delete(oldestKey)
    }
  }
}

export function getAgyModelEnum(model: string): string | undefined {
  return AGY_MODEL_ENUM_BY_WIRE_MODEL[model.toLowerCase()]
}

export function orderAgyRequestPayloadInPlace(payload: Record<string, unknown>): void {
  const ordered: Record<string, unknown> = {}
  const remaining = new Set(Object.keys(payload))

  for (const key of AGY_REQUEST_FIELD_ORDER) {
    if (key in payload) {
      ordered[key] = payload[key]
      remaining.delete(key)
    }
  }
  for (const key of remaining) {
    ordered[key] = payload[key]
  }

  for (const key of Object.keys(payload)) {
    delete payload[key]
  }
  Object.assign(payload, ordered)
}

export function countAgyRequestSteps(payload: Record<string, unknown>): number {
  const contents = payload.contents
  if (!Array.isArray(contents)) {
    return 1
  }

  let partCount = 0
  for (const content of contents) {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      continue
    }
    const parts = (content as Record<string, unknown>).parts
    if (Array.isArray(parts)) {
      partCount += parts.length
    }
  }
  return Math.max(1, partCount)
}

export function buildAgyAgentRequestMetadata(
  session: AgyRequestSessionContext,
  payload: Record<string, unknown>,
  model: string,
  timestamp = Date.now(),
): AgyAgentRequestMetadata {
  const lastStepIndex = countAgyRequestSteps(payload)
  const isClaude = model.toLowerCase().startsWith("claude-")
  const isNonGemini = isClaude || model.toLowerCase().startsWith("gpt-")
  session.usedClaude = session.usedClaude === true || isClaude
  session.usedNonGeminiModel = session.usedNonGeminiModel === true || isNonGemini
  const modelEnum = getAgyModelEnum(model)
  const labels: AgyRequestLabels = {
    last_step_index: String(lastStepIndex),
    ...(modelEnum ? { model_enum: modelEnum } : {}),
    trajectory_id: session.trajectoryId,
    used_claude: session.usedClaude ? "true" : "false",
    used_claude_conservative: session.usedClaude ? "true" : "false",
    used_non_gemini_model: session.usedNonGeminiModel ? "true" : "false",
  }

  return {
    requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
    sessionId: session.numericSessionId,
    labels,
    lastStepIndex,
  }
}
