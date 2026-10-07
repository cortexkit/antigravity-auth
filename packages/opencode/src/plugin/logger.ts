/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug controls file logs only (via debug.ts)
 * - debug_tui controls the host log destination only
 * - either sink can be enabled independently
 * - OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 → console output (independent of debug flags)
 * - operator.log_level filters the level at which log entries are emitted
 *
 * Every server location builds its own logger with `createLocationLogger`:
 * its own level, host sink and debug_tui policy, over its own instance of the
 * embedded public logger (same scrubber and provider key policy). Creating a
 * location logger never installs the core package's process-wide log sink;
 * a location hands `coreLogSink` to the core objects it constructs instead.
 *
 * The module-level `initLogger`, `setRuntimeLogLevel` and `createLogger`
 * below are the OpenCode 1 composition's single-location binding. They keep
 * working unchanged until that composition adopts a location logger; no
 * location logger reads or writes them.
 */

import { setLogSink } from '@cortexkit/antigravity-auth-core'
import { createLoggerInstance } from '../common-auth-embedded/logger/index.js'
import { isProviderSecretKey } from '../logging/provider-key-policy'
import type { OperatorSettings } from './config/operator-settings-schema'
import { isDebugTuiEnabled } from './debug'
import { isTruthyFlag, writeConsoleLog } from './logging-utils'
import type {
  AppLogClient,
  LocationLogLevel,
  LocationLogRecord,
  LocationLogSink,
} from './neutral-types'

type LogLevel = LocationLogLevel

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

export interface LocationLoggerOptions {
  /**
   * Host destination for this location's records. Without one, records reach
   * only the environment-gated console fallback.
   */
  sink?: LocationLogSink
  /**
   * This location's debug_tui policy, read on every record: the sink receives
   * a record only while it returns true.
   */
  sinkEnabled: () => boolean
  /** Initial operator log level. Without one the floor is debug. */
  level?: OperatorSettings['log_level']
}

export interface LocationLogger {
  /**
   * A logger for a static module name, such as refresh-queue. Channel names
   * are not scrubbed; do not put account or session IDs in them.
   */
  createLogger(module: string): Logger
  /** Apply this location's operator log level to its next records. */
  setLevel(level: OperatorSettings['log_level']): void
  /**
   * Sink for core-package objects this location constructs (for example an
   * account manager's `logSink` option). Records are scrubbed and routed
   * through this location's level and destinations, never another's.
   */
  readonly coreLogSink: (record: LocationLogRecord) => void
}

/** Build one location's independent logger. */
export function createLocationLogger(
  options: LocationLoggerOptions,
): LocationLogger {
  let configuredLevel: LogLevel = options.level
    ? (LOG_LEVEL_FROM_OPERATOR[options.level] ?? 'debug')
    : 'debug'

  const emit = (record: LocationLogRecord): void => {
    // Host destination: controlled only by this location's debug_tui policy.
    if (options.sink && options.sinkEnabled()) {
      try {
        const pending = options.sink(record)
        if (isThenable(pending)) {
          pending.then(undefined, () => {
            // Silently ignore logging errors
          })
        }
      } catch {
        // A synchronous host failure must not suppress the independent console.
      }
    }

    // Console fallback: when env var is set (independent of debug flags)
    if (isConsoleLogEnabled()) {
      const prefix = `[${record.service}]`
      const args = record.extra
        ? [prefix, record.message, record.extra]
        : [prefix, record.message]
      try {
        writeConsoleLog(record.level, ...args)
      } catch {
        // Logging failures must not escape into provider operations.
      }
    }
    // If neither destination is enabled, the record is silently discarded.
  }

  // The library scrubs records before forwarding them to the capture sink;
  // it owns no file buffer or timer. Each channel reads the current level.
  const engine = createLoggerInstance({
    level: () => configuredLevel,
    extraSecretKeys: isProviderSecretKey,
    captureSink: ({ channel, level, message, data }) => {
      const extra =
        data !== null && typeof data === 'object' && !Array.isArray(data)
          ? Object.fromEntries(Object.entries(data))
          : undefined
      emit({
        service: channel,
        level: level === 'trace' ? 'debug' : level,
        message,
        extra,
      })
    },
  })

  return {
    createLogger(module) {
      const channel = engine.createLogger(`antigravity.${module}`)
      return {
        debug: (message, extra) => channel.debug(message, extra),
        info: (message, extra) => channel.info(message, extra),
        warn: (message, extra) => channel.warn(message, extra),
        error: (message, extra) => channel.error(message, extra),
      }
    },
    setLevel(level) {
      configuredLevel = LOG_LEVEL_FROM_OPERATOR[level] ?? 'debug'
    },
    coreLogSink: ({ service, level, message, extra }) => {
      engine.createLogger(service)[level](message, extra)
    },
  }
}

/**
 * Adapt a host client's `app.log` into a location log sink (OpenCode 1).
 * A client without `app.log` makes the sink a no-op.
 */
export function createAppLogSink(client: AppLogClient): LocationLogSink {
  return (record) => {
    const app = client.app
    if (app && typeof app.log === 'function') {
      return app.log({ body: record })
    }
    return undefined
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function isConsoleLogEnabled(): boolean {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG])
}

// =============================================================================
// OpenCode 1 single-location binding
// =============================================================================

let legacyClient: AppLogClient | null = null
let legacyLogger: LocationLogger | undefined

// Created on first use: debug/config/storage can create channels while this
// module is still being evaluated through an import cycle.
function getLegacyLogger(): LocationLogger {
  legacyLogger ??= createLocationLogger({
    sink: (record) =>
      legacyClient ? createAppLogSink(legacyClient)(record) : undefined,
    sinkEnabled: isDebugTuiEnabled,
  })
  return legacyLogger
}

/**
 * Set the OpenCode 1 logger's level from the supplied operator level.
 * Existing channels use the updated level on their next log call.
 * Use debug when the supplied level has no mapping.
 */
export function setRuntimeLogLevel(level: OperatorSettings['log_level']): void {
  getLegacyLogger().setLevel(level)
}

/**
 * Bind the OpenCode 1 logger to the plugin client.
 * Called during OpenCode 1 plugin initialization to enable TUI logging.
 * Server locations use `createLocationLogger` and never call this.
 */
export function initLogger(client: AppLogClient): void {
  legacyClient = client
  // Route core (@cortexkit/antigravity-auth-core) logs into the same TUI/console
  // sinks the OpenCode 1 logger uses, so logs from migrated core modules surface.
  setLogSink(getLegacyLogger().coreLogSink)
}

/**
 * Create an OpenCode 1 logger for a static module name, such as
 * refresh-queue. Its debug, info, warn and error methods share the current
 * minimum level.
 */
export function createLogger(module: string): Logger {
  let channel: Logger | undefined
  // Defer touching the engine until the first log (see getLegacyLogger).
  const log = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    channel ??= getLegacyLogger().createLogger(module)
    channel[level](message, extra)
  }
  return {
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
  }
}
