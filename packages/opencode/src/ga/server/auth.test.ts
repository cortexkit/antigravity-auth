import { describe, expect, it, mock, spyOn } from 'bun:test'
import type {
  IntegrationEditor,
  IntegrationMethodRegistration,
  IntegrationOAuthMethodRegistration,
} from '@opencode/plugin/promise/integration'
import { withVaultHost } from '../../../../../test/support/vault-host.ts'
import {
  OPENCODE2_POOL_AUTH_LABEL,
  OPENCODE2_VAULT_AUTH_LABEL,
} from '../../auth-method-labels.ts'
import {
  isPlaceholderCredential,
  placeholderCredential,
  placeholderSecret,
} from '../../common-auth-embedded/opencode2/index.js'
import { GA_VAULT_METHOD_ID, registerGaAuthMethods } from './auth.ts'
import { GA_POOL_METHOD_ID, GA_POOL_RECONNECT_METHOD_ID } from './pool-login.ts'

function host() {
  const methods: IntegrationMethodRegistration[] = []
  let disposed = false
  let disposalCount = 0
  const editor: IntegrationEditor = {
    list: () => [{ id: 'google', name: 'Google' }],
    get: (id) => (id === 'google' ? { id, name: 'Google' } : undefined),
    update() {
      throw new Error('Integration metadata must remain unchanged')
    },
    remove() {
      throw new Error('Integrations must remain unchanged')
    },
    method: {
      list: () => [
        { id: 'google-oauth', type: 'oauth', label: 'Existing Google login' },
      ],
      update: (registration) => {
        methods.push(registration)
      },
      remove() {
        throw new Error('Existing methods must remain unchanged')
      },
    },
  }
  return {
    context: {
      integration: {
        transform: async (callback: (editor: IntegrationEditor) => void) => {
          callback(editor)
          return {
            dispose: async () => {
              disposed = true
              disposalCount++
            },
          }
        },
      },
    },
    methods,
    disposed: () => disposed,
    disposalCount: () => disposalCount,
  }
}

function vaultMethod(
  methods: IntegrationMethodRegistration[],
): IntegrationOAuthMethodRegistration {
  const method = methods.find(
    (method) =>
      method.method.type === 'oauth' && method.method.id === GA_VAULT_METHOD_ID,
  )
  if (!method || !('authorize' in method))
    throw new Error('Vault method missing')
  return method
}

function poolMethod(
  methods: IntegrationMethodRegistration[],
): IntegrationOAuthMethodRegistration {
  const method = methods.find(
    ({ method }) => method.type === 'oauth' && method.id === GA_POOL_METHOD_ID,
  )
  if (!method || !('authorize' in method))
    throw new Error('Pool browser method missing')
  return method
}

const login = {
  type: 'success' as const,
  refresh: 'synthetic-refresh|project',
  access: 'synthetic-access',
  expires: Date.now() + 3_600_000,
  email: 'pool@example.test',
  projectId: 'project',
}

function reconnectMethod(
  methods: IntegrationMethodRegistration[],
): IntegrationOAuthMethodRegistration {
  const method = methods.find(
    ({ method }) =>
      method.type === 'oauth' && method.id === GA_POOL_RECONNECT_METHOD_ID,
  )
  if (!method || !('authorize' in method))
    throw new Error('Reconnect method missing')
  return method
}

