/**
 * Tests for the TUI file logger.
 *
 * Verifies the file-backed logger:
 * - creates the log directory and writes JSON lines,
 * - rotates the file when it grows past the configured threshold,
 * - creates the log file with mode 0o600 (owner-only) — same as the rest
 *   of the plugin's on-disk sensitive state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTuiFileLogger } from './file-logger'

const isWindows = process.platform === 'win32'

interface Fixture {
  root: string
  logPath: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agy-tui-logger-'))
  const logPath = join(root, 'logs/tui.log')
  return {
    root,
    logPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('createTuiFileLogger', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('writes JSON lines and creates the parent directory', () => {
    const logger = createTuiFileLogger({ filePath: fixture.logPath })
    logger.info('hello', { a: 1 })
    logger.warn('careful')

    const stat = statSync(fixture.logPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('returns the configured log path from getLogPath()', () => {
    const logger = createTuiFileLogger({ filePath: fixture.logPath })
    expect(logger.getLogPath()).toBe(fixture.logPath)
  })

  it('rotates the file when it grows past maxBytes', () => {
    const logger = createTuiFileLogger({
      filePath: fixture.logPath,
      maxBytes: 1024,
    })
    // Each line is roughly 130 bytes; 500 lines is ~65 KiB, well above
    // the rotation threshold. After rotation we expect the file to be
    // bounded by MAX_KEEP_LINES (200) of those lines, regardless of how
    // many we wrote.
    for (let i = 0; i < 500; i += 1) {
      logger.info(`entry-${i.toString().padStart(4, '0')}-${'x'.repeat(40)}`)
    }
    const stat = statSync(fixture.logPath)
    expect(stat.size).toBeLessThan(1024 * 50)
  })

  it.skipIf(isWindows)(
    'creates the log file with mode 0o600 (owner-only)',
    () => {
      const logger = createTuiFileLogger({ filePath: fixture.logPath })
      logger.info('mode-check')
      const mode = statSync(fixture.logPath).mode & 0o777
      expect(mode).toBe(0o600)
    },
  )

  it.skipIf(isWindows)('re-asserts 0o600 after rotation', () => {
    // Pre-create the file with a permissive mode so we can prove the
    // logger tightens it back to 0o600 during rotation.
    mkdirSync(join(fixture.logPath, '..'), { recursive: true })
    const f = Bun.file(fixture.logPath)
    // Use Bun's writer to create a 4 KiB file (above the rotation
    // threshold we'll pass to the logger) with mode 0o644.
    Bun.write(f, 'x'.repeat(4096))
    chmodSync(fixture.logPath, 0o644)

    const logger = createTuiFileLogger({
      filePath: fixture.logPath,
      maxBytes: 256,
    })
    logger.info('after-rotation')

    const mode = statSync(fixture.logPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('survives an unwritable target by dropping the line silently', () => {
    // A path under a non-existent device — the mkdir/appendFile pair will
    // throw, but the logger must swallow the error and return cleanly.
    const impossible = '\u0000/nope/cannot/write/here/tui.log'
    const logger = createTuiFileLogger({ filePath: impossible })
    expect(() => logger.error('dropped')).not.toThrow()
    expect(existsSync(impossible)).toBe(false)
  })
})
