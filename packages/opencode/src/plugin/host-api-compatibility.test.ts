import { describe, expect, it, mock } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type {
  Hooks,
  Plugin,
  PluginInput,
  ToolDefinition,
} from '@opencode-ai/plugin'
import { ANTIGRAVITY_PROVIDER_ID } from '../constants'
import {
  __resetProcessHeartbeatForTest,
  type ProcessHeartbeat,
  processConfigFolderKey,
  processHeartbeatPath,
} from '../process-heartbeat'
import { createAntigravityPlugin } from './index'
import type { PluginClient } from './types'

function fakeClient(): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({})),
    },
    tui: { showToast: mock(async () => {}) },
  } as unknown as PluginClient
}

function fakePluginInput(client: PluginClient): PluginInput {
  return {
    client,
    project: {} as PluginInput['project'],
    directory: process.env.ANTIGRAVITY_TEST_ROOT ?? process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: { register: mock(() => {}) },
    serverUrl: new URL('http://localhost:4096'),
    $: (() => {}) as unknown as PluginInput['$'],
  }
}

describe('v1 host API compatibility', () => {
  it('assigns the plugin and exercises every exposed host hook', async () => {
    const plugin: Plugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)
    const hooks: Hooks = await plugin(fakePluginInput(fakeClient()))

    await hooks.config?.({})
    await hooks.event?.({ event: { type: 'session.created' } as never })
    await hooks['command.execute.before']?.(
      { command: 'unrelated', arguments: '', sessionID: 'ses_test' },
      { parts: [] },
    )

    expect(hooks.auth?.provider).toBe(ANTIGRAVITY_PROVIDER_ID)
    expect(hooks.auth?.loader).toBeDefined()
    for (const method of hooks.auth?.methods ?? []) {
      if (method.type === 'oauth') {
        expect(typeof method.authorize).toBe('function')
      }
    }

    const searchTool = hooks.tool?.google_search as ToolDefinition
    expect(searchTool).toBeDefined()
    await searchTool.execute(
      { query: 'compatibility audit', urls: [], thinking: false },
      {
        sessionID: 'ses_test',
        messageID: 'msg_test',
        agent: 'test',
        directory: process.cwd(),
        worktree: process.cwd(),
        abort: new AbortController().signal,
        metadata: mock(() => {}),
        ask: mock(async () => {}),
      },
    )

    await hooks.dispose?.()
  })
})

describe('v1 process heartbeat', () => {
  it('writes the process heartbeat on plugin start and keeps it after dispose', async () => {
    const target = processHeartbeatPath(process.pid)
    // Start from no heartbeat, whatever earlier plugin starts in this file left.
    __resetProcessHeartbeatForTest()
    rmSync(target, { force: true })
    const plugin: Plugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)
    const hooks: Hooks = await plugin(fakePluginInput(fakeClient()))
    const heartbeat = JSON.parse(
      readFileSync(target, 'utf8'),
    ) as ProcessHeartbeat
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(heartbeat).toEqual({
      pid: process.pid,
      version: manifest.version,
      startedAt: expect.any(Number),
      layouts: { [processConfigFolderKey()]: 'legacy' },
    })
    await hooks.dispose?.()
    // The process keeps the OpenCode config folder layout until it exits.
    expect(existsSync(target)).toBe(true)
  })
})
