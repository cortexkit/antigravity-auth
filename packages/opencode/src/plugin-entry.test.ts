import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAntigravityOpencodeModelIds,
  OPENCODE_MODEL_DEFINITIONS,
} from '@cortexkit/antigravity-auth-core'
import * as packageRoot from '../index'

import { ANTIGRAVITY_PROVIDER_ID } from './constants.ts'
import { GEMINI_DUMP_COMMAND_NAME } from './plugin/gemini-dump.ts'
import { createAntigravityPlugin } from './plugin/index'
import type { PluginClient, PluginInput } from './plugin/types.ts'

/**
 * Minimal client stub: createAntigravityPlugin only touches the client during
 * initialization via initLogger, and during session lifecycle events we never
 * trigger here. Returning `undefined` from these methods keeps the loader path
 * inert — the test only inspects the plugin's exported hooks, not its runtime
 * behavior under real OpenCode events.
 */
function createMinimalClient(): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      abort: mock(async () => {}),
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => {}),
    },
    tui: {
      showToast: mock(async () => {}),
    },
  } as unknown as PluginClient
}

function createPluginInput(
  client: PluginClient,
  directory: string,
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

describe('createAntigravityPlugin (plugin entry surface)', () => {
  let tempProjectDir: string
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempProjectDir = mkdtempSync(join(tmpdir(), 'plugin-entry-test-'))

    // initAntigravityVersion performs a non-blocking fetch on first install.
    // Returning a non-OK response forces it to fall back to the hardcoded
    // version without hitting the network — keeping the test hermetic.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response('not-found', {
          status: 404,
          statusText: 'Not Found',
        })) as unknown as typeof fetch,
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    mock.restore()
    rmSync(tempProjectDir, { recursive: true, force: true })
  })

  it('exposes the host-visible hook contract (config, command.execute.before, event, tool.google_search, auth)', async () => {
    const client = createMinimalClient()
    const ctx = createPluginInput(client, tempProjectDir)

    const plugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(ctx)

    expect(typeof plugin.dispose).toBe('function')
    expect(typeof plugin.config).toBe('function')
    expect(typeof plugin['command.execute.before']).toBe('function')
    expect(typeof plugin.event).toBe('function')
    expect(plugin.tool).toBeDefined()
    expect(plugin.tool?.google_search).toBeDefined()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe(ANTIGRAVITY_PROVIDER_ID)
    expect(typeof plugin.auth.loader).toBe('function')

    // Two auth methods: OAuth with Antigravity + Manual API key entry.
    const labels = plugin.auth.methods.map((m) => m.label)
    expect(labels).toContain('OAuth with Google (Antigravity)')
    expect(labels).toContain('Manually enter API Key')
    expect(plugin.auth.methods).toHaveLength(2)
    const oauthMethod = plugin.auth.methods.find(
      (method) => method.label === 'OAuth with Google (Antigravity)',
    )
    expect(oauthMethod?.type).toBe('oauth')
    expect(typeof oauthMethod?.authorize).toBe('function')

    // No network call should leak from initialization — the version check
    // falls back to the hardcoded version on non-OK.
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('config hook registers the antigravity model catalog, whitelist, and gemini-dump command without deleting existing entries', async () => {
    const client = createMinimalClient()
    const ctx = createPluginInput(client, tempProjectDir)
    const plugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(ctx)

    // Pre-populate the opencode config with a stub provider + command so
    // the plugin must merge rather than overwrite.
    const opencodeConfig = {
      provider: {
        'other-provider': { models: { foo: { name: 'foo' } } },
      },
      command: {
        existing: { template: 'existing', description: 'pre-existing' },
      },
    } as unknown as Parameters<typeof plugin.config>[0]

    await plugin.config?.(opencodeConfig)

    // Provider catalog: the antigravity provider now carries every model
    // listed in the core model registry, and a whitelist matching those ids.
    const expectedModelIds = getAntigravityOpencodeModelIds()
    const provider = (
      opencodeConfig as unknown as {
        provider?: Record<
          string,
          { models: Record<string, unknown>; whitelist: string[] }
        >
      }
    ).provider?.[ANTIGRAVITY_PROVIDER_ID]
    expect(provider).toBeDefined()
    expect(Object.keys(provider!.models).sort()).toEqual(
      [...expectedModelIds].sort(),
    )
    expect(provider!.whitelist).toEqual([...expectedModelIds])

    // Each model definition matches the core registry values.
    for (const id of expectedModelIds) {
      expect(provider!.models[id]).toBe(OPENCODE_MODEL_DEFINITIONS[id])
    }

    // Existing providers and commands are preserved alongside the additions.
    const finalConfig = opencodeConfig as unknown as {
      provider?: Record<string, { models: Record<string, unknown> }>
      command?: Record<string, unknown>
    }
    expect(finalConfig.provider?.['other-provider']?.models).toEqual({
      foo: { name: 'foo' },
    })
    expect(finalConfig.command?.existing).toEqual({
      template: 'existing',
      description: 'pre-existing',
    })

    // The gemini-dump command is registered under the well-known name.
    const dumpCommand = finalConfig.command?.[GEMINI_DUMP_COMMAND_NAME] as
      | { template: string; description: string }
      | undefined
    expect(dumpCommand).toBeDefined()
    expect(dumpCommand!.template).toBe(GEMINI_DUMP_COMMAND_NAME)
    expect(dumpCommand!.description).toContain('wire dump')
  })

  it('command.execute.before ignores non-gemini-dump commands and routes gemini-dump to the dump command handler', async () => {
    const client = createMinimalClient()
    const ctx = createPluginInput(client, tempProjectDir)
    const plugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(ctx)

    // Non-matching command is a no-op — must return without throwing.
    await expect(
      plugin['command.execute.before']?.(
        { command: 'unrelated-command', arguments: '', sessionID: 'ses_test' },
        { parts: [] },
      ),
    ).resolves.toBeUndefined()

    // gemini-dump command with a recognized action throws the handled sentinel.
    // The handler ignores the no-op "status" subcommand and re-throws the
    // sentinel because it considers the message handled.
    await expect(
      plugin['command.execute.before']?.(
        {
          command: GEMINI_DUMP_COMMAND_NAME,
          arguments: 'status',
          sessionID: 'ses_test',
        },
        { parts: [] },
      ),
    ).rejects.toBeDefined()
  })
})

describe('package root exports', () => {
  it('exports only the two plugin factory aliases', () => {
    expect(Object.keys(packageRoot).sort()).toEqual([
      'AntigravityCLIOAuthPlugin',
      'GoogleOAuthPlugin',
    ])
    expect('authorizeAntigravity' in packageRoot).toBe(false)
    expect('exchangeAntigravity' in packageRoot).toBe(false)
  })
})
