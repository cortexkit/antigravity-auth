/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug controls file logs only (via debug.ts)
 * - debug_tui controls TUI log panel only
 * - either sink can be enabled independently
 * - OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 → console output (independent of debug flags)
 * - operator.log_level filters the level at which log entries are emitted
 */

import { setLogSink } from '@cortexkit/antigravity-auth-core'
import {
  type ChannelLogger,
  createLoggerInstance,
} from '../common-auth-embedded/logger/index.js'
import { isProviderSecretKey } from '../logging/provider-key-policy'
import { isDebugTuiEnabled } from './debug'
import { isTruthyFlag, writeConsoleLog } from './logging-utils'
import type { OperatorSettings } from './operator-settings'
import type { PluginClient } from './types'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ENV_CONSOLE_LOG = 'OPENCODE_ANTIGRAVITY_CONSOLE_LOG'

const LOG_LEVEL_FROM_OPERATOR: Record<OperatorSettings['log_level'], LogLevel> =
  {
    error: 'error',
    warn: 'warn',
    info: 'info',
    debug: 'debug',
    trace: 'debug',
  }

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

let _client: PluginClient | null = null
let _configuredLevel: LogLevel = 'debug'

// Sink-only mode scrubs before forwarding and owns no file buffer or timer.
// The dynamic floor also applies to channels created before initialization.
const providerLogger = createLoggerInstance({
  level: () => _configuredLevel,
  extraSecretKeys: isProviderSecretKey,
  captureSink: ({ channel, level, message, data }) => {
    const extra =
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? Object.fromEntries(Object.entries(data))
        : undefined
    emitLog(channel, level === 'trace' ? 'debug' : level, message, extra)
  },
})

/**
 * Set the runtime log level. Reads from the operator settings controller
 * on each call so a /antigravity-logging dialog flip takes effect
 * immediately. Falls back to "debug" when the operator level is not
 * yet known.
 */
export function setRuntimeLogLevel(level: OperatorSettings['log_level']): void {
  _configuredLevel = LOG_LEVEL_FROM_OPERATOR[level] ?? 'debug'
}

/**
 * Initialize the logger with the plugin client.
 * Must be called during plugin initialization to enable TUI logging.
 */
export function initLogger(client: PluginClient): void {
  _client = client
  // Route core (@cortexkit/antigravity-auth-core) logs into the same TUI/console
  // sinks the OpenCode logger uses, so logs from migrated core modules surface.
  setLogSink(({ service, level, message, extra }) => {
    providerLogger.createLogger(service)[level](message, extra)
  })
}

/**
 * Create a logger instance for a specific module.
 *
 * @param module - The module name (e.g., "refresh-queue", "transform.claude")
 * @returns Logger instance with debug, info, warn, error methods
 *
 * @example
 * ```typescript
 * const log = createLogger("refresh-queue");
 * log.debug("Checking tokens", { count: 5 });
 * log.warn("Token expired", { accountIndex: 0 });
 * ```
 */
function emitLog(
  service: string,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  // TUI logging: controlled only by debug_tui policy
  if (isDebugTuiEnabled()) {
    const app = _client?.app
    if (app && typeof app.log === 'function') {
      try {
        app
          .log({
            body: { service, level, message, extra },
          })
          .catch(() => {
            // Silently ignore logging errors
          })
      } catch {
        // A synchronous host failure must not suppress the independent console.
      }
    }
  }

  // Console fallback: when env var is set (independent of debug flags)
  if (isConsoleLogEnabled()) {
    const prefix = `[${service}]`
    const args = extra ? [prefix, message, extra] : [prefix, message]
    try {
      writeConsoleLog(level, ...args)
    } catch {
      // Logging failures must not escape into provider operations.
    }
  }
  // If neither TUI nor console logging is enabled, log is silently discarded
}

function isConsoleLogEnabled(): boolean {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG])
}

export function createLogger(module: string): Logger {
  // Channel names must be static nonsecret module names, never identifiers.
  const service = `antigravity.${module}`
  let channel: ChannelLogger | undefined
  // Debug/config/storage can create channels while this module is still being
  // evaluated through a cycle. Defer touching the engine until the first log.
  const log = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    channel ??= providerLogger.createLogger(service)
    channel[level](message, extra)
  }
  return {
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
  }
}
