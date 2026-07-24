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
  /**
   * Optional hook invoked AFTER persist completes successfully. The plugin
   * uses it to refresh the live AccountManager so the new account is
   * visible to routing immediately, without waiting for an auth reload.
   * Failures are swallowed — the OAuth flow still reports success and the
   * next periodic AccountManager reload picks up the new account.
   */
  onAfterPersist?: (result: OAuthSuccess) => Promise<void> | void
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
    // Consume the entry atomically with the take. A second concurrent
    // `add-oauth-finish` call must observe "no pending entry" even
    // before the first call's exchange completes — the previous
    // peek-then-finally pattern allowed two finish() calls to both
    // exchange and persist the same auth code.
    pendingBySession.delete(sessionId)
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

      // Stage 1: parse the callback URL/code. Failures here mean the
      // user pasted a malformed callback — exchange has not started.
      let callback: ReturnType<typeof parseOAuthCallbackInput>
      try {
        callback = parseOAuthCallbackInput(callbackInput, pending.state)
      } catch {
        return {
          text: 'OAuth authentication failed: could not parse the callback. Please try again.',
          accounts: await options.listAccounts(),
        }
      }
      if ('error' in callback) {
        return {
          text: `OAuth authentication failed: ${callback.error}`,
          accounts: await options.listAccounts(),
        }
      }

      // Stage 2: exchange the auth code with Google. Failures here mean
      // the network or token endpoint rejected the code — nothing has
      // been persisted yet.
      let result: Awaited<ReturnType<typeof options.exchange>>
      try {
        result = await options.exchange(callback.code, callback.state)
      } catch {
        return {
          text: 'OAuth exchange failed due to a network error. Please try again.',
          accounts: await options.listAccounts(),
        }
      }
      if (result.type === 'failed') {
        return {
          text: 'OAuth authentication failed. Please check the code and try again.',
          accounts: await options.listAccounts(),
        }
      }

      // Stage 3: persist the new account to disk. A failure here means
      // the account is NOT stored — surface the stage so the operator
      // can retry without thinking the previous error already landed it.
      const persisted: OAuthSuccess = {
        ...result,
        label: label || result.label,
      }
      try {
        await options.persist(persisted)
      } catch {
        return {
          text: 'OAuth account could not be saved to disk. Please try again.',
          accounts: await options.listAccounts(),
        }
      }

      // Refresh the live AccountManager so routing sees the new account
      // immediately instead of waiting for the next auth reload. Errors
      // here are non-fatal — the on-disk write already landed.
      try {
        await options.onAfterPersist?.(persisted)
      } catch {
        // Best-effort refresh; swallow failures.
      }

      // Stage 4: re-list the account pool. If the post-persist read
      // fails for any reason (lock contention, I/O) we still report the
      // successful add — the dialog will refresh on its next open.
      let accounts: CommandAccountRow[]
      try {
        accounts = await options.listAccounts()
      } catch {
        return {
          text: 'OAuth account added.',
          accounts: [],
        }
      }
      return {
        text: 'OAuth account added.',
        accounts,
      }
    },

    dispose() {
      pendingBySession.clear()
    },
  }
}
