import type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from '../antigravity/oauth'
import type { CommandAccountRow } from './command-data'
import { parseOAuthCallbackInput } from './oauth-methods'

type OAuthSuccess = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

interface OAuthPendingEntry {
  state: string
  verifier: string
  redirectUri: string
  createdAt: number
}

export interface AccountCommandOAuthServiceOptions {
  authorize: () => Promise<AntigravityAuthorization>
  exchange: (
    code: string,
    state: string,
  ) => Promise<AntigravityTokenExchangeResult>
  persist: (result: OAuthSuccess) => Promise<void>
  listAccounts: () => Promise<CommandAccountRow[]>
  now?: () => number
}

export interface AccountCommandOAuthService {
  start(sessionId: string): Promise<{
    url: string
    accounts: CommandAccountRow[]
  }>
  finish(
    sessionId: string,
    callbackInput: string,
    label?: string,
  ): Promise<{
    text: string
    accounts: CommandAccountRow[]
  }>
  dispose(): void
}

const OAUTH_PENDING_TTL_MS = 10 * 60 * 1_000
const OAUTH_PENDING_CAP = 50

export function createAccountCommandOAuthService(
  options: AccountCommandOAuthServiceOptions,
): AccountCommandOAuthService {
  const pendingBySession = new Map<string, OAuthPendingEntry>()
  const now = options.now ?? (() => Date.now())

  const cleanupExpired = (): void => {
    const current = now()
    for (const [sessionId, entry] of pendingBySession) {
      if (current - entry.createdAt > OAUTH_PENDING_TTL_MS) {
        pendingBySession.delete(sessionId)
      }
    }
  }

  const takePending = (sessionId: string): OAuthPendingEntry | undefined => {
    cleanupExpired()
    const entry = pendingBySession.get(sessionId)
    if (!entry || now() - entry.createdAt > OAUTH_PENDING_TTL_MS) {
      pendingBySession.delete(sessionId)
      return undefined
    }
    return entry
  }

  return {
    async start(sessionId) {
      const authorization = await options.authorize()
      const url = new URL(authorization.url)
      const state = url.searchParams.get('state')
      const redirectUri = url.searchParams.get('redirect_uri')
      if (!state || !redirectUri) {
        throw new Error('OAuth authorization URL is missing required state')
      }

      cleanupExpired()
      if (pendingBySession.size >= OAUTH_PENDING_CAP) {
        const oldest = [...pendingBySession.entries()].reduce(
          (previous, current) =>
            current[1].createdAt < previous[1].createdAt ? current : previous,
        )
        pendingBySession.delete(oldest[0])
      }
      pendingBySession.set(sessionId, {
        state,
        verifier: authorization.verifier,
        redirectUri,
        createdAt: now(),
      })
      return { url: authorization.url, accounts: await options.listAccounts() }
    },

    async finish(sessionId, callbackInput, label) {
      const pending = takePending(sessionId)
      if (!pending) {
        return {
          text: 'OAuth session expired. Please start again.',
          accounts: await options.listAccounts(),
        }
      }

      try {
        const callback = parseOAuthCallbackInput(callbackInput, pending.state)
        if ('error' in callback) {
          return {
            text: `OAuth authentication failed: ${callback.error}`,
            accounts: await options.listAccounts(),
          }
        }
        const result = await options.exchange(callback.code, callback.state)
        if (result.type === 'failed') {
          return {
            text: 'OAuth authentication failed. Please check the code and try again.',
            accounts: await options.listAccounts(),
          }
        }
        await options.persist({ ...result, label: label || result.label })
        return {
          text: 'OAuth account added.',
          accounts: await options.listAccounts(),
        }
      } catch {
        return {
          text: 'OAuth exchange failed due to a network error. Please try again.',
          accounts: await options.listAccounts(),
        }
      } finally {
        pendingBySession.delete(sessionId)
      }
    },

    dispose() {
      pendingBySession.clear()
    },
  }
}
