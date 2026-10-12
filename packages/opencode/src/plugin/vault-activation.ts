import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type EnrollmentAuthority,
  loadCommonAuthClaustrum,
} from '@cortexkit/antigravity-auth-core'
import type { AuthMethod } from './types'

export const V1_VAULT_ACTIVATION_LABEL = 'Activate approved Antigravity vault'

export function nativeOpenCodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(
    env.XDG_DATA_HOME || join(home, '.local', 'share'),
    'opencode',
    'auth.json',
  )
}

/** Activate a fresh host slot without a Google login or a local account write. */
export function createV1VaultActivationMethod(input: {
  providerId: string
  readAuthority: () => Promise<EnrollmentAuthority>
  authFile?: () => string
}): AuthMethod {
  return {
    type: 'oauth',
    label: V1_VAULT_ACTIVATION_LABEL,
    authorize: async () => ({
      url: '',
      method: 'auto',
      instructions:
        'Vault access is approved. Activate it without signing in to Google.',
      callback: async () => {
        try {
          if ((await input.readAuthority()) !== 'vault')
            return { type: 'failed' }
          try {
            const value: unknown = JSON.parse(
              await readFile(
                (input.authFile ?? nativeOpenCodeAuthPath)(),
                'utf8',
              ),
            )
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.hasOwn(value, input.providerId)
            )
              return { type: 'failed' }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'ENOENT'
            )
              return { type: 'failed' }
          }
          // Only explicit setup reads the host slot. OpenCode persists this
          // non-secret result; serving never reads or replaces an existing login.
          const claustrum = await loadCommonAuthClaustrum()
          if ((await input.readAuthority()) !== 'vault')
            return { type: 'failed' }
          return {
            ...claustrum.custodyPlaceholder(input.providerId),
            type: 'success',
          }
        } catch {
          return { type: 'failed' }
        }
      },
    }),
  }
}
