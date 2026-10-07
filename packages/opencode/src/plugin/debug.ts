import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import type { AntigravityConfig } from './config'
import {
  deriveDebugPolicy,
  formatAccountContextLabel,
  formatAccountLabel,
  formatBodyPreviewForLog,
  formatErrorForLog,
  isTruthyFlag,
  redactBodyForLog,
  redactSensitive,
  redactSensitiveFields,
  truncateTextForLog,
} from './logging-utils'
import { ensureGitignoreSync } from './storage'

const MAX_BODY_PREVIEW_CHARS = 12000
const MAX_BODY_LOG_CHARS = 50000

export const DEBUG_MESSAGE_PREFIX = '[opencode-antigravity-auth debug]'

// =============================================================================
// Debug State
// =============================================================================

/** The configuration fields that decide one location's debug sinks. */
export type DebugConfig = Pick<
  AntigravityConfig,
  'debug' | 'debug_tui' | 'log_dir'
>

interface DebugState {
  debugEnabled: boolean
  debugTuiEnabled: boolean
  logFilePath: string | undefined
  logWriter: (line: string) => void
  /**
   * Owning stream for the underlying file (when debug is enabled). It is
   * closed when the owner closes or replaces its debug state so repeated
   * initialization does not leak file descriptors; the OS-level "file
   * descriptor" alone does not keep the process alive, but the writeStream's
   * underlying socket pair does, and a long-lived test suite can starve.
   */
  logStream: import('node:fs').WriteStream | null
}

/**
 * Debug log files currently open in this process. Two locations that enable
 * file debug in the same millisecond would otherwise derive the same
 * timestamped name and interleave lines in one file, and log cleanup must
 * never delete a file another live location is still writing.
 */
const liveLogFilePaths = new Set<string>()

/**
 * Get the OS-specific config directory.
 */
function getConfigDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    return join(
      env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'opencode',
    )
  }
  const xdgConfig = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

/**
 * Returns the logs directory, creating it if needed.
 */
function getLogsDir(customLogDir?: string): string {
  const logsDir = customLogDir || join(getConfigDir(), 'antigravity-logs')

  try {
    // Debug logs can contain prompt/response bodies — keep them user-only.
    mkdirSync(logsDir, { recursive: true, mode: 0o700 })
  } catch {
    // Directory may already exist or we don't have permission
  }

  return logsDir
}

/**
 * Builds a timestamped log file path that no live location already owns.
 */
function createLogFilePath(customLogDir?: string): string {
  const logsDir = getLogsDir(customLogDir)
  cleanupOldLogs(logsDir, 25)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let candidate = join(logsDir, `antigravity-debug-${timestamp}.log`)
  for (let suffix = 2; liveLogFilePaths.has(candidate); suffix++) {
    candidate = join(logsDir, `antigravity-debug-${timestamp}-${suffix}.log`)
  }
  return candidate
}

/**
 * Cleans up old log files, keeping only the most recent maxFiles. Files a
 * live location is writing are never deleted.
 */
