import { describe, expect, it } from 'bun:test'
import type {
  IntegrationEditor,
  IntegrationMethodRegistration,
  IntegrationOAuthMethodRegistration,
} from '@opencode/plugin/promise/integration'

import {
  isPlaceholderCredential,
  placeholderCredential,
} from '../../common-auth-embedded/opencode2/index.js'
import { GA_VAULT_METHOD_ID, registerGaVaultActivation } from './auth.ts'

function host() {
  const methods: IntegrationMethodRegistration[] = []
  let disposed = false
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
            },
          }
        },
      },
    },
    methods,
    disposed: () => disposed,
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

describe('GA native vault activation', () => {
  it('adds only its own method and returns an owned placeholder without a local login or credential mutation', async () => {
    const native = host()
    let activations = 0
    const registration = await registerGaVaultActivation(
      native.context,
      async () => {
        activations++
        return 'vault'
      },
    )
    expect(native.methods).toHaveLength(1)
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
      const registration = await registerGaVaultActivation(
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
    const registration = await registerGaVaultActivation(
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
