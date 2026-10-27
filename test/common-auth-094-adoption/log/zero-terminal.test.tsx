/** @jsxImportSource @opentui/solid */

import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/solid'

test('logger.zero_terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-zero-terminal-'))
  const environment = {
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(dir, 'sidebar.json'),
    ANTIGRAVITY_AUTH_TUI_LOG_FILE: join(dir, 'tui.log'),
    OPENCODE_TUI_PREFERENCES_FILE: join(dir, 'prefs.jsonc'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(dir, 'rpc'),
    OPENCODE_ANTIGRAVITY_CONSOLE_LOG: '1',
    ANTIGRAVITY_CORE_CONSOLE_LOG: '1',
    OPENCODE_ANTIGRAVITY_DEBUG: '1',
    OPENCODE_ANTIGRAVITY_DEBUG_TUI: '1',
  }
  const saved = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, environment)
  const spies = [
    spyOn(console, 'debug').mockImplementation(() => {}),
    spyOn(console, 'info').mockImplementation(() => {}),
    spyOn(console, 'warn').mockImplementation(() => {}),
    spyOn(console, 'error').mockImplementation(() => {}),
    spyOn(console, 'log').mockImplementation(() => {}),
    spyOn(process.stdout, 'write').mockImplementation(() => true),
    spyOn(process.stderr, 'write').mockImplementation(() => true),
  ]
  let renderer: { destroy(): void } | undefined
  try {
    // Import under the active terminal witnesses, not before them. OpenTUI's
    // test renderer captures UI cells separately from plugin diagnostic output.
    const { SidebarPanel, startRpcNotificationPolling } = await import(
      '../../../packages/opencode/src/tui'
    )
    const { createTuiFileLogger } = await import(
      '../../../packages/opencode/src/tui/file-logger'
    )
    const logger = createTuiFileLogger()
    const setup = await testRender(
      () => <SidebarPanel logger={logger} pollIntervalMs={10} />,
      { width: 60, height: 12 },
    )
    renderer = setup.renderer
    await setup.flush()
    expect(setup.captureCharFrame()).toContain('ANTIGRAVITY')
    expect(setup.captureCharFrame()).toContain('Waiting for quota')

    const polls: Array<() => Promise<void>> = []
    let entered = 0
    startRpcNotificationPolling({
      logger,
      currentSessionId: () => 'fake-session',
      pending: async () => {
        entered += 1
        throw new Error('poll diagnostic Bearer fake-poll-secret')
      },
      dispatch: async () => {},
      schedule: (poll) => polls.push(poll),
    })
    expect(polls).toHaveLength(1)
    await polls[0]?.()
    expect(entered).toBe(1)
    const log = readFileSync(environment.ANTIGRAVITY_AUTH_TUI_LOG_FILE, 'utf8')
    expect(log).toContain('rpc-poll-failed')
    expect(log).toContain('poll diagnostic')
    expect(log).not.toContain('fake-poll-secret')
    const tail = Array.from(
      { length: 250 },
      (_, i) => `tail-${i}-${'x'.repeat(100)}`,
    )
    writeFileSync(
      environment.ANTIGRAVITY_AUTH_TUI_LOG_FILE,
      `${'h'.repeat(1_000_000)}\n${tail.join('\n')}\n`,
    )
    logger.info('rotation-control')
    const rotated = readFileSync(
      environment.ANTIGRAVITY_AUTH_TUI_LOG_FILE,
      'utf8',
    )
    const lines = rotated.split('\n')
    expect(Buffer.byteLength(rotated)).toBeLessThan(1_000_000)
    expect(lines).toHaveLength(201)
    expect(lines.slice(0, 199)).toEqual(tail.slice(51))
    const prefix = '[opencode-antigravity-auth/tui] '
    const last = lines[199]
    expect(last).toStartWith(prefix)
    if (!last) throw new Error('missing appended log record')
    expect(JSON.parse(last.slice(prefix.length))).toMatchObject({
      level: 'info',
      message: 'rotation-control',
    })
    expect(lines[200]).toBe('')
    createTuiFileLogger({ filePath: '\u0000/no-file' }).error('drop-control')
    renderer.destroy()
    renderer = undefined
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    renderer?.destroy()
    for (const spy of spies) spy.mockRestore()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
