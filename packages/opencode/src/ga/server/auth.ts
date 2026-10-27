import {
  ANTIGRAVITY_PROVIDER_ID,
  type EnrollmentAuthority,
  enrollmentAuthority,
  loadCommonAuthClaustrum,
} from '@cortexkit/antigravity-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import { OPENCODE2_VAULT_AUTH_LABEL } from '../../auth-method-labels.ts'
import { registerOpenCode2AuthMethods } from '../../common-auth-embedded/opencode2/index.js'
import { getStoragePath } from '../../plugin/storage.ts'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_HOST,
} from '../../plugin/vault-custody.ts'
import { currentVaultFolder } from '../../vault-folder.ts'
import type { GaPluginOverrides } from './index.ts'
import { createGaPoolLogin, type GaLocalLogin } from './pool-login.ts'

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
  return enrollmentAuthority(paths, OPENCODE_VAULT_ENROLLMENT_NAME, claustrum)
}

/** Adds pool and vault methods without modifying Google's native login methods. */
export async function registerGaAuthMethods(
  context: { integration: Pick<Plugin.Context['integration'], 'transform'> },
  authority: () => Promise<EnrollmentAuthority> = readAuthority,
  input: { local?: GaLocalLogin; oauth?: GaPluginOverrides['oauth'] } = {},
): Promise<Registration> {
  const pool = createGaPoolLogin(input)
  const registration = await registerOpenCode2AuthMethods(context, {
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
        if ((await authority()) !== 'vault') {
          throw new Error(
            'Approve Antigravity vault access before activating this connection',
          )
        }
      },
    },
    label: 'Antigravity',
  })
  let disposal: Promise<void> | undefined
  return {
    dispose() {
      disposal ??= (async () => {
        const stopping = pool.dispose()
        try {
          await registration.dispose()
        } finally {
          await stopping
        }
      })()
      return disposal
    },
  }
}
