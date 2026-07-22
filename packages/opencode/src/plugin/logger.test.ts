import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { DEFAULT_CONFIG } from './config'
import type { PluginClient } from './types'

describe('logger sink routing', () => {
  beforeEach(() => {
    // Each test re-imports the modules to start with a clean debug state.
  })

  afterEach(async () => {
    const { initializeDebug } = await import('./debug')
    initializeDebug(DEFAULT_CONFIG)
  })

  it('routes logs to TUI when debug_tui is enabled without file debug', async () => {
    const { initializeDebug } = await import('./debug')
    const { createLogger, initLogger } = await import('./logger')

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: false,
      debug_tui: true,
    })

    const appLog = mock().mockResolvedValue(undefined)
    const client = {
      app: {
        log: appLog,
      },
    } as unknown as PluginClient

    initLogger(client)

    createLogger('request').debug('thinking-resolution', { status: 429 })

    expect(appLog).toHaveBeenCalledTimes(1)
    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: 'antigravity.request',
        level: 'debug',
        message: 'thinking-resolution',
        extra: { status: 429 },
      },
    })
  })

  it('does not route to TUI when only file debug is enabled', async () => {
    const { initializeDebug } = await import('./debug')
    const { createLogger, initLogger } = await import('./logger')

    const logDir = `${process.env.ANTIGRAVITY_TEST_ROOT}/opencode-antigravity-logger-tests`

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: true,
      debug_tui: false,
      log_dir: logDir,
    })

    const appLog = mock().mockResolvedValue(undefined)
    const client = {
      app: {
        log: appLog,
      },
    } as unknown as PluginClient

    initLogger(client)

    createLogger('request').debug('file-only')

    expect(appLog).not.toHaveBeenCalled()
  })
})
