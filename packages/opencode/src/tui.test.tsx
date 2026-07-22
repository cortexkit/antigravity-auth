/** @jsxImportSource @opentui/solid */

/**
 * Tests for the OpenTUI sidebar component.
 *
 * These run through `@opentui/solid/preload` (see `bunfig.toml`) so the
 * Solid JSX inside `tui.tsx` is transformed by `@opentui/solid/scripts/solid-transform`
 * the same way production hosts transform it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/solid'
import {
  DEFAULT_SIDEBAR_STATE,
  SIDEBAR_STATE_ENV,
  SIDEBAR_STATE_VERSION,
  type SidebarStateV1,
} from './sidebar-state'
import { SidebarPanel } from './tui'
import type { TuiLogger } from './tui/file-logger'

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  extra?: Record<string, unknown>
}

function makeCapturingLogger(): TuiLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const record = (
    level: LogEntry['level'],
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    entries.push({ level, message, extra })
  }
  return {
    entries,
    debug: (m, e) => record('debug', m, e),
    info: (m, e) => record('info', m, e),
    warn: (m, e) => record('warn', m, e),
    error: (m, e) => record('error', m, e),
    getLogPath: () => undefined,
  }
}

interface Fixture {
  statePath: string
  logPath: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agy-tui-test-'))
  const statePath = join(root, 'sidebar-state.json')
  const logPath = join(root, 'tui.log')
  process.env[SIDEBAR_STATE_ENV] = statePath
  process.env['ANTIGRAVITY_AUTH_TUI_LOG_FILE'] = logPath
  return {
    statePath,
    logPath,
    cleanup: () => {
      delete process.env[SIDEBAR_STATE_ENV]
      delete process.env['ANTIGRAVITY_AUTH_TUI_LOG_FILE']
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeState(state: Partial<SidebarStateV1>): SidebarStateV1 {
  const merged: SidebarStateV1 = {
    ...DEFAULT_SIDEBAR_STATE,
    ...state,
    version: SIDEBAR_STATE_VERSION,
  }
  return merged
}

async function settle(): Promise<void> {
  // Two microtask flushes + a short timer to let the polling interval and
  // reactive render complete before snapshotting.
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

describe('SidebarPanel', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('renders the awaiting-state fallback when no state file exists', async () => {
    const logger = makeCapturingLogger()
    const testSetup = await testRender(() => <SidebarPanel logger={logger} />, {
      width: 60,
      height: 12,
    })
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain('Awaiting Antigravity state')
    testSetup.renderer.destroy()
  })

  it('renders accounts, health, cooldown, and quota bars when state is loaded', async () => {
    const future = Date.now() + 5 * 60 * 1000
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Primary',
          enabled: true,
          health: 85,
          current: true,
          cooldownUntil: future,
          quota: {
            claude: { remainingPercent: 75 },
            'gemini-pro': { remainingPercent: 30, resetAt: future },
            'gemini-flash': { remainingPercent: 10 },
          },
        },
        {
          id: 'acc-2',
          label: 'Backup',
          enabled: false,
          health: 42,
          current: false,
          quota: {
            claude: { remainingPercent: 60 },
          },
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const logger = makeCapturingLogger()
    const testSetup = await testRender(
      () => <SidebarPanel logger={logger} stateFile={fixture.statePath} />,
      {
        width: 60,
        height: 24,
      },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain('Primary')
    expect(frame).toContain('Backup')
    expect(frame).toContain('health')
    expect(frame).toContain('cooldown')
    expect(frame).toContain('Claude')
    expect(frame).toContain('Gemini Pro')
    expect(frame).toContain('Gemini Flash')
    expect(frame).toContain('75%')
    expect(frame).toContain('30%')
    expect(frame).toContain('10%')
    expect(frame).toContain('60%')
    testSetup.renderer.destroy()
  })

  it('renders the active session route and routing status', async () => {
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Primary',
          enabled: true,
          health: 80,
          current: true,
          quota: {},
        },
      ],
      activeRouting: {
        'session-abc': {
          accountId: 'acc-1',
          modelFamily: 'claude',
          headerStyle: 'antigravity',
          updatedAt: Date.now(),
        },
      },
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const logger = makeCapturingLogger()
    const testSetup = await testRender(
      () => <SidebarPanel logger={logger} stateFile={fixture.statePath} />,
      {
        width: 80,
        height: 16,
      },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain('routing')
    expect(frame).toContain('claude')
    expect(frame).toContain('Primary')
    expect(frame).toContain('antigravity')
    testSetup.renderer.destroy()
  })

  it('marks the snapshot stale when checkedAt is older than the freshness window', async () => {
    const stale = Date.now() - 60_000
    const payload = writeState({
      checkedAt: stale,
      routingAuthoritative: true,
      accounts: [
        {
          id: 'acc-1',
          label: 'Old Account',
          enabled: true,
          health: 80,
          current: true,
          quota: {},
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const logger = makeCapturingLogger()
    const testSetup = await testRender(
      () => <SidebarPanel logger={logger} stateFile={fixture.statePath} />,
      {
        width: 80,
        height: 16,
      },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain('stale routing snapshot')
    testSetup.renderer.destroy()
  })

  it('renders the backoff footer when quotaBackoffUntil is in the future', async () => {
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      quotaBackoffUntil: Date.now() + 60_000,
      accounts: [
        {
          id: 'acc-1',
          label: 'Cooldown Account',
          enabled: true,
          health: 80,
          current: true,
          quota: {},
        },
      ],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const logger = makeCapturingLogger()
    const testSetup = await testRender(
      () => <SidebarPanel logger={logger} stateFile={fixture.statePath} />,
      {
        width: 80,
        height: 16,
      },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain('quota backoff')
    testSetup.renderer.destroy()
  })

  it('clears the polling timer on unmount (no leaked intervals)', async () => {
    const payload = writeState({
      checkedAt: Date.now(),
      routingAuthoritative: true,
      accounts: [],
    })
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')

    const logger = makeCapturingLogger()
    const testSetup = await testRender(
      () => (
        <SidebarPanel
          logger={logger}
          stateFile={fixture.statePath}
          pollIntervalMs={50}
        />
      ),
      {
        width: 40,
        height: 10,
      },
    )
    await testSetup.flush()
    // Snapshot a baseline of polls before teardown.
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    testSetup.renderer.destroy()
    // If the interval leaked, the test runner's lingering timers would emit
    // log entries or affect subsequent tests. We assert destroy returned
    // cleanly and no extra log entries arrived after destroy.
    const afterDestroy = logger.entries.length
    await settle()
    expect(logger.entries.length).toBe(afterDestroy)
  })

  it('survives a malformed state file by rendering the awaiting fallback', async () => {
    mkdirSync(join(fixture.statePath, '..'), { recursive: true })
    writeFileSync(fixture.statePath, '{not-valid-json', 'utf-8')
    const logger = makeCapturingLogger()
    const testSetup = await testRender(
      () => <SidebarPanel logger={logger} stateFile={fixture.statePath} />,
      {
        width: 60,
        height: 12,
      },
    )
    await testSetup.flush()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain('Awaiting Antigravity state')
    expect(existsSync(fixture.logPath)).toBe(false)
    testSetup.renderer.destroy()
  })
})

describe('RPC notification polling', () => {
  it('polls by session and clears the interval on unmount', async () => {
    const calls: Array<{ lastReceivedId: number; sessionId?: string }> = []
    const received: number[] = []
    const rpcClient = {
      apply: async () => ({ text: '', knobs: {} }),
      pendingNotifications: async (
        lastReceivedId: number,
        sessionId?: string,
      ) => {
        calls.push({ lastReceivedId, sessionId })
        return calls.length === 1
          ? [
              {
                id: 7,
                command: 'antigravity-quota' as const,
                text: 'quota changed',
                knobs: {},
                sessionId,
              },
            ]
          : []
      },
    }
    const testSetup = await testRender(
      () => (
        <SidebarPanel
          logger={makeCapturingLogger()}
          stateFile={join(tmpdir(), 'agy-rpc-poll-missing-state.json')}
          rpcClient={rpcClient}
          rpcPollIntervalMs={10}
          sessionId='session-a'
          onRpcNotification={(notification) => received.push(notification.id)}
        />
      ),
      { width: 40, height: 10 },
    )

    await new Promise<void>((resolve) => setTimeout(resolve, 35))
    expect(calls[0]).toEqual({ lastReceivedId: 0, sessionId: 'session-a' })
    expect(calls.some(({ lastReceivedId }) => lastReceivedId === 7)).toBe(true)
    expect(received).toEqual([7])

    testSetup.renderer.destroy()
    const afterDestroy = calls.length
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(afterDestroy)
  })
})
