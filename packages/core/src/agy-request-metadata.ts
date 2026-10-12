import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { getAgyNativeModel } from './model-registry.ts'

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV1A_64_PRIME = 0x100000001b3n
const DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_SESSION_STATES = 256

const AGY_REQUEST_FIELD_ORDER = [
  'contents',
  'systemInstruction',
  'tools',
  'toolConfig',
  'labels',
  'generationConfig',
  'sessionId',
] as const

export interface AgyRequestSessionContext {
  conversationId: string
  trajectoryId: string
  numericSessionId: string
  usedClaude?: boolean
  usedNonGeminiModel?: boolean
  lastExecutionId?: string
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
  last_execution_id?: string
  last_step_index: string
  model_enum?: string
  trajectory_id: string
  used_claude: 'true' | 'false'
  used_claude_conservative: 'true' | 'false'
  used_non_gemini_model: 'true' | 'false'
}

export interface AgyAgentRequestMetadata {
  requestId: string
  sessionId: string
  labels: AgyRequestLabels
  lastStepIndex: number
}

export interface AgyAgentRequestMetadataOptions {
  stepCountMode?: 'parts' | 'contents' | 'cli'
}

export function fnv1a64Signed(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  for (const byte of Buffer.from(input, 'utf8')) {
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

  constructor(
    workspaceUri: string,
    options: AgyRequestSessionStoreOptions = {},
  ) {
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
    const timestamp = Math.max(
      stored.lastAccessedAt,
      stored.lastRequestTimestamp + 1,
    )
    stored.lastRequestTimestamp = timestamp
    return { session, timestamp }
  }

  completeExecution(key: string): void {
    const stored = this.entries.get(key)
    if (stored) {
      stored.context.lastExecutionId = randomUUID()
    }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
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

    while (
      this.entries.size >= this.maxEntries &&
      !this.entries.has(preservedKey)
    ) {
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

// Historical metadata remains readable; host admission refuses these retired routes.
const HISTORICAL_AGY_MODEL_ENUMS: Readonly<Record<string, string>> = {
  'claude-sonnet-4-6': 'MODEL_PLACEHOLDER_M35',
  'claude-opus-4-6-thinking': 'MODEL_PLACEHOLDER_M26',
}

export function getAgyModelEnum(model: string): string | undefined {
  const lower = model.toLowerCase()
  return getAgyNativeModel(lower)?.model ?? HISTORICAL_AGY_MODEL_ENUMS[lower]
}

export function orderAgyRequestPayloadInPlace(
  payload: Record<string, unknown>,
): void {
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

export function countAgyRequestSteps(
  payload: Record<string, unknown>,
  mode: 'parts' | 'contents' | 'cli' = 'parts',
): number {
  const contents = payload.contents
  if (!Array.isArray(contents)) return 1
  if (mode === 'contents') return Math.max(1, contents.length)

  let partCount = 0
  let functionResponseCount = 0
  for (const content of contents) {
    if (!content || typeof content !== 'object' || Array.isArray(content))
      continue
    const parts = (content as Record<string, unknown>).parts
    if (!Array.isArray(parts)) continue
    partCount += parts.length
    if (mode === 'cli') {
      functionResponseCount += parts.filter((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part))
          return false
        return 'functionResponse' in part
      }).length
    }
  }

  if (mode === 'cli') {
    return Math.max(1, contents.length + functionResponseCount)
  }
  return Math.max(1, partCount)
}

export function buildAgyAgentRequestMetadata(
  session: AgyRequestSessionContext,
  payload: Record<string, unknown>,
  model: string,
  timestamp = Date.now(),
  options: AgyAgentRequestMetadataOptions = {},
): AgyAgentRequestMetadata {
  const lastStepIndex =
    countAgyRequestSteps(payload, options.stepCountMode) +
    (session.lastExecutionId ? 1 : 0)
  const isClaude = model.toLowerCase().startsWith('claude-')
  const isNonGemini = isClaude || model.toLowerCase().startsWith('gpt-')
  session.usedClaude = session.usedClaude === true || isClaude
  session.usedNonGeminiModel =
    session.usedNonGeminiModel === true || isNonGemini
  const modelEnum = getAgyModelEnum(model)
  const labels: AgyRequestLabels = {
    ...(session.lastExecutionId
      ? { last_execution_id: session.lastExecutionId }
      : {}),
    last_step_index: String(lastStepIndex),
    ...(modelEnum ? { model_enum: modelEnum } : {}),
    trajectory_id: session.trajectoryId,
    used_claude: session.usedClaude ? 'true' : 'false',
    used_claude_conservative: session.usedClaude ? 'true' : 'false',
    used_non_gemini_model: session.usedNonGeminiModel ? 'true' : 'false',
  }

  return {
    requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
    sessionId: session.numericSessionId,
    labels,
    lastStepIndex,
  }
}
