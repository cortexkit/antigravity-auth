import { describe, expect, it, mock, spyOn } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCommonAuthClaustrum } from '@cortexkit/antigravity-auth-core'
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
import { getVaultDir } from '../runtime-paths'
import { createAntigravityPlugin } from './index'
import { getStoragePath } from './storage'
import type { PluginClient } from './types'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_HOST,
} from './vault-custody'

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

function fakePluginInput(
  client: PluginClient,
  directory = process.env.ANTIGRAVITY_TEST_ROOT ?? process.cwd(),
): PluginInput {
  return {
    client,
    project: {} as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: { register: mock(() => {}) },
    serverUrl: new URL('http://localhost:4096'),
    $: (() => {}) as unknown as PluginInput['$'],
  }
}

describe('v1 host API compatibility', () => {
  it('assigns the plugin and exercises every exposed host hook', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-api-compat-'))
    const overrides = {
      OPENCODE_CONFIG_DIR: directory,
      APPDATA: join(directory, 'appdata'),
      ANTIGRAVITY_AUTH_RPC_DIR: join(directory, 'rpc'),
      ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(directory, 'sidebar.json'),
    }
    const prior = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    )
    Object.assign(process.env, overrides)
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => new Response('', { status: 404 }), {
        preconnect: fetch.preconnect,
      }),
    )
    let hooks: Hooks | undefined
    try {
      writeFileSync(
        join(directory, 'antigravity.json'),
        JSON.stringify({ background_quota_refresh: false, auto_update: false }),
      )
      const claustrum = await loadCommonAuthClaustrum()
      const enrollment = claustrum.hostEnrollmentPaths({
        stateDir: getVaultDir(getStoragePath()),
        host: OPENCODE_VAULT_HOST,
      })
      expect(
        await claustrum.enrollmentAuthority(
          enrollment,
          OPENCODE_VAULT_ENROLLMENT_NAME,
        ),
      ).toBe('local')
      const plugin: Plugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)
      hooks = await plugin(fakePluginInput(fakeClient(), directory))
      await hooks.config?.({})
      await hooks.event?.({
        event: {
          type: 'session.created',
          properties: { info: { id: 'ses_test', parentID: 'ses_parent' } },
        } as never,
      })
      await hooks['command.execute.before']?.(
        { command: 'unrelated', arguments: '', sessionID: 'ses_test' },
        { parts: [] },
      )
      const auth = hooks.auth
      expect(auth).toBeDefined()
      if (!auth) throw new Error('missing auth hook')
      expect(auth.provider).toBe(ANTIGRAVITY_PROVIDER_ID)
      expect(auth.loader).toBeDefined()
      expect(auth.methods.map(({ type, label }) => ({ type, label }))).toEqual([
        { type: 'oauth', label: 'OAuth with Google (Antigravity)' },
        { type: 'api', label: 'Manually enter API Key' },
      ])
      const oauth = auth.methods.filter((method) => method.type === 'oauth')
      expect(oauth).toHaveLength(1)
      for (const method of oauth)
        expect(typeof method.authorize).toBe('function')
      const searchTool = hooks.tool?.google_search as ToolDefinition
      expect(searchTool).toBeDefined()
      await searchTool.execute(
        { query: 'compatibility audit', urls: [], thinking: false },
        {
          sessionID: 'ses_test',
          messageID: 'msg_test',
          agent: 'test',
          directory,
          worktree: directory,
          abort: new AbortController().signal,
          metadata: mock(() => {}),
          ask: mock(async () => {}),
        },
      )
    } finally {
      await hooks?.dispose?.()
      fetchSpy.mockRestore()
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('v1 process heartbeat', () => {
  // The heartbeat names the layout the plugin decided for its config folder
  // at start. Here nothing else runs and no old vault file exists, so the
  // start settles the vault folder in the state home; such a process uses no
  // file in OpenCode's config folder that a later move must wait for, so its
  // heartbeat goes when its last owner releases it.
  it('writes the process heartbeat with the layout decided at plugin start and removes it after dispose', async () => {
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
      layouts: { [processConfigFolderKey()]: 'state-home' },
      stores: { [processConfigFolderKey()]: 'state-home' },
    })
    await hooks.dispose?.()
    expect(existsSync(target)).toBe(false)
  })
})
