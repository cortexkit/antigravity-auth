import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from './config'

describe('debug sink policy', () => {
  let originalDebugEnv: string | undefined
  let originalDebugTuiEnv: string | undefined

  beforeEach(() => {
    // Some neighboring test files leave fake timers active when they
    // finish (their final `it()` calls `jest.useFakeTimers()` without
    // restoring). Restore here so debug's tests run with real timers
    // and the runtime can exit cleanly between files.
    jest.useRealTimers()
    originalDebugEnv = process.env.OPENCODE_ANTIGRAVITY_DEBUG
    originalDebugTuiEnv = process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
    delete process.env.OPENCODE_ANTIGRAVITY_DEBUG
    delete process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
  })

  afterEach(() => {
    if (originalDebugEnv === undefined) {
      delete process.env.OPENCODE_ANTIGRAVITY_DEBUG
    } else {
      process.env.OPENCODE_ANTIGRAVITY_DEBUG = originalDebugEnv
    }

    if (originalDebugTuiEnv === undefined) {
      delete process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
    } else {
      process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI = originalDebugTuiEnv
    }
  })

  it('keeps debug_tui independent from debug in config', async () => {
    const {
      initializeDebug,
      isDebugEnabled,
      isDebugTuiEnabled,
      getLogFilePath,
    } = await import('./debug')

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: false,
      debug_tui: true,
    })

    expect(isDebugEnabled()).toBe(false)
    expect(isDebugTuiEnabled()).toBe(true)
    expect(getLogFilePath()).toBeUndefined()
  })

  it('keeps debug_tui independent from debug in env fallback', async () => {
    process.env.OPENCODE_ANTIGRAVITY_DEBUG = '0'
    process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI = '1'

    const { isDebugEnabled, isDebugTuiEnabled, getLogFilePath } = await import(
      './debug'
    )

    expect(isDebugEnabled()).toBe(false)
    expect(isDebugTuiEnabled()).toBe(true)
    expect(getLogFilePath()).toBeUndefined()
  })

  it('keeps file debug enabled without TUI when only debug is true', async () => {
    const {
      initializeDebug,
      isDebugEnabled,
      isDebugTuiEnabled,
      getLogFilePath,
    } = await import('./debug')

    // log_dir inside the isolated ANTIGRAVITY_TEST_ROOT so we don't touch the
    // host filesystem. The preloaded `OPENCODE_CONFIG_DIR` is also under
    // ANTIGRAVITY_TEST_ROOT, so the implicit `ensureGitignoreSync` call is
    // safe — nothing escapes the temp dir.
    const logDir = `${process.env.ANTIGRAVITY_TEST_ROOT}/opencode-antigravity-debug-tests`

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: true,
      debug_tui: false,
      log_dir: logDir,
    })

    expect(isDebugEnabled()).toBe(true)
    expect(isDebugTuiEnabled()).toBe(false)
    expect(getLogFilePath()).toContain('antigravity-debug-')
  })
})

describe('debug sink redaction', () => {
  let originalDebugEnv: string | undefined
  let originalDebugTuiEnv: string | undefined
  let logDir: string

  beforeEach(() => {
    // See note in 'debug sink policy' — neighboring files can leave fake
    // timers active at file boundaries. Restore here before any debug
    // test runs so background timers, WriteStream flushes, and the
    // event loop tear down behave predictably.
    jest.useRealTimers()
    originalDebugEnv = process.env.OPENCODE_ANTIGRAVITY_DEBUG
    originalDebugTuiEnv = process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
    delete process.env.OPENCODE_ANTIGRAVITY_DEBUG
    delete process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
    logDir = `${process.env.ANTIGRAVITY_TEST_ROOT}/redact-debug-${Math.random().toString(36).slice(2)}`
    mkdirSync(logDir, { recursive: true })
  })

  afterEach(() => {
    if (originalDebugEnv === undefined) {
      delete process.env.OPENCODE_ANTIGRAVITY_DEBUG
    } else {
      process.env.OPENCODE_ANTIGRAVITY_DEBUG = originalDebugEnv
    }
    if (originalDebugTuiEnv === undefined) {
      delete process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
    } else {
      process.env.OPENCODE_ANTIGRAVITY_DEBUG_TUI = originalDebugTuiEnv
    }
    rmSync(logDir, { recursive: true, force: true })
  })

  it('masks full project IDs in debug logs', async () => {
    const { initializeDebug, startAntigravityDebugRequest } = await import(
      './debug'
    )

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: true,
      debug_tui: false,
      log_dir: logDir,
    })

    const knownProjectId = 'my-project-1234567890abcdef'
    // The request body itself embeds a raw project ID — the verbatim
    // body preview must redact it too, not just the `projectId` meta.
    const bodyProjectId = 'secret-proj-123'
    startAntigravityDebugRequest({
      originalUrl: 'https://example.com/v1',
      resolvedUrl: 'https://example.com/v1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: bodyProjectId,
        model: 'gemini-3-pro',
      }),
      streaming: false,
      projectId: knownProjectId,
    })

    // Allow the writeStream a tick to flush the line.
    await new Promise((r) => setTimeout(r, 50))

    // The debug log file is the most recent `antigravity-debug-*.log` in
    // the log dir.
    const files = readdirSync(logDir)
    const logFile = files
      .filter((f) => f.startsWith('antigravity-debug-') && f.endsWith('.log'))
      .sort()
      .pop()
    expect(logFile).toBeTruthy()
    const contents = readFileSync(join(logDir, logFile!), 'utf8')

    // The full project ID must NOT appear in the log anywhere.
    expect(contents).not.toContain(knownProjectId)
    // The masked form should appear instead.
    expect(contents).toMatch(/my-p\*\*\*\*cdef/)
    // The body-embedded project ID must not leak verbatim either; the
    // redacted body preview carries the masked form.
    expect(contents).not.toContain(bodyProjectId)
    expect(contents).toMatch(/secr\*\*\*\*-123/)
  })

  it('masks fingerprint User-Agent headers in the recorded headers dump', async () => {
    const { initializeDebug, startAntigravityDebugRequest } = await import(
      './debug'
    )

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: true,
      debug_tui: false,
      log_dir: logDir,
    })

    const fingerprintUA =
      'antigravity/cli/1.1.6 (aidev_client; os_type=linux; arch=amd64; auth_method=consumer_full_ua)'

    startAntigravityDebugRequest({
      originalUrl: 'https://example.com/v1',
      resolvedUrl: 'https://example.com/v1',
      method: 'POST',
      headers: {
        'user-agent': fingerprintUA,
        'content-type': 'application/json',
      },
      body: '{}',
      streaming: false,
    })

    await new Promise((r) => setTimeout(r, 50))

    const files = readdirSync(logDir)
    const logFile = files
      .filter((f) => f.startsWith('antigravity-debug-') && f.endsWith('.log'))
      .sort()
      .pop()
    expect(logFile).toBeTruthy()
    const contents = readFileSync(join(logDir, logFile!), 'utf8')

    expect(contents).not.toContain(fingerprintUA)
    // The masked form should appear instead (anchored on the long UA).
    expect(contents).toMatch(/anti\*\*\*\*_ua\)/)
  })
})
