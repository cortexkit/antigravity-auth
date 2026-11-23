import { expect, mock, spyOn, test } from 'bun:test'
import {
  ANTIGRAVITY_REDIRECT_URI,
  authorizeAntigravity,
} from '@cortexkit/antigravity-auth-core'
import type {
  IntegrationEditor,
  IntegrationMethodRegistration,
  IntegrationOAuthMethodRegistration,
} from '@opencode/plugin/promise/integration'
import { registerGaAuthMethods } from '../../../../opencode/src/ga/server/auth.ts'
import { GA_POOL_PASTE_METHOD_ID } from '../../../../opencode/src/ga/server/pool-login.ts'
import { createAccountCommandOAuthService } from '../../../../opencode/src/plugin/account-command-oauth.ts'
import { DEFAULT_CONFIG } from '../../../../opencode/src/plugin/config/index.ts'
import { createPluginLifecycle } from '../../../../opencode/src/plugin/lifecycle.ts'
import { createOAuthMethods } from '../../../../opencode/src/plugin/oauth-methods.ts'
import { Environment } from '../environment.ts'
import { piAdapter } from '../pi-surface.ts'

const bareCode = '4/fixture-code'
const credentials = {
  type: 'success',
  refresh: 'fixture-refresh|fixture-project',
  access: 'fixture-access',
  expires: 123,
  projectId: 'fixture-project',
} as const

function redirect(authorizationUrl: string) {
  const url = new URL(ANTIGRAVITY_REDIRECT_URI)
  url.searchParams.set('code', bareCode)
  url.searchParams.set(
    'state',
    new URL(authorizationUrl).searchParams.get('state')!,
  )
  return url
}

type Paste = (authorizationUrl: string) => string

function observeSignIn() {
  const exchanges: string[] = []
  const save = mock(async () => {})
  return {
    exchanges,
    save,
    exchange: async (code: string) => {
      exchanges.push(code)
      return credentials
    },
  }
}

async function openCode1() {
  const observed = observeSignIn()
  const lifecycle = createPluginLifecycle({
    sessionRegistry: { clear() {} },
    shutdownDiskSignatureCache: async () => {},
    clearFetchState() {},
  })
  try {
    const methods = createOAuthMethods({
      client: { tui: { showToast: async () => {} } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle,
      accountAccess: {
        loadAccounts: async () => null,
        persistAccountPool: observed.save,
        verifyAccount: async () => {
          throw new Error('Unexpected verification')
        },
        selectAccount: async () => {
          throw new Error('Unexpected account selection')
        },
      } as never,
      dependencies: {
        authorize: authorizeAntigravity,
        exchange: observed.exchange,
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })
    const method = methods[0]
    if (method?.type !== 'oauth') throw new Error('Expected OAuth method')
    const authorization = await method.authorize()
    if (authorization.method !== 'code') throw new Error('Expected paste mode')
    return {
      ...observed,
      finish: async (paste: Paste) =>
        (await authorization.callback(paste(authorization.url))).type ===
        'success',
      dispose: () => lifecycle.dispose(),
    }
  } catch (error) {
    await lifecycle.dispose()
    throw error
  }
}

async function openCode2() {
  const observed = observeSignIn()
  const methods: IntegrationOAuthMethodRegistration[] = []
  const registration = await registerGaAuthMethods(
    {
      integration: {
        transform: async (apply) => {
          apply({
            method: {
              update(entry: IntegrationMethodRegistration) {
                if ('authorize' in entry) methods.push(entry)
              },
            },
          } as IntegrationEditor)
          return { dispose: async () => {} }
        },
      },
    },
    async () => 'local',
    {
      local: { assertAdmission: async () => {}, persist: observed.save },
      oauth: { authorize: authorizeAntigravity, exchange: observed.exchange },
    },
  )
  try {
    const authorization = await methods
      .find(({ method }) => method.id === GA_POOL_PASTE_METHOD_ID)
      ?.authorize({})
    if (authorization?.mode !== 'code') throw new Error('Expected paste mode')
    return {
      ...observed,
      finish: async (paste: Paste) =>
        authorization.callback(paste(authorization.url)).then(
          () => true,
          () => false,
        ),
      dispose: () => registration.dispose(),
    }
  } catch (error) {
    await registration.dispose()
    throw error
  }
}

async function pi() {
  const environment = new Environment(() => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudaicompanionProject: 'fixture-project' }),
  }))
  const adapter = await piAdapter(environment, 'local', false)
  try {
    const { oauth } = await adapter.activate()
    if (!oauth) throw new Error('Expected local OAuth provider')
    const exchanges: string[] = []
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token') {
        exchanges.push(
          new URLSearchParams(init?.body as URLSearchParams).get('code')!,
        )
        return Response.json({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          expires_in: 3600,
        })
      }
      if (url === 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json') {
        return Response.json({})
      }
      throw new Error('Unexpected network request in Pi sign-in')
    }) as typeof globalThis.fetch)
    return {
      exchanges,
      save: undefined,
      finish: async (paste: Paste) => {
        let authorizationUrl = ''
        return oauth
          .login({
            onAuth: ({ url }) => {
              authorizationUrl = url
            },
            onDeviceCode: () => {},
            onSelect: async () => undefined,
            onPrompt: async () => paste(authorizationUrl),
          })
          .then(
            (value) => value.refresh === credentials.refresh,
            () => false,
          )
      },
      async dispose() {
        fetch.mockRestore()
        try {
          await adapter.dispose()
        } finally {
          await environment.dispose()
        }
      },
    }
  } catch (error) {
    await adapter.dispose()
    await environment.dispose()
    throw error
  }
}

