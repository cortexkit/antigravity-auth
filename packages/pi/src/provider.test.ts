import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@cortexkit/antigravity-auth-core'
import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'

const exchange = mock()
const transport = mock()
mock.module('@cortexkit/antigravity-auth-core', () => ({
  ...core,
  authorizeAntigravity: async () => ({
    url: 'https://accounts.google.com/auth?state=expected-state',
    verifier: 'verifier',
    projectId: '',
  }),
  exchangeAntigravity: exchange,
  fetchWithAgyCliTransport: transport,
}))
const { default: register } = await import('./index.ts')

type Provider = Parameters<ExtensionAPI['registerProvider']>[1]
type Command = Parameters<ExtensionAPI['registerCommand']>[1]
let provider: Provider
const commands = new Map<string, Command>()
const hooks = new Map<string, (...args: unknown[]) => Promise<void>>()
let directory: string
let previousPath: string | undefined
let previousFetch: typeof fetch
let sequence: number
let hostAuth: OAuthCredentials | undefined
const notify = mock()
const callbacks = {
  onAuth: mock(),
  onPrompt: async () => 'code',
  onDeviceCode: mock(),
  onSelect: async () => undefined,
} satisfies OAuthLoginCallbacks

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-provider-'))
  previousPath = process.env.PI_ANTIGRAVITY_AUTH_FILE
  process.env.PI_ANTIGRAVITY_AUTH_FILE = join(directory, 'accounts.json')
  previousFetch = globalThis.fetch
  globalThis.fetch = mock(async () =>
    Response.json({ groups: [] }),
  ) as unknown as typeof fetch
  core.initHealthTracker({})
  core.initTokenTracker({})
  sequence = 0
  hostAuth = undefined
  exchange.mockReset()
  transport.mockReset()
  notify.mockClear()
  commands.clear()
  hooks.clear()
  exchange.mockImplementation(async () => {
    const i = ++sequence
    return {
      type: 'success',
      email: `person${i}@example.com`,
      refresh: `refresh-${i}|project|managed`,
      access: `access-${i}`,
      expires: Date.now() + 3600_000,
      projectId: 'project',
    }
  })
  register({
    registerProvider: (id: string, config: Provider) => {
      expect(id).toBe('google-antigravity')
      provider = config
    },
    registerCommand: (name: string, config: Command) =>
      commands.set(name, config),
    on: (name: string, callback: (...args: unknown[]) => Promise<void>) =>
      hooks.set(name, callback),
  } as unknown as ExtensionAPI)
})

afterEach(async () => {
  await hooks.get('session_shutdown')?.()
  globalThis.fetch = previousFetch
  if (previousPath === undefined) delete process.env.PI_ANTIGRAVITY_AUTH_FILE
  else process.env.PI_ANTIGRAVITY_AUTH_FILE = previousPath
  await rm(directory, { recursive: true, force: true })
})

function context() {
  return {
    hasUI: true,
    ui: { notify, input: async () => 'code', select: async () => undefined },
    modelRegistry: {
      authStorage: {
        get: () => (hostAuth ? { type: 'oauth', ...hostAuth } : undefined),
        login: async (_id: string, cb: OAuthLoginCallbacks) => {
          hostAuth = await provider.oauth!.login(cb)
        },
      },
    },
  } as unknown as ExtensionCommandContext
}