describe('GA native existing-pool reconnect', () => {
  it('uses no OAuth or callback listener and disposes both transforms', async () => {
    const native = host()
    let checks = 0
    let oauth = 0
    let writes = 0
    const registration = await registerGaAuthMethods(
      native.context,
      undefined,
      {
        local: {
          assertAdmission: async () => {},
          assertExistingPool: async (admit) => {
            await admit()
            checks++
          },
          persist: async () => {
            writes++
          },
        },
        oauth: {
          authorize: async () => {
            oauth++
            throw new Error('No OAuth')
          },
          exchange: async () => {
            oauth++
            throw new Error('No exchange')
          },
          waitForCode: async () => {
            oauth++
            throw new Error('No listener')
          },
        },
      },
    )
    try {
      const method = reconnectMethod(native.methods)
      const authorization = await method.authorize({})
      expect(authorization.url).toBe('')
      expect(authorization.instructions).toContain('No browser')
      if (authorization.mode !== 'auto') throw new Error('Expected auto')
      const credential = await authorization.callback
      expect(isPlaceholderCredential(credential, 'google')).toBe(true)
      expect(String(credential.methodID)).toBe(GA_POOL_RECONNECT_METHOD_ID)
      expect(method.label?.(credential)).toBe('Antigravity')
      expect(
        isPlaceholderCredential(await method.refresh!(credential), 'google'),
      ).toBe(true)
      expect(checks).toBe(2)
      expect(oauth).toBe(0)
      expect(writes).toBe(0)
    } finally {
      await registration.dispose()
    }
    expect(native.disposalCount()).toBe(2)
    await expect(
      reconnectMethod(native.methods).refresh!(
        placeholderCredential({
          integrationID: 'google',
          methodID: GA_POOL_RECONNECT_METHOD_ID,
          now: 0,
        }),
      ),
    ).rejects.toThrow('could not be completed')
  })

  it('refuses native Google, vault, browser and foreign placeholders unchanged on refresh', async () => {
    const native = host()
    let checks = 0
    const registration = await registerGaAuthMethods(
      native.context,
      undefined,
      {
        local: {
          assertAdmission: async () => {},
          assertExistingPool: async () => {
            checks++
          },
          persist: async () => {
            throw new Error('No write')
          },
        },
      },
    )
    try {
      const credentials = [
        ...['google-oauth', GA_VAULT_METHOD_ID, GA_POOL_METHOD_ID, 'other'].map(
          (methodID) =>
            placeholderCredential({
              integrationID: 'google',
              methodID,
              now: 0,
            }),
        ),
        placeholderCredential({
          integrationID: 'other',
          methodID: GA_POOL_RECONNECT_METHOD_ID,
          now: 0,
        }),
        {
          ...placeholderCredential({
            integrationID: 'google',
            methodID: GA_POOL_RECONNECT_METHOD_ID,
            now: 0,
          }),
          access: 'native-access',
          refresh: 'native-refresh',
        },
      ]
      for (const credential of credentials) {
        const before = JSON.stringify(credential)
        await expect(
          reconnectMethod(native.methods).refresh!(credential),
        ).rejects.toThrow('only its existing local pool placeholder')
        expect(JSON.stringify(credential)).toBe(before)
      }
      expect(checks).toBe(0)
    } finally {
      await registration.dispose()
    }
  })

  for (const action of ['revoke', 'dispose', 'fail'] as const) {
    it(`refuses a marker on mid-check ${action} and waits for pending work`, async () => {
      const native = host()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let allowed = true
      const registration = await registerGaAuthMethods(
        native.context,
        undefined,
        {
          local: {
            assertAdmission: async () => {
              if (!allowed) throw new Error('revoked')
            },
            assertExistingPool: async () => {
              entered.resolve()
              await release.promise
              if (action === 'fail') throw new Error('secret read failure')
            },
            persist: async () => {
              throw new Error('No write')
            },
          },
        },
      )
      try {
        const authorization = await reconnectMethod(native.methods).authorize(
          {},
        )
        if (authorization.mode !== 'auto') throw new Error('Expected auto')
        const result = authorization.callback.then(
          () => 'unexpected marker',
          (error: Error) => error.message,
        )
        await entered.promise
        let disposal: Promise<void> | undefined
        let disposed = false
        if (action === 'revoke') allowed = false
        if (action === 'dispose') {
          disposal = registration.dispose().then(() => {
            disposed = true
          })
          expect(await result).toBe(
            'The Antigravity pool login could not be completed.',
          )
          expect(disposed).toBe(false)
        }
        release.resolve()
        expect(await result).toBe(
          'The Antigravity pool login could not be completed.',
        )
        await disposal
      } finally {
        release.resolve()
        await registration.dispose()
      }
    })
  }

  it('cleans up the first transform when second registration fails', async () => {
    const native = host()
    const transform = native.context.integration.transform
    let calls = 0
    native.context.integration.transform = async (callback) => {
      if (++calls === 2) throw new Error('second transform failed')
      return transform(callback)
    }
    await expect(
      registerGaAuthMethods(native.context, undefined, {
        local: {
          assertAdmission: async () => {},
          assertExistingPool: async () => {},
          persist: async () => {},
        },
      }),
    ).rejects.toThrow('second transform failed')
    expect(native.disposalCount()).toBe(1)
  })
})

