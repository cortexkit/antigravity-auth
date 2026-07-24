/**
 * Harness-agnostic structured logger for the Antigravity core.
 *
 * Core code never talks to a specific harness UI. Instead it emits log
 * records to a pluggable sink. Harnesses (OpenCode, pi) register their own
 * sink via `setLogSink()` to route logs into their TUI/log panel. When no
 * sink is registered, an env-gated console fallback is used.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface LogRecord {
  service: string
  level: LogLevel
  message: string
  extra?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

const ENV_CONSOLE_LOG = 'ANTIGRAVITY_CORE_CONSOLE_LOG'

let _sink: LogSink | null = null

/**
 * Register the harness-specific log sink. Pass `null` to clear it.
 */
export function setLogSink(sink: LogSink | null): void {
  _sink = sink
}

function isTruthyFlag(flag?: string): boolean {
  return flag === '1' || flag?.toLowerCase() === 'true'
}

function isConsoleLogEnabled(): boolean {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG])
}

function writeConsoleLog(level: LogLevel, ...args: unknown[]): void {
  switch (level) {
    case 'debug':
      console.debug(...args)
      break
    case 'info':
      console.info(...args)
      break
    case 'warn':
      console.warn(...args)
      break
    case 'error':
      console.error(...args)
      break
  }
}

/**
 * Create a logger for a specific module. Records are forwarded to the
 * registered sink, with an env-gated console fallback.
 */
export function createLogger(module: string): Logger {
  const service = `antigravity.${module}`

  const log = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    if (_sink) {
      try {
        _sink({ service, level, message, extra })
      } catch {
        // Never let logging failures break core logic.
      }
    }

    if (isConsoleLogEnabled()) {
      const prefix = `[${service}]`
      const args = extra ? [prefix, message, extra] : [prefix, message]
      writeConsoleLog(level, ...args)
    }
  }

  return {
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
  }
}
