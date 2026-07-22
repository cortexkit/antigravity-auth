/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug controls file logs only (via debug.ts)
 * - debug_tui controls TUI log panel only
 * - either sink can be enabled independently
 * - OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 → console output (independent of debug flags)
 */

import { setLogSink } from '@cortexkit/antigravity-auth-core'
import { isDebugTuiEnabled } from './debug'
import { isTruthyFlag, writeConsoleLog } from './logging-utils'
import type { PluginClient } from './types'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ENV_CONSOLE_LOG = 'OPENCODE_ANTIGRAVITY_CONSOLE_LOG'

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

let _client: PluginClient | null = null

/**
 * Check if console logging is enabled via environment variable.
 */
function isConsoleLogEnabled(): boolean {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG])
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
    emitLog(service, level as LogLevel, message, extra)
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
      app
        .log({
          body: { service, level, message, extra },
        })
        .catch(() => {
          // Silently ignore logging errors
        })
    }
  }

  // Console fallback: when env var is set (independent of debug flags)
  if (isConsoleLogEnabled()) {
    const prefix = `[${service}]`
    const args = extra ? [prefix, message, extra] : [prefix, message]
    writeConsoleLog(level, ...args)
  }
  // If neither TUI nor console logging is enabled, log is silently discarded
}

export function createLogger(module: string): Logger {
  const service = `antigravity.${module}`

  const log = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    emitLog(service, level, message, extra)
  }

  return {
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
  }
}
