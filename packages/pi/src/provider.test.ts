import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
let previousAgentDir: string | undefined
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
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(directory, 'agent')
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
      accountId: `google-person-${i}`,
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
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  await rm(directory, { recursive: true, force: true })
})

function context() {
  return {
    hasUI: true,
    ui: { notify, input: async () => 'code', select: async () => undefined },
    modelRegistry: {},
  } as unknown as ExtensionCommandContext
}

async function persistHostAuth(): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'google-antigravity': { type: 'oauth', ...hostAuth },
    }),
  )
}

describe('Pi provider multi-account integration', () => {
  it('directs first-time /agy-add users through the public provider login flow', async () => {
    await commands.get('agy-add')!.handler('', context())
    expect(exchange).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      'Authenticate the provider first with /login google-antigravity, then use /agy-add for additional accounts.',
      'warning',
    )
  })

  it('canonical login persists and returns the stable OAuth identity', async () => {
    hostAuth = await provider.oauth!.login(callbacks)
    expect(hostAuth).toMatchObject({
      email: 'person1@example.com',
      accountId: 'google-person-1',
    })
    const accounts = await core.loadAccountStorage(
      process.env.PI_ANTIGRAVITY_AUTH_FILE!,
    )
    expect(accounts?.accounts).toEqual([
      expect.objectContaining({
        email: 'person1@example.com',
        accountId: 'google-person-1',
      }),
    ])
  })

  it('canonical login and agy-add re-authenticate the same stable account in place', async () => {
    exchange.mockImplementation(async () => {
      const i = ++sequence
      return {
        type: 'success',
        email: 'same@example.com',
        accountId: 'google-same-account',
        refresh: `same-refresh-${i}|project|managed`,
        access: `same-access-${i}`,
        expires: Date.now() + 3_600_000,
        projectId: 'project',
      }
    })
    hostAuth = await provider.oauth!.login(callbacks)
    await persistHostAuth()
    await commands.get('agy-disable')!.handler('agy1', context())
    await commands.get('agy-add')!.handler('', context())

    expect(
      (await core.loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!))
        ?.accounts,
    ).toEqual([
      expect.objectContaining({
        email: 'same@example.com',
        accountId: 'google-same-account',
        refreshToken: 'same-refresh-2',
        enabled: false,
      }),
    ])
  })

  it('repeated /login and /agy-add share the OAuth flow and retain all accounts', async () => {
    hostAuth = await provider.oauth!.login(callbacks)
    await persistHostAuth()
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
      email: 'legacy@example.com',
    }
    await persistHostAuth()
    await hooks.get('session_start')?.({}, context())
    await provider.oauth!.login(callbacks)
    expect(
      (await core.loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!))
        ?.accounts,
    ).toHaveLength(2)
  })

  it('session_start safely reconciles the live canonical duplicate shape', async () => {
    const accountPath = process.env.PI_ANTIGRAVITY_AUTH_FILE!
    await core.mutateAccountStorage(accountPath, (current) => {
      current.accounts.push(
        {
          refreshToken: 'legacy-a',
          addedAt: 1,
          lastUsed: 1,
          enabled: false,
        },
        {
          email: 'person-b@example.com',
          accountId: 'google-person-b',
          refreshToken: 'account-b',
          addedAt: 2,
          lastUsed: 2,
          enabled: true,
        },
        {
          email: 'person-a@example.com',
          accountId: 'google-person-a',
          refreshToken: 'duplicate-a',
          addedAt: 3,
          lastUsed: 3,
          enabled: true,
        },
      )
      return current
    })
    hostAuth = {
      refresh: 'duplicate-a|project|managed',
      access: 'duplicate-access',
      expires: Date.now() + 3_600_000,
      email: 'person-a@example.com',
      accountId: 'google-person-a',
    }
    await persistHostAuth()
    globalThis.fetch = mock(async (input) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({
          access_token: 'legacy-access',
          expires_in: 3_600,
        })
      }
      if (url.includes('oauth2/v1/userinfo')) {
        return Response.json({
          id: 'google-person-a',
          email: 'person-a@example.com',
        })
      }
      return Response.json({ groups: [] })
    }) as unknown as typeof fetch

    await hooks.get('session_start')?.({}, context())

    const accounts = (await core.loadAccountStorage(accountPath))!.accounts
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      email: 'person-a@example.com',
      accountId: 'google-person-a',
      refreshToken: 'duplicate-a',
      enabled: false,
    })
    expect(accounts[1]?.email).toBe('person-b@example.com')
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
