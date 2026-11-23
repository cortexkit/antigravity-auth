import type { AccountSelectionStrategy } from '../account-types.ts'
import type { AgyRequestScope } from '../agy-request-metadata.ts'
import type { FloorKeying, KillswitchSettings } from './killswitch.ts'

/** The executor reads these values from the adapter's location, not the settings file. */
export interface RequestConfig {
  quiet_mode: boolean
  toast_scope: 'root_only' | 'all'
  max_account_switches?: number
  max_rate_limit_wait_seconds?: number
  soft_quota_cache_ttl_minutes: number | 'auto'
  quota_refresh_interval_minutes: number
  soft_quota_threshold_percent: number
  account_selection_strategy: AccountSelectionStrategy
  pid_offset_enabled: boolean
  cache_warmup_on_switch: boolean
  thinking_warmup: boolean
  claude_tool_hardening: boolean
  claude_prompt_auto_caching: boolean
  request_jitter_max_ms: number
  default_retry_after_seconds?: number
  max_backoff_seconds?: number
  scheduling_mode: 'cache_first' | 'balance' | 'performance_first'
  max_cache_first_wait_seconds: number
  switch_on_first_rate_limit: boolean
  failure_ttl_seconds: number
  switch_account_delay_ms?: number
  proactive_rotation_threshold_percent?: number
  empty_response_max_attempts?: number
  empty_response_retry_delay_ms?: number
}

/** Selection observes operator changes without opening the host's settings file. */
export interface RequestOperatorSettings {
  get(): KillswitchSettings
  floorKeying?(): FloorKeying
}

export interface RequestSessionIdentity {
  sessionId: string | null
  parentSessionId: string | null
}

/** The adapter owns both the session metadata registry and any legacy header interpretation. */
export interface RequestSessions {
  beginRequest(identity: RequestSessionIdentity): AgyRequestScope
}

export interface AntigravityDebugContext {
  id: string
  streaming: boolean
  startedAt: number
}

export interface AntigravityDebugRequestMeta {
  originalUrl: string
  resolvedUrl: string
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  streaming: boolean
  projectId?: string
}

export interface AntigravityDebugResponseMeta {
  body?: string
  note?: string
  error?: unknown
  headersOverride?: HeadersInit
}

/** Diagnostics follow the location that sent the request, not a process default. */
export interface RequestDebug {
  isDebugEnabled(): boolean
  startAntigravityDebugRequest(
    meta: AntigravityDebugRequestMeta,
  ): AntigravityDebugContext | null
  logAntigravityDebugResponse(
    context: AntigravityDebugContext | null | undefined,
    response: Response,
    meta?: AntigravityDebugResponseMeta,
  ): void
  logAccountContext(
    label: string,
    info: {
      index: number
      email?: string
      family: string
      totalAccounts: number
      rateLimitState?: { claude?: number; gemini?: number }
    },
  ): void
  logRateLimitEvent(
    accountIndex: number,
    email: string | undefined,
    family: string,
    status: number,
    retryAfterMs: number,
    bodyInfo: {
      message?: string
      quotaResetTime?: string
      retryDelayMs?: number | null
      reason?: string
    },
  ): void
  logRateLimitSnapshot(
    family: string,
    accounts: Array<{
      index: number
      email?: string
      rateLimitResetTimes?: { claude?: number; gemini?: number }
    }>,
  ): void
  logResponseBody(
    context: AntigravityDebugContext | null | undefined,
    response: Response,
    status: number,
    redact?: (text: string) => string,
  ): Promise<string | undefined>
  logModelFamily(
    url: string,
    extractedModel: string | null,
    family: string,
  ): void
}

export interface RequestLogger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  /** Vault send attribution may reach a separate host sink. */
  hostInfo?(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface GeminiDumpContext {
  id: string
  files: { request: string; response: string; metadata: string }
  metadata: Record<string, unknown>
}

export interface GeminiDumpRequestInput {
  originalUrl: string
  resolvedUrl: string
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  streaming: boolean
  requestedModel?: string
  effectiveModel?: string
  sessionId?: string
  projectId?: string
}

/** The adapter controls whether and where wire diagnostics write to disk. */
export interface RequestDump {
  dumpRequest(input: GeminiDumpRequestInput): GeminiDumpContext | null
  noteResponse(
    context: GeminiDumpContext | null | undefined,
    response: Response,
  ): void
}

export interface ResponseDump extends Pick<RequestDump, 'noteResponse'> {
  appendResponseText(
    context: GeminiDumpContext | null | undefined,
    text: string,
  ): void
  createResponseTransform(
    context: GeminiDumpContext | null | undefined,
  ): TransformStream<Uint8Array, Uint8Array> | null
}

/** The adapter owns the output directory and whether images are saved at all. */
export type SaveResponseImage = (inlineData: {
  mimeType?: string
  data?: string
}) => string | null
