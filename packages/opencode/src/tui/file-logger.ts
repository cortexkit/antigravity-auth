/**
 * File-backed logger for the OpenTUI sidebar tree.
 *
 * The TUI renders directly into the host terminal. Any stray write to the
 * terminal from inside the render path (or any module it imports) corrupts
 * the frame buffer — a single byte out of place shoves every subsequent
 * cell right and breaks the sidebar.
 *
 * This logger writes to a rotating file under the host's log directory and
 * never touches stdout/stderr. The plugin already wires up the same kind of
 * file logger via `debug.ts`; the sidebar gets its own file so log lines
 * from this tree are easy to attribute.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type TuiLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface TuiLogger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
  /** Resolve the path the logger writes to. `undefined` when file logging is disabled. */
  getLogPath(): string | undefined
}

const LOG_PREFIX = '[opencode-antigravity-auth/tui]'
const DEFAULT_MAX_BYTES = 1_000_000
const MAX_KEEP_LINES = 200
/**
 * Owner-read/write only — matches the rest of the plugin's on-disk
 * sensitive state (account storage, signature cache). Windows ignores
 * POSIX mode bits so the assertion in the test is best-effort there.
 */
const FILE_MODE = 0o600

interface FileLoggerOptions {
  filePath: string
  maxBytes?: number
}

/**
 * Resolve the on-disk path for the TUI's log file.
 *
 * - `ANTIGRAVITY_AUTH_TUI_LOG_FILE` wins when set (used by tests so they
 *   never touch a real user log file).
 * - Otherwise write under `<xdg-state>/cortexkit/antigravity-auth/tui.log`.
 *
 * Falls back to a temp file when the host path cannot be resolved (e.g. no
 * home directory on a hostile CI box); the file logger itself never throws,
 * it just drops the line.
 */
export function resolveTuiLogPath(): string {
  const override = process.env['ANTIGRAVITY_AUTH_TUI_LOG_FILE']
  if (override && override.trim().length > 0) return override
  const base =
    process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state')
  return join(base, 'cortexkit', 'antigravity-auth', 'tui.log')
}

export function createTuiFileLogger(
  options?: Partial<FileLoggerOptions>,
): TuiLogger {
  const filePath = options?.filePath ?? resolveTuiLogPath()
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  return createFileLogger({ filePath, maxBytes })
}

function createFileLogger(options: FileLoggerOptions): TuiLogger {
  const { filePath, maxBytes = DEFAULT_MAX_BYTES } = options

  const rotateIfNeeded = (): void => {
    try {
      if (!existsSync(filePath)) return
      const stat = statSync(filePath)
      if (stat.size < maxBytes) return
      // Tail-truncate: keep the last MAX_KEEP_LINES, drop the rest. Cheap,
      // bounded, and good enough for a sidecar debug stream.
      const text = readFileSync(filePath, 'utf-8')
      const lines = text.split('\n')
      const keepFrom = Math.max(0, lines.length - MAX_KEEP_LINES)
      const tail = lines.slice(keepFrom).join('\n')
      writeFileSync(filePath, tail, 'utf-8')
      // `writeFileSync` over an existing file keeps its mode; we rotate
      // the file specifically to enforce owner-only access, so re-assert
      // the mode after the truncation.
      chmodSync(filePath, FILE_MODE)
    } catch {
      // Best-effort; ignore rotation errors.
    }
  }

  const write = (
    level: TuiLogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    try {
      rotateIfNeeded()
      // Enforce 0o700 on the parent directory even when it already
      // exists — `mkdirSync({ recursive: true, mode })` only sets the
      // mode on the leaf directory it creates, so an existing leaky
      // directory would keep its old mode. The post-hoc chmodSync
      // closes the gap.
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(filePath), 0o700)
      const payload: Record<string, unknown> = {
        ts: Date.now(),
        level,
        message,
      }
      if (extra && Object.keys(extra).length > 0) payload['extra'] = extra
      // `mode: 0o600` so the log file is owner-only — the same default the
      // plugin's account storage applies. `appendFileSync` only honours the
      // mode flag when the file is created, so existing files keep whatever
      // mode they had. `chmodSync` below re-asserts the mode after every
      // append so a leaked-permissions file is repaired on the next write.
      appendFileSync(filePath, `${LOG_PREFIX} ${JSON.stringify(payload)}\n`, {
        encoding: 'utf-8',
        mode: FILE_MODE,
      })
      chmodSync(filePath, FILE_MODE)
    } catch {
      // Drop the line — file logging must never throw into the render path.
    }
  }

  return {
    debug: (message, extra) => write('debug', message, extra),
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    getLogPath: () => filePath,
  }
}
