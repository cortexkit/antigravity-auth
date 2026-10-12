import {
  ANTIGRAVITY_PROVIDER_ID,
  type EnrollmentAuthority,
  enrollmentAuthority,
  loadCommonAuthClaustrum,
} from '@cortexkit/antigravity-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'

import { registerOpenCode2AuthMethods } from '../../common-auth-embedded/opencode2/index.js'
import { getStoragePath } from '../../plugin/storage.ts'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_HOST,
  openCodeVaultPaths,
} from '../../plugin/vault-custody.ts'

export const GA_VAULT_METHOD_ID = 'antigravity-vault'

async function readAuthority(): Promise<EnrollmentAuthority> {
  const claustrum = await loadCommonAuthClaustrum()
  const paths = claustrum.hostEnrollmentPaths({
    stateDir: openCodeVaultPaths(getStoragePath()).dir,
    host: OPENCODE_VAULT_HOST,
  })
  return enrollmentAuthority(paths, OPENCODE_VAULT_ENROLLMENT_NAME, claustrum)
}

/** Adds one native vault activation method without modifying Google's existing login methods. */
export function registerGaVaultActivation(
  context: { integration: Pick<Plugin.Context['integration'], 'transform'> },
  authority: () => Promise<EnrollmentAuthority> = readAuthority,
): Promise<Registration> {
  return registerOpenCode2AuthMethods(context, {
    integrationID: ANTIGRAVITY_PROVIDER_ID,
    methods: [],
    onLogin() {
      throw new Error('Vault activation does not accept local login results')
    },
    vault: {
      method: {
        id: GA_VAULT_METHOD_ID,
        type: 'oauth',
        label: 'Use approved Antigravity vault',
      },
      async activate() {
        if ((await authority()) !== 'vault') {
          throw new Error(
            'Approve Antigravity vault access before activating this connection',
          )
        }
      },
    },
    label: 'Antigravity vault',
  })
}