describe('GA pool browser registration', () => {
  it('persists before issuing only a placeholder to the host', async () => {
    const native = host()
    const committing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let writes = 0
    const registration = await registerGaAuthMethods(
      native.context,
      undefined,
      {
        local: {
          assertAdmission: async () => {},
          persist: async (result) => {
            expect(result).toEqual(login)
            committing.resolve()
            await release.promise
            writes++
          },
        },
        oauth: { waitForCode: async () => 'code', exchange: async () => login },
      },
    )
    try {
      const authorization = await poolMethod(native.methods).authorize({})
      expect(authorization.mode).toBe('auto')
      if (authorization.mode !== 'auto') throw new Error('Expected auto login')
      let issued = false
      void authorization.callback.then(() => {
        issued = true
      })
      await committing.promise
      expect(issued).toBe(false)
      expect(writes).toBe(0)
      release.resolve()
      const credential = await authorization.callback
      expect(writes).toBe(1)
      expect(isPlaceholderCredential(credential, 'google')).toBe(true)
      expect(String(credential.methodID)).toBe(GA_POOL_METHOD_ID)
      expect(JSON.stringify(credential)).not.toContain(login.access)
      expect(JSON.stringify(credential)).not.toContain(login.refresh)
    } finally {
      release.resolve()
      await registration.dispose()
    }
  })

  for (const mode of ['vault', 'unreadable'] as const) {
    it(`refuses ${mode} authority at authorize without OAuth or writes`, async () => {
      const native = host()
      let oauth = 0
      let writes = 0
      const registration = await registerGaAuthMethods(
        native.context,
        async () => mode,
        {
          local: {
            assertAdmission: async () => {
              throw new Error('authority refused')
            },
            persist: async () => {
              writes++
            },
          },
          oauth: {
            authorize: async () => {
              oauth++
              throw new Error('must not start')
            },
          },
        },
      )
      try {
        await expect(poolMethod(native.methods).authorize({})).rejects.toThrow(
          'The Antigravity pool login could not be completed.',
        )
        expect(oauth).toBe(0)
        expect(writes).toBe(0)
      } finally {
        await registration.dispose()
      }
    })
  }

  for (const stage of ['callback', 'token', 'userinfo'] as const) {
    it(`revokes local authority at ${stage} without a later project call, write or placeholder`, async () => {
      const native = host()
      let allowed = true
      let writes = 0
      const code = Promise.withResolvers<string>()
      const entered = Promise.withResolvers<void>()
      const response = Promise.withResolvers<Response>()
      const calls: string[] = []
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
        url: RequestInfo | URL,
      ) => {
        calls.push(String(url))
        if (calls.length === (stage === 'token' ? 1 : 2)) {
          entered.resolve()
          return response.promise
        }
        if (calls.length === 1)
          return Response.json({
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
          })
        throw new Error('No later project call is admitted')
      }) as typeof fetch)
      const registration = await registerGaAuthMethods(
        native.context,
        undefined,
        {
          local: {
            assertAdmission: async () => {
              if (!allowed) throw new Error('revoked')
            },
            persist: async () => {
              writes++
            },
          },
          oauth: { waitForCode: () => code.promise },
        },
      )
      try {
        const authorization = await poolMethod(native.methods).authorize({})
        if (authorization.mode !== 'auto')
          throw new Error('Expected auto login')
        const rejected = authorization.callback.then(
          () => 'unexpected placeholder',
          (error: Error) => error.message,
        )
        if (stage !== 'callback') {
          code.resolve('code')
          await entered.promise
        }
        allowed = false
        code.resolve('code')
        response.resolve(
          Response.json(
            stage === 'token'
              ? {
                  access_token: 'access',
                  refresh_token: 'refresh',
                  expires_in: 3600,
                }
              : { email: 'pool@example.test' },
          ),
        )
        expect(await rejected).toBe(
          'The Antigravity pool login could not be completed.',
        )
        expect(writes).toBe(0)
        expect(calls.length).toBe(
          stage === 'callback' ? 0 : stage === 'token' ? 1 : 2,
        )
        expect(calls.some((url) => url.includes('loadCodeAssist'))).toBe(false)
      } finally {
        code.resolve('cleanup')
        response.resolve(new Response('{}'))
        await registration.dispose()
        fetchSpy.mockRestore()
      }
    })
  }

  it('refuses a second bound 51121 login with the listener message and releases it on disposal', async () => {
    const native = host()
    let writes = 0
    const options = {
      local: {
        assertAdmission: async () => {},
        persist: async () => {
          writes++
        },
      },
      oauth: { exchange: async () => login },
    }
    const registration = await registerGaAuthMethods(
      native.context,
      undefined,
      options,
    )
    const first = await poolMethod(native.methods).authorize({})
    if (first.mode !== 'auto') throw new Error('Expected auto login')
    const rejected = first.callback.then(
      () => 'unexpected placeholder',
      (error: Error) => error.message,
    )
    try {
      await expect(poolMethod(native.methods).authorize({})).rejects.toThrow(
        'Port 51121 is already in use. Another process is occupying this port. Please terminate the process or try again later.',
      )
    } finally {
      await registration.dispose()
    }
    expect(await rejected).toBe(
      'The Antigravity pool login could not be completed.',
    )
    expect(writes).toBe(0)
    const next = host()
    const nextRegistration = await registerGaAuthMethods(
      next.context,
      undefined,
      options,
    )
    try {
      const authorization = await poolMethod(next.methods).authorize({})
      if (authorization.mode !== 'auto') throw new Error('Expected auto login')
      const state = new URL(authorization.url).searchParams.get('state')!
      await fetch(
        `http://127.0.0.1:51121/oauth-callback?state=${encodeURIComponent(state)}&code=code`,
      )
      expect(
        isPlaceholderCredential(await authorization.callback, 'google'),
      ).toBe(true)
      expect(writes).toBe(1)
    } finally {
      await nextRegistration.dispose()
    }
  })
})