function cleanupOldLogs(logsDir: string, maxFiles: number): void {
  try {
    const files = readdirSync(logsDir)
      .filter(
        (file) =>
          file.startsWith('antigravity-debug-') && file.endsWith('.log'),
      )
      .map((file) => join(logsDir, file))

    if (files.length <= maxFiles) {
      return
    }

    const sortedFiles = files
      .map((file) => ({
        file,
        mtime: statSync(file).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)

    for (let i = maxFiles; i < sortedFiles.length; i++) {
      const file = sortedFiles[i]!.file
      if (liveLogFilePaths.has(file)) continue
      try {
        unlinkSync(file)
      } catch {
        // Ignore deletion errors
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Creates a log writer function that writes to a file.
 */
function createLogWriter(filePath?: string): {
  writer: (line: string) => void
  stream: import('node:fs').WriteStream | null
} {
  if (!filePath) {
    return { writer: () => {}, stream: null }
  }

  try {
    const stream = createWriteStream(filePath, { flags: 'a', mode: 0o600 })
    stream.on('error', () => {})
    liveLogFilePaths.add(filePath)
    return {
      stream,
      writer: (line: string) => {
        const timestamp = new Date().toISOString()
        const formatted = `[${timestamp}] ${line}`
        stream.write(`${formatted}\n`)
      },
    }
  } catch {
    return { writer: () => {}, stream: null }
  }
}

/**
 * Derive debug state from a configuration, or from the environment alone
 * when no configuration is supplied (the OpenCode 1 pre-initialization
 * fallback).
 */
function createDebugState(config: DebugConfig | null): DebugState {
  if (!config) {
    const { debugEnabled } = deriveDebugPolicy({
      configDebug: false,
      configDebugTui: false,
      envDebugFlag: env.OPENCODE_ANTIGRAVITY_DEBUG,
      envDebugTuiFlag: env.OPENCODE_ANTIGRAVITY_DEBUG_TUI,
    })
    const debugTuiEnabled = isTruthyFlag(env.OPENCODE_ANTIGRAVITY_DEBUG_TUI)
    const logFilePath = debugEnabled ? createLogFilePath() : undefined
    const { writer: logWriter, stream: logStream } =
      createLogWriter(logFilePath)
    return {
      debugEnabled,
      debugTuiEnabled,
      logFilePath,
      logWriter,
      logStream,
    }
  }

  // Config takes precedence, but env var can force enable for debugging
  const envDebugFlag = env.OPENCODE_ANTIGRAVITY_DEBUG ?? ''
  const { debugEnabled } = deriveDebugPolicy({
    configDebug: config.debug,
    configDebugTui: config.debug_tui,
    envDebugFlag,
    envDebugTuiFlag: env.OPENCODE_ANTIGRAVITY_DEBUG_TUI,
  })
  const debugTuiEnabled =
    config.debug_tui || isTruthyFlag(env.OPENCODE_ANTIGRAVITY_DEBUG_TUI)
  const logFilePath = debugEnabled
    ? createLogFilePath(config.log_dir)
    : undefined
  const { writer: logWriter, stream: logStream } = createLogWriter(logFilePath)

  if (debugEnabled) {
    ensureGitignoreSync(getConfigDir())
  }

  return {
    debugEnabled,
    debugTuiEnabled,
    logFilePath,
    logWriter,
    logStream,
  }
}

/** Close a state's stream without waiting (state replacement path). */
function endDebugStream(state: DebugState | null): void {
  const current = state?.logStream
  if (!current || !state) return
  state.logStream = null
  if (state.logFilePath) liveLogFilePaths.delete(state.logFilePath)
  try {
    current.end()
  } catch {
    // best-effort; the stream is already detached
  }
}

/**
 * Close a state's stream and resolve once all buffered writes have been
 * flushed to disk. Lines logged afterwards are dropped.
 */
function closeDebugStream(state: DebugState | null): Promise<void> {
  const current = state?.logStream
  if (!current || !state) return Promise.resolve()
  // Detach the reference so a later close or replacement won't double-close.
  state.logStream = null
  state.logWriter = () => {}
  if (state.logFilePath) liveLogFilePaths.delete(state.logFilePath)
  return new Promise<void>((resolve) => {
    current.once('close', () => resolve())
    current.once('error', () => resolve())
    try {
      current.end()
    } catch {
      resolve()
    }
  })
}

// =============================================================================
// Location debug handle
// =============================================================================

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

export interface AccountDebugInfo {
  index: number
  email?: string
  family: string
  totalAccounts: number
  rateLimitState?: { claude?: number; gemini?: number }
}

export interface RateLimitBodyInfo {
  message?: string
  quotaResetTime?: string
  retryDelayMs?: number | null
  reason?: string
}

/**
 * One location's debug sinks: its own file, debug/debug_tui policy and
 * request counter. Every method writes only to this location's file.
 */
export interface LocationDebug {
  isDebugEnabled(): boolean
  isDebugTuiEnabled(): boolean
  getLogFilePath(): string | undefined
  startAntigravityDebugRequest(
    meta: AntigravityDebugRequestMeta,
  ): AntigravityDebugContext | null
  logAntigravityDebugResponse(
    context: AntigravityDebugContext | null | undefined,
    response: Response,
    meta?: AntigravityDebugResponseMeta,
  ): void
  logAccountContext(label: string, info: AccountDebugInfo): void
  logRateLimitEvent(
    accountIndex: number,
    email: string | undefined,
    family: string,
    status: number,
    retryAfterMs: number,
    bodyInfo: RateLimitBodyInfo,
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
  ): Promise<string | undefined>
  logModelFamily(
    url: string,
    extractedModel: string | null,
    family: string,
  ): void
  debugLogToFile(message: string): void
  logToast(
    message: string,
    variant: 'info' | 'warning' | 'success' | 'error',
  ): void
  logRetryAttempt(
    attempt: number,
    maxAttempts: number,
    reason: string,
    delayMs?: number,
  ): void
  logCacheStats(
    model: string,
    cacheReadTokens: number,
    cacheWriteTokens: number,
    totalInputTokens: number,
  ): void
  logQuotaStatus(
    accountEmail: string | undefined,
    accountIndex: number,
    quotaPercent: number,
    family?: string,
  ): void
  logQuotaFetch(
    event: 'start' | 'complete' | 'error',
    accountCount?: number,
    details?: string,
  ): void
  logModelUsed(
    requestedModel: string,
    actualModel: string,
    accountEmail?: string,
  ): void
  /**
   * Flush and close this location's log file. Idempotent; lines logged
   * afterwards are dropped rather than reopening the file.
   */
  close(): Promise<void>
}

interface RequestCounter {
  value: number
}

function createDebugHandle(
  readState: () => DebugState,
  counter: RequestCounter,
  closeState: () => Promise<void>,
): LocationDebug {
  const logDebug = (line: string): void => {
    readState().logWriter(line)
  }
  const runWithDebugEnabled = (action: () => void): void => {
    if (!readState().debugEnabled) return
    action()
  }

  return {
    isDebugEnabled: () => readState().debugEnabled,
    isDebugTuiEnabled: () => readState().debugTuiEnabled,
    getLogFilePath: () => readState().logFilePath,

    startAntigravityDebugRequest(meta) {
      const state = readState()
      if (!state.debugEnabled) {
        return null
      }

      const id = `ANTIGRAVITY-${++counter.value}`
      const method = meta.method ?? 'GET'
      logDebug(
        `[Antigravity Debug ${id}] pid=${process.pid} ${method} ${meta.resolvedUrl}`,
      )
      if (meta.originalUrl && meta.originalUrl !== meta.resolvedUrl) {
        logDebug(`[Antigravity Debug ${id}] Original URL: ${meta.originalUrl}`)
      }
      if (meta.projectId) {
        logDebug(
          `[Antigravity Debug ${id}] Project: ${redactSensitive(meta.projectId)}`,
        )
      }
      logDebug(
        `[Antigravity Debug ${id}] Streaming: ${meta.streaming ? 'yes' : 'no'}`,
      )
      logDebug(
        `[Antigravity Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`,
      )
      // The request body embeds raw project IDs — redact credential-shaped
      // fields before the verbatim preview hits the log.
      const bodyPreview = formatBodyPreviewForLog(
        redactBodyForLog(meta.body),
        MAX_BODY_PREVIEW_CHARS,
      )
      if (bodyPreview) {
        logDebug(`[Antigravity Debug ${id}] Body Preview: ${bodyPreview}`)
      }

      return { id, streaming: meta.streaming, startedAt: Date.now() }
    },

    logAntigravityDebugResponse(context, response, meta = {}) {
      const state = readState()
      if (!state.debugEnabled || !context) {
        return
      }

      const durationMs = Date.now() - context.startedAt
      logDebug(
        `[Antigravity Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`,
      )
      logDebug(
        `[Antigravity Debug ${context.id}] Response Headers: ${JSON.stringify(
          maskHeaders(meta.headersOverride ?? response.headers),
        )}`,
      )

      if (meta.note) {
        logDebug(`[Antigravity Debug ${context.id}] Note: ${meta.note}`)
      }

      if (meta.error) {
        logDebug(
          `[Antigravity Debug ${context.id}] Error: ${formatErrorForLog(meta.error)}`,
        )
      }

      if (meta.body) {
        logDebug(
          `[Antigravity Debug ${context.id}] Response Body Preview: ${truncateTextForLog(meta.body, MAX_BODY_PREVIEW_CHARS)}`,
        )
      }
    },

    logAccountContext(label, info) {
      runWithDebugEnabled(() => {
        const accountLabel = formatAccountContextLabel(info.email, info.index)

        const indexLabel =
          info.index >= 0
            ? `${info.index + 1}/${info.totalAccounts}`
            : `-/${info.totalAccounts}`

        let rateLimitInfo = ''
        if (
          info.rateLimitState &&
          Object.keys(info.rateLimitState).length > 0
        ) {
          const now = Date.now()
          const activeRateLimits: Record<string, string> = {}
          for (const [key, resetTime] of Object.entries(info.rateLimitState)) {
            if (typeof resetTime === 'number' && resetTime > now) {
              const remainingSec = Math.ceil((resetTime - now) / 1000)
              activeRateLimits[key] = `${remainingSec}s`
            }
          }
          if (Object.keys(activeRateLimits).length > 0) {
            rateLimitInfo = ` rateLimits=${JSON.stringify(activeRateLimits)}`
          }
        }

        logDebug(
          `[Account] ${label}: ${accountLabel} (${indexLabel}) family=${info.family}${rateLimitInfo}`,
        )
      })
    },

    logRateLimitEvent(
      accountIndex,
      email,
      family,
      status,
      retryAfterMs,
      bodyInfo,
    ) {
      runWithDebugEnabled(() => {
        const accountLabel = formatAccountLabel(email, accountIndex)
        logDebug(
          `[RateLimit] ${status} on ${accountLabel} family=${family} retryAfterMs=${retryAfterMs}`,
        )
        if (bodyInfo.message) {
          logDebug(`[RateLimit] message: ${bodyInfo.message}`)
        }
        if (bodyInfo.quotaResetTime) {
          logDebug(`[RateLimit] quotaResetTime: ${bodyInfo.quotaResetTime}`)
        }
        if (
          bodyInfo.retryDelayMs !== undefined &&
          bodyInfo.retryDelayMs !== null
        ) {
          logDebug(`[RateLimit] body retryDelayMs: ${bodyInfo.retryDelayMs}`)
        }
        if (bodyInfo.reason) {
          logDebug(`[RateLimit] reason: ${bodyInfo.reason}`)
        }
      })
    },

    logRateLimitSnapshot(family, accounts) {
      runWithDebugEnabled(() => {
        const now = Date.now()
        const entries = accounts.map((account) => {
          const label = formatAccountLabel(account.email, account.index)
          const reset =
            account.rateLimitResetTimes?.[family as 'claude' | 'gemini']
          if (typeof reset !== 'number') {
            return `${label}=ready`
          }
          const remaining = Math.max(0, reset - now)
          const seconds = Math.ceil(remaining / 1000)
          return `${label}=wait ${seconds}s`
        })
        logDebug(`[RateLimit] snapshot family=${family} ${entries.join(' | ')}`)
      })
    },

    async logResponseBody(context, response, status) {
      const state = readState()
      if (!state.debugEnabled || !context) return undefined

      try {
        const text = await response.clone().text()
        const preview = truncateTextForLog(text, MAX_BODY_LOG_CHARS)
        logDebug(
          `[Antigravity Debug ${context.id}] Response Body (${status}): ${preview}`,
        )
        return text
      } catch (e) {
        logDebug(
          `[Antigravity Debug ${context.id}] Failed to read response body: ${formatErrorForLog(e)}`,
        )
        return undefined
      }
    },

    logModelFamily(url, extractedModel, family) {
      runWithDebugEnabled(() => {
        logDebug(
          `[ModelFamily] url=${url} model=${extractedModel ?? 'unknown'} family=${family}`,
        )
      })
    },

    debugLogToFile(message) {
      runWithDebugEnabled(() => {
        logDebug(message)
      })
    },

    logToast(message, variant) {
      runWithDebugEnabled(() => {
        const variantLabel = variant.toUpperCase()
        logDebug(`[Toast/${variantLabel}] ${message}`)
      })
    },

    logRetryAttempt(attempt, maxAttempts, reason, delayMs) {
      runWithDebugEnabled(() => {
        const delayInfo = delayMs !== undefined ? ` delay=${delayMs}ms` : ''
        const maxInfo = maxAttempts < 0 ? '∞' : maxAttempts.toString()
        logDebug(
          `[Retry] Attempt ${attempt}/${maxInfo} reason=${reason}${delayInfo}`,
        )
      })
    },

    logCacheStats(model, cacheReadTokens, cacheWriteTokens, totalInputTokens) {
      runWithDebugEnabled(() => {
        const cacheHitRate =
          totalInputTokens > 0
            ? Math.round((cacheReadTokens / totalInputTokens) * 100)
            : 0
        const status =
          cacheReadTokens > 0 ? 'HIT' : cacheWriteTokens > 0 ? 'WRITE' : 'MISS'
        logDebug(
          `[Cache] ${status} model=${model} read=${cacheReadTokens} write=${cacheWriteTokens} total=${totalInputTokens} hitRate=${cacheHitRate}%`,
        )
      })
    },

    logQuotaStatus(accountEmail, accountIndex, quotaPercent, family) {
      runWithDebugEnabled(() => {
        const accountLabel = formatAccountLabel(accountEmail, accountIndex)
        const familyInfo = family ? ` family=${family}` : ''
        const status =
          quotaPercent <= 0 ? 'EXHAUSTED' : quotaPercent < 20 ? 'LOW' : 'OK'
        logDebug(
          `[Quota] ${accountLabel} remaining=${quotaPercent.toFixed(1)}% status=${status}${familyInfo}`,
        )
      })
    },

    logQuotaFetch(event, accountCount, details) {
      runWithDebugEnabled(() => {
        const countInfo =
          accountCount !== undefined ? ` accounts=${accountCount}` : ''
        const detailsInfo = details ? ` ${details}` : ''
        logDebug(
          `[QuotaFetch] ${event.toUpperCase()}${countInfo}${detailsInfo}`,
        )
      })
    },

    logModelUsed(requestedModel, actualModel, accountEmail) {
      runWithDebugEnabled(() => {
        const accountInfo = accountEmail ? ` account=${accountEmail}` : ''
        if (requestedModel !== actualModel) {
          logDebug(
            `[Model] requested=${requestedModel} actual=${actualModel}${accountInfo}`,
          )
        } else {
          logDebug(`[Model] ${actualModel}${accountInfo}`)
        }
      })
    },

    close: closeState,
  }
}

/**
 * Build one server location's debug sinks from its own configuration. The
 * handle owns its log file and request counter; it never reads or replaces
 * the OpenCode 1 module-level debug state below, and closing it leaves every
 * other location's file open.
 */
export function createLocationDebug(config: DebugConfig): LocationDebug {
  const state = createDebugState(config)
  return createDebugHandle(
    () => state,
    { value: 0 },
    () => closeDebugStream(state),
  )
}

/**
 * Obscures sensitive headers and returns a plain object for logging.
 */
function maskHeaders(headers?: HeadersInit | Headers): Record<string, string> {
  if (!headers) {
    return {}
  }

  const result: Record<string, string> = {}
  const SENSITIVE_HEADERS = new Set([
    'authorization',
    'x-api-key',
    'x-goog-api-key',
    'cookie',
    'set-cookie',
  ])
  const parsed = headers instanceof Headers ? headers : new Headers(headers)
  parsed.forEach((value, key) => {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      result[key] = '[redacted]'
    } else if (key.toLowerCase() === 'user-agent') {
      // Fingerprint User-Agent strings are stable identifiers that
      // could be replayed. Mask the body but keep the header shape
      // so the log still tells operators a UA was sent.
      result[key] = redactSensitive(value)
    } else {
      result[key] = value
    }
  })
  return redactSensitiveFields(result) as Record<string, string>
}

// =============================================================================
// OpenCode 1 single-location binding
//
// The functions below keep the OpenCode 1 composition's existing calls
// working until it adopts a location debug handle. They operate on one
// module-level state, lazily initialized from the environment, which no
// location handle reads or replaces.
// =============================================================================

let debugState: DebugState | null = null
const legacyRequestCounter: RequestCounter = { value: 0 }

/**
 * Get the current OpenCode 1 debug state, initializing with defaults if
 * needed. This allows the module to work even before initializeDebug is
 * called.
 */
function getDebugState(): DebugState {
  debugState ??= createDebugState(null)
  return debugState
}

const legacyDebug = createDebugHandle(getDebugState, legacyRequestCounter, () =>
  closeDebugLog(),
)

/**
 * Close the OpenCode 1 debug log stream and resolve once all buffered writes
 * have been flushed to disk. Tests use this to wait deterministically for
 * log lines before reading the log file.
 */
export function closeDebugLog(): Promise<void> {
  const state = debugState
  const current = state?.logStream
  if (!state || !current) return Promise.resolve()
  // Detach the reference so reinitialization won't double-close.
  state.logStream = null
  if (state.logFilePath) liveLogFilePaths.delete(state.logFilePath)
  return new Promise<void>((resolve) => {
    current.once('close', () => resolve())
    current.once('error', () => resolve())
    try {
      current.end()
    } catch {
      resolve()
    }
  })
}

/**
 * Initialize or reinitialize the OpenCode 1 debug state with the given
 * config. Call this once at plugin startup after loading config.
 */
export function initializeDebug(config: AntigravityConfig): void {
  // Close any previously opened log stream so re-initialized state
  // does not leak file descriptors (each open writeStream keeps the
  // process alive through its duplex pair).
  endDebugStream(debugState)
  debugState = createDebugState(config)
}

export function isDebugEnabled(): boolean {
  return legacyDebug.isDebugEnabled()
}

export function isDebugTuiEnabled(): boolean {
  return legacyDebug.isDebugTuiEnabled()
}

export function getLogFilePath(): string | undefined {
  return legacyDebug.getLogFilePath()
}

/**
 * Begins a debug trace for an Antigravity request.
 */
export function startAntigravityDebugRequest(
  meta: AntigravityDebugRequestMeta,
): AntigravityDebugContext | null {
  return legacyDebug.startAntigravityDebugRequest(meta)
}

/**
 * Logs response details for a previously started debug trace.
 */
export function logAntigravityDebugResponse(
  context: AntigravityDebugContext | null | undefined,
  response: Response,
  meta: AntigravityDebugResponseMeta = {},
): void {
  legacyDebug.logAntigravityDebugResponse(context, response, meta)
}

export function logAccountContext(label: string, info: AccountDebugInfo): void {
  legacyDebug.logAccountContext(label, info)
}

export function logRateLimitEvent(
  accountIndex: number,
  email: string | undefined,
  family: string,
  status: number,
  retryAfterMs: number,
  bodyInfo: RateLimitBodyInfo,
): void {
  legacyDebug.logRateLimitEvent(
    accountIndex,
    email,
    family,
    status,
    retryAfterMs,
    bodyInfo,
  )
}

export function logRateLimitSnapshot(
  family: string,
  accounts: Array<{
    index: number
    email?: string
    rateLimitResetTimes?: { claude?: number; gemini?: number }
  }>,
): void {
  legacyDebug.logRateLimitSnapshot(family, accounts)
}

export async function logResponseBody(
  context: AntigravityDebugContext | null | undefined,
  response: Response,
  status: number,
): Promise<string | undefined> {
  return legacyDebug.logResponseBody(context, response, status)
}

export function logModelFamily(
  url: string,
  extractedModel: string | null,
  family: string,
): void {
  legacyDebug.logModelFamily(url, extractedModel, family)
}

export function debugLogToFile(message: string): void {
  legacyDebug.debugLogToFile(message)
}

/**
 * Logs a toast message to the debug file.
 * This helps correlate what the user saw with debug events.
 */
export function logToast(
  message: string,
  variant: 'info' | 'warning' | 'success' | 'error',
): void {
  legacyDebug.logToast(message, variant)
}

/**
 * Logs retry attempt information.
 * @param maxAttempts - Use -1 for unlimited retries
 */
export function logRetryAttempt(
  attempt: number,
  maxAttempts: number,
  reason: string,
  delayMs?: number,
): void {
  legacyDebug.logRetryAttempt(attempt, maxAttempts, reason, delayMs)
}

/**
 * Logs cache hit/miss information from response usage metadata.
 */
export function logCacheStats(
  model: string,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  totalInputTokens: number,
): void {
  legacyDebug.logCacheStats(
    model,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens,
  )
}

/**
 * Logs quota status for an account.
 */
export function logQuotaStatus(
  accountEmail: string | undefined,
  accountIndex: number,
  quotaPercent: number,
  family?: string,
): void {
  legacyDebug.logQuotaStatus(accountEmail, accountIndex, quotaPercent, family)
}

/**
 * Logs background quota fetch events.
 */
export function logQuotaFetch(
  event: 'start' | 'complete' | 'error',
  accountCount?: number,
  details?: string,
): void {
  legacyDebug.logQuotaFetch(event, accountCount, details)
}

/**
 * Logs which model is being used for a request.
 */
export function logModelUsed(
  requestedModel: string,
  actualModel: string,
  accountEmail?: string,
): void {
  legacyDebug.logModelUsed(requestedModel, actualModel, accountEmail)
}
