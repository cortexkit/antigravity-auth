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
  requestCount?: number
  lastMetadataTimestamp?: number
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
  cascade_id: string
  last_execution_id?: string
  last_step_index: string
  model_enum?: string
  request_id: string
  root_cascade_id: string
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

export function fnv1a64Signed(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME)
  }
  return BigInt.asIntN(64, hash).toString()
}

export function createAgyRequestSessionContext(
  ids: { conversationId?: string; trajectoryId?: string } = {},
): AgyRequestSessionContext {
  return {
    conversationId: ids.conversationId ?? randomUUID(),
    trajectoryId: ids.trajectoryId ?? randomUUID(),
    // Print-mode agy uses the empty-string offset basis in every workspace.
    numericSessionId: fnv1a64Signed(''),
  }
}

export class AgyRequestSessionStore {
  private readonly entries = new Map<string, StoredAgyRequestSession>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: AgyRequestSessionStoreOptions = {}) {
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

    const context = createAgyRequestSessionContext()
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
  'gemini-3.5-flash-extra-low': 'MODEL_PLACEHOLDER_M187',
  'gemini-3.5-flash-low': 'MODEL_PLACEHOLDER_M20',
  'gemini-3-flash-agent': 'MODEL_PLACEHOLDER_M84',
  'gemini-3.1-pro-low': 'MODEL_PLACEHOLDER_M36',
  'gemini-3.1-pro-high': 'MODEL_PLACEHOLDER_M37',
  'gemini-pro-agent': 'MODEL_PLACEHOLDER_M16',
  'gemini-3.6-flash-low': 'MODEL_PLACEHOLDER_M73',
  'gemini-3.6-flash-medium': 'MODEL_PLACEHOLDER_M72',
  'gemini-3.6-flash-high': 'MODEL_PLACEHOLDER_M71',
  'gemini-3.7-flash-low': 'MODEL_PLACEHOLDER_M300',
  'gemini-3.7-flash-medium': 'MODEL_PLACEHOLDER_M299',
  'gemini-3.7-flash-high': 'MODEL_PLACEHOLDER_M298',
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

export function countAgyRequestSteps(payload: Record<string, unknown>): number {
  return Array.isArray(payload.contents) ? payload.contents.length : 0
}

function hasSecondUserTurn(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.contents)) return false
  // Claude tool responses are user-role contents, but do not start a new turn.
  let sawUser = false
  let sawModelAfterUser = false
  for (const content of payload.contents) {
    if (content?.role === 'model' && sawUser) sawModelAfterUser = true
    if (content?.role !== 'user' || !Array.isArray(content.parts)) continue
    const isPrompt = content.parts.some(
      (part: unknown) =>
        part !== null &&
        typeof part === 'object' &&
        !('functionResponse' in part) &&
        (!('text' in part) || part.text !== '[Continue]'),
    )
    if (!isPrompt) continue
    if (sawModelAfterUser) return true
    sawUser = true
  }
  return false
}

export function buildAgyAgentRequestMetadata(
  session: AgyRequestSessionContext,
  payload: Record<string, unknown>,
  model: string,
  timestamp?: number,
): AgyAgentRequestMetadata {
  // Retries reuse an explicitly supplied timestamp. Otherwise allocate a fresh
  // timestamp so the request counter advances even within one clock millisecond.
  const requestTimestamp =
    timestamp ?? Math.max(Date.now(), (session.lastMetadataTimestamp ?? 0) + 1)
  const stepCount = countAgyRequestSteps(payload)
  const lastStepIndex = stepCount - 1
  // A retry reuses its allocated timestamp and must not advance the generation
  // counter or rotate the execution ID. Tool continuations get their own
  // request timestamp and advance the generation counter.
  if (session.lastMetadataTimestamp !== requestTimestamp) {
    session.requestCount = (session.requestCount ?? 0) + 1
    session.lastMetadataTimestamp = requestTimestamp
    if (session.lastExecutionId || hasSecondUserTurn(payload)) {
      session.lastExecutionId = randomUUID()
    }
  }
  const isClaude = model.toLowerCase().startsWith('claude-')
  const isNonGemini = isClaude || model.toLowerCase().startsWith('gpt-')
  session.usedClaude = session.usedClaude === true || isClaude
  session.usedNonGeminiModel =
    session.usedNonGeminiModel === true || isNonGemini
  const modelEnum = getAgyModelEnum(model)
  const labels: AgyRequestLabels = {
    cascade_id: session.conversationId,
    ...(session.lastExecutionId
      ? { last_execution_id: session.lastExecutionId }
      : {}),
    last_step_index: String(lastStepIndex),
    ...(modelEnum ? { model_enum: modelEnum } : {}),
    request_id: `${session.trajectoryId}-${(session.requestCount ?? 1) - 1}`,
    root_cascade_id: session.conversationId,
    trajectory_id: session.trajectoryId,
    used_claude: session.usedClaude ? 'true' : 'false',
    used_claude_conservative: session.usedClaude ? 'true' : 'false',
    used_non_gemini_model: session.usedNonGeminiModel ? 'true' : 'false',
  }

  return {
    requestId: `agent/${session.conversationId}/${requestTimestamp}/${session.trajectoryId}/${stepCount}`,
    sessionId: session.numericSessionId,
    labels,
    lastStepIndex,
  }
}