describe('Pi provider multi-account integration', () => {
  it('repeated /login and /agy-add share the OAuth flow and retain all accounts', async () => {
    hostAuth = await provider.oauth!.login(callbacks)
    hostAuth = await provider.oauth!.login(callbacks)
    await commands.get('agy-add')!.handler('', context())
    const accounts = await core.loadAccountStorage(
      process.env.PI_ANTIGRAVITY_AUTH_FILE!,
    )
    expect(accounts?.accounts).toHaveLength(3)
    expect(exchange).toHaveBeenCalledTimes(3)
    for (const name of [
      'agy-accounts',
      'agy-add',
      'agy-quota',
      'agy-strategy',
      'agy-enable',
      'agy-disable',
    ])
      expect(commands.has(name)).toBe(true)
  })

  it('migrates host auth at session start before a second login replaces the host credential', async () => {
    hostAuth = {
      refresh: 'legacy|project|managed',
      access: 'legacy-access',
      expires: Date.now() + 3600_000,
    }
    await hooks.get('session_start')?.({}, context())
    await provider.oauth!.login(callbacks)
    expect(
      (await core.loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!))
        ?.accounts,
    ).toHaveLength(2)
  })

  it('rejects a mismatched OAuth state and cancellation before exchange/persistence', async () => {
    await expect(
      provider.oauth!.login({
        ...callbacks,
        onPrompt: async () => 'http://localhost/?code=code&state=wrong',
      }),
    ).rejects.toThrow('state mismatch')
    await expect(
      provider.oauth!.login({ ...callbacks, signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    expect(exchange).not.toHaveBeenCalled()
    expect(
      await core.loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!),
    ).toBeNull()
  })

  it('operator commands persist strategy/enable state and never display tokens', async () => {
    await provider.oauth!.login(callbacks)
    await provider.oauth!.login(callbacks)
    const ctx = context()
    await commands.get('agy-strategy')!.handler('round-robin', ctx)
    await commands.get('agy-disable')!.handler('agy1', ctx)
    expect(
      (await core.loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!))
        ?.accounts[0]?.enabled,
    ).toBe(false)
    await commands.get('agy-enable')!.handler('1', ctx)
    await commands.get('agy-quota')!.handler('refresh', ctx)
    await commands.get('agy-accounts')!.handler('', ctx)
    const output = JSON.stringify(notify.mock.calls)
    expect(output).toContain('round-robin')
    expect(output).toContain('agy2')
    expect(output).not.toContain('access-')
    expect(output).not.toContain('refresh-')
    expect(
      (await core.loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!))
        ?.accounts[0]?.enabled,
    ).toBe(true)
  })

  it('registered stream routes agy1, agy2, agy3, agy1 and keeps request/session transforms', async () => {
    for (let i = 0; i < 3; i++)
      hostAuth = await provider.oauth!.login(callbacks)
    const authFile = process.env.PI_ANTIGRAVITY_AUTH_FILE!
    await core.writeJsonAtomic(`${authFile}.config.json`, {
      account_selection_strategy: 'round-robin',
      pid_offset_enabled: false,
    })
    transport.mockImplementation(
      async () =>
        new Response(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}}\n\n',
        ),
    )
    const model = {
      ...provider.models![0],
      api: 'google-generative-ai',
      provider: 'google-antigravity',
    } as Model<Api>
    const apiKey = provider.oauth!.getApiKey(hostAuth!)
    for (let i = 0; i < 4; i++) {
      const result = provider.streamSimple!(
        model,
        { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
        { apiKey, sessionId: 'session' },
      )
      expect((await result.result()).stopReason).toBe('stop')
    }
    const headers = transport.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    )
    expect(headers.map((header) => header.Authorization)).toEqual([
      'Bearer access-1',
      'Bearer access-2',
      'Bearer access-3',
      'Bearer access-1',
    ])
    const bodies = transport.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    )
    expect(bodies[0].project).toBe('managed')
    expect(bodies[0].request.sessionId).toBe(bodies[1].request.sessionId)
    expect(headers.every((header) => !!header['User-Agent'])).toBe(true)
  })

  it('fails over before streaming, but does not replay a partial stream', async () => {
    for (let i = 0; i < 3; i++)
      hostAuth = await provider.oauth!.login(callbacks)
    await core.writeJsonAtomic(
      `${process.env.PI_ANTIGRAVITY_AUTH_FILE!}.config.json`,
      { account_selection_strategy: 'sticky', pid_offset_enabled: false },
    )
    transport.mockImplementationOnce(
      async () => new Response('', { status: 429 }),
    )
    transport.mockImplementationOnce(
      async () =>
        new Response(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
        ),
    )
    const model = {
      ...provider.models![0],
      api: 'google-generative-ai',
      provider: 'google-antigravity',
    } as Model<Api>
    const stream = provider.streamSimple!(
      model,
      { messages: [] },
      { apiKey: provider.oauth!.getApiKey(hostAuth!) },
    )
    const result = await stream.result()
    expect(result.stopReason).toBe('error')
    expect(result.content).toContainEqual({ type: 'text', text: 'partial' })
    expect(transport).toHaveBeenCalledTimes(2)
    const bodies = transport.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    )
    expect(bodies[0].requestId).toBe(bodies[1].requestId)
  })
})