const hosts = [
  ['OpenCode 1', openCode1],
  ['OpenCode 2', openCode2],
  ['Pi', pi],
] as const

const otherState = new URL((await authorizeAntigravity()).url).searchParams.get(
  'state',
)!
const invalidLinks = {
  origin(url: URL) {
    url.hostname = 'wrong.example.test'
  },
  path(url: URL) {
    url.pathname = '/wrong-path'
  },
  state(url: URL) {
    url.searchParams.set('state', otherState)
  },
  'missing state'(url: URL) {
    url.searchParams.delete('state')
  },
  'duplicate state'(url: URL) {
    url.searchParams.append('state', otherState)
  },
}

for (const [name, start] of hosts) {
  for (const [invalid, change] of Object.entries(invalidLinks)) {
    test(`${name} pasted sign-in refuses ${invalid} without exchanging`, async () => {
      const host = await start()
      try {
        const completed = await host.finish((auth) => {
          const url = redirect(auth)
          change(url)
          return url.href
        })
        expect(completed).toBe(false)
        expect(host.exchanges).toEqual([])
        if (host.save) expect(host.save).not.toHaveBeenCalled()
      } finally {
        await host.dispose()
      }
    })
  }

  test(`${name} pasted sign-in accepts a valid link but refuses its replay`, async () => {
    const host = await start()
    try {
      let link = ''
      expect(await host.finish((auth) => (link = redirect(auth).href))).toBe(
        true,
      )
      expect(await host.finish(() => link)).toBe(false)
      expect(host.exchanges).toEqual([bareCode])
      if (host.save) expect(host.save).toHaveBeenCalledTimes(1)
    } finally {
      await host.dispose()
    }
  })

  test(`${name} pasted sign-in completes with a bare code`, async () => {
    const host = await start()
    try {
      expect(await host.finish(() => ` ${bareCode} `)).toBe(true)
      expect(host.exchanges).toEqual([bareCode])
      if (host.save) expect(host.save).toHaveBeenCalledTimes(1)
    } finally {
      await host.dispose()
    }
  })
}

for (const [invalid, change] of Object.entries(invalidLinks)) {
  test(`OpenCode 1 account menu sign-in refuses ${invalid}`, async () => {
    const observed = observeSignIn()
    const service = createAccountCommandOAuthService({
      authorize: authorizeAntigravity,
      exchange: observed.exchange,
      persist: observed.save,
      listAccounts: async () => [],
    })
    try {
      const { url: auth } = await service.start('fixture-session')
      const url = redirect(auth)
      change(url)
      const result = await service.finish('fixture-session', url.href)
      expect(result.text).toContain('OAuth authentication failed:')
      expect(observed.exchanges).toEqual([])
      expect(observed.save).not.toHaveBeenCalled()
    } finally {
      service.dispose()
    }
  })
}
