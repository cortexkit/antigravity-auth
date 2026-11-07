import {
  ANTIGRAVITY_PROVIDER_ID,
  type EnrollmentAuthority,
  loadCommonAuthClaustrum,
  vaultAuthority,
} from '@cortexkit/antigravity-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import {
  OPENCODE2_POOL_RECONNECT_LABEL,
  OPENCODE2_VAULT_AUTH_LABEL,
} from '../../auth-method-labels.ts'
import {
  isPlaceholderCredential,
  registerOpenCode2AuthMethods,
} from '../../common-auth-embedded/opencode2/index.js'
import { getStoragePath } from '../../plugin/storage.ts'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_HOST,
} from '../../plugin/vault-custody.ts'
import { currentVaultFolder } from '../../vault-folder.ts'
import type { GaPluginOverrides } from './index.ts'
import {
  createGaPoolLogin,
  GA_POOL_RECONNECT_METHOD_ID,
  type GaLocalLogin,
} from './pool-login.ts'

export const GA_VAULT_METHOD_ID = 'antigravity-vault'

async function readAuthority(): Promise<EnrollmentAuthority> {
  // The vault folder the activation settled; an unsettled one is unreadable.
  const folder = currentVaultFolder(getStoragePath())
  if (folder.refusal) return 'unreadable'
  const claustrum = await loadCommonAuthClaustrum()
  const paths = claustrum.hostEnrollmentPaths({
    stateDir: folder.vaultDir,
    host: OPENCODE_VAULT_HOST,
  })
  return vaultAuthority(paths, OPENCODE_VAULT_ENROLLMENT_NAME, claustrum)
}

/** Adds pool and vault methods without modifying Google's native login methods. */
export async function registerGaAuthMethods(
  context: { integration: Pick<Plugin.Context['integration'], 'transform'> },
  authority: () => Promise<EnrollmentAuthority> = readAuthority,
  input: { local?: GaLocalLogin; oauth?: GaPluginOverrides['oauth'] } = {},
): Promise<Registration> {
  const local = input.local
  const pool = createGaPoolLogin({
    ...input,
    ...(local
      ? {
          local: {
            ...local,
            assertAdmission: async () => {
              if ((await loadCommonAuthClaustrum()).hasVaultHost())
                throw new Error('Vault authority excludes local sign-in.')
              await local.assertAdmission()
            },
          },
        }
      : {}),
  })
  const registrations: Registration[] = []
  try {
    registrations.push(
      await registerOpenCode2AuthMethods(context, {
        integrationID: ANTIGRAVITY_PROVIDER_ID,
        methods: [pool.method],
        onLogin: pool.onLogin,
        vault: {
          method: {
            id: GA_VAULT_METHOD_ID,
            type: 'oauth',
            label: OPENCODE2_VAULT_AUTH_LABEL,
          },
          async activate() {
            const current = await authority()
            if (!['host', 'vault'].includes(current)) {
              throw new Error(
                'Approve Antigravity vault access before activating this connection',
              )
            }
            if (current === 'host') {
              const client = (await loadCommonAuthClaustrum()).connectVaultHost(
                'antigravity-auth',
              )
              // Activation only probes the relay; serving owns a different client.
              await Promise.resolve(client.close()).catch(() => undefined)
              if ((await authority()) !== 'host')
                throw new Error('Vault authority changed during activation.')
            }
          },
        },
        label: 'Antigravity',
      }),
    )
    if (input.local?.assertExistingPool) {
      registrations.push(
        await context.integration.transform((editor) => {
          editor.method.update({
            integrationID: ANTIGRAVITY_PROVIDER_ID,
            method: {
              id: GA_POOL_RECONNECT_METHOD_ID,
              type: 'oauth',
              label: OPENCODE2_POOL_RECONNECT_LABEL,
            },
            authorize: async () => {
              const callback = pool.connectExisting()
              void callback.catch(() => {})
              return {
                mode: 'auto',
                url: '',
                instructions:
                  'No browser sign-in needed: connect the existing local Antigravity pool without changing its accounts.',
                callback,
              }
            },
            refresh: async (credential) => {
              if (
                !isPlaceholderCredential(credential, ANTIGRAVITY_PROVIDER_ID) ||
                credential.methodID !== GA_POOL_RECONNECT_METHOD_ID
              ) {
                throw new Error(
                  'This login method refreshes only its existing local pool placeholder.',
                )
              }
              return pool.connectExisting()
            },
            label: () => 'Antigravity',
          })
        }),
      )
    }
  } catch (error) {
    const stopping = pool.dispose()
    await Promise.allSettled(
      registrations.map((registration) => registration.dispose()),
    )
    await stopping
    throw error
  }
  let disposal: Promise<void> | undefined
  return {
    dispose() {
      disposal ??= (async () => {
        const stopping = pool.dispose()
        try {
          const results = await Promise.allSettled(
            registrations.map((registration) => registration.dispose()),
          )
          const failure = results.find((result) => result.status === 'rejected')
          if (failure?.status === 'rejected') throw failure.reason
        } finally {
          await stopping
        }
      })()
      return disposal
    },
  }
}
