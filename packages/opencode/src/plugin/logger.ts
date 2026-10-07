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

// The library scrubs records before forwarding them to our TUI/console callback;
// it owns no file buffer or timer. Each channel reads the current minimum level.
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
 * Set the runtime log level from the supplied operator level.
 * Existing channels use the updated level on their next log call.
 * Use debug when the supplied level has no mapping.
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

/** Forward a scrubbed record to the independently enabled destinations. */
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

/**
 * Create a logger for a static module name, such as refresh-queue.
 * Its debug, info, warn and error methods share the current minimum level.
 */
export function createLogger(module: string): Logger {
  // Channel names are not scrubbed; do not put account or session IDs in them.
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