describe('GA native vault activation', () => {
  it('[hosted] installs the Google placeholder without enrollment and refuses pool sign-in', async () => {
    await withVaultHost(
      'thalamus',
      () => ({}),
      async () => {
        const native = host()
        const admission = mock(async () => {})
        const registration = await registerGaAuthMethods(
          native.context,
          async () => 'host',
          { local: { assertAdmission: admission, persist: async () => {} } },
        )
        try {
          const authorization = await vaultMethod(native.methods).authorize({})
          if (authorization.mode !== 'auto')
            throw new Error('Expected automatic vault activation')
          const credential = await authorization.callback
          expect(credential.refresh).toBe(placeholderSecret('google'))
          expect(isPlaceholderCredential(credential, 'google')).toBe(true)
          await expect(
            poolMethod(native.methods).authorize({}),
          ).rejects.toThrow()
          expect(admission).not.toHaveBeenCalled()
        } finally {
          await registration.dispose()
        }
      },
    )
  })
  it('registers exactly the pool browser and vault methods under Antigravity and activates without a local login', async () => {
    const native = host()
    let activations = 0
    const registration = await registerGaAuthMethods(
      native.context,
      async () => {
        activations++
        return 'vault'
      },
    )
    expect(
      native.methods.map(({ method }) =>
        method.type === 'oauth' ? [method.id, method.label] : method.type,
      ),
    ).toEqual([
      ['antigravity-auth-pool-browser', OPENCODE2_POOL_AUTH_LABEL],
      [GA_VAULT_METHOD_ID, OPENCODE2_VAULT_AUTH_LABEL],
    ])
    for (const method of native.methods) {
      if (!('authorize' in method)) throw new Error('Expected OAuth method')
      expect(
        await method.label?.(
          placeholderCredential({
            integrationID: 'google',
            methodID: 'test',
            now: 0,
          }),
        ),
      ).toBe('Antigravity')
    }
    const method = vaultMethod(native.methods)
    expect(method.integrationID).toBe('google')
    expect(method.method.id).toBe(GA_VAULT_METHOD_ID)
    const authorization = await method.authorize({})
    expect(authorization.mode).toBe('auto')
    expect(authorization.url).toBe('')
    if (authorization.mode !== 'auto')
      throw new Error('Expected native automatic activation')
    const credential = await authorization.callback
    expect(activations).toBe(1)
    expect(isPlaceholderCredential(credential, 'google')).toBe(true)
    expect(String(credential.methodID)).toBe(GA_VAULT_METHOD_ID)
    await registration.dispose()
    expect(native.disposed()).toBe(true)
  })

  for (const authority of ['local', 'unreadable'] as const) {
    it(`refuses ${authority} authority before the host receives a placeholder`, async () => {
      const native = host()
      const registration = await registerGaAuthMethods(
        native.context,
        async () => authority,
      )
      try {
        const authorization = await vaultMethod(native.methods).authorize({})
        if (authorization.mode !== 'auto')
          throw new Error('Expected native automatic activation')
        await expect(authorization.callback).rejects.toThrow(
          'Approve Antigravity vault access',
        )
      } finally {
        await registration.dispose()
      }
    })
  }

  it('refuses a foreign Google credential on refresh without changing its bytes', async () => {
    const native = host()
    const registration = await registerGaAuthMethods(
      native.context,
      async () => 'vault',
    )
    try {
      const foreign = {
        ...placeholderCredential({
          integrationID: 'google',
          methodID: 'google-oauth',
          now: 0,
        }),
        refresh: 'dormant-google-refresh',
        access: 'dormant-google-access',
        expires: 1,
        metadata: {},
      }
      const before = JSON.stringify(foreign)
      const refresh = vaultMethod(native.methods).refresh
      if (!refresh) throw new Error('Owned refresh handler missing')
      await expect(refresh(foreign)).rejects.toThrow(
        'This login method refreshes only its vault placeholder',
      )
      expect(JSON.stringify(foreign)).toBe(before)
    } finally {
      await registration.dispose()
    }
  })
})
