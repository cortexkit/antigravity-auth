import {
  AccountStoreBusyError,
  ANTIGRAVITY_PROVIDER_ID,
  type AntigravityTokenExchangeResult,
  authorizeAntigravity,
  exchangeAntigravity,
} from '@cortexkit/antigravity-auth-core'
import { OPENCODE2_POOL_AUTH_LABEL } from '../../auth-method-labels.ts'
import type { PoolLoginMethod } from '../../common-auth-embedded/opencode2/index.js'
import { placeholderCredential } from '../../common-auth-embedded/opencode2/index.js'
import { type OAuthListener, startOAuthListener } from '../../plugin/server.ts'
import type { GaPluginOverrides } from './index.ts'

export const GA_POOL_METHOD_ID = 'antigravity-auth-pool-browser'
export const GA_POOL_RECONNECT_METHOD_ID = 'antigravity-auth-pool-reconnect'
type LoginResult = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

export interface GaLocalLogin {
  assertAdmission(): Promise<void>
  assertExistingPool?(admit: () => Promise<void>): Promise<void>
  persist(result: LoginResult, admit: () => Promise<void>): Promise<void>
}

interface GaPoolLogin {
  readonly method: PoolLoginMethod<LoginResult>
  onLogin(result: LoginResult): Promise<void>
  connectExisting(): Promise<ReturnType<typeof placeholderCredential>>
  dispose(): Promise<void>
}

const LOGIN_FAILED = 'The Antigravity pool login could not be completed.'

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

export function createGaPoolLogin(input: {
  local?: GaLocalLogin
  oauth?: GaPluginOverrides['oauth']
}): GaPoolLogin {
  const shutdown = new AbortController()
  const listeners = new Set<OAuthListener>()
  const pending = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }
  const admit = async () => {
    try {
      shutdown.signal.throwIfAborted()
      if (!input.local) throw new Error(LOGIN_FAILED)
      await input.local.assertAdmission()
      shutdown.signal.throwIfAborted()
    } catch {
      throw new Error(LOGIN_FAILED)
    }
  }
  const close = async (listener: OAuthListener) => {
    try {
      await listener.close()
    } finally {
      listeners.delete(listener)
    }
  }
  const method: PoolLoginMethod<LoginResult> = {
    method: {
      id: GA_POOL_METHOD_ID,
      type: 'oauth',
      label: OPENCODE2_POOL_AUTH_LABEL,
    },
    authorize: () =>
      track(
        (async () => {
          await admit()
          const authorization = await (async () => {
            try {
              return await abortable(
                (input.oauth?.authorize ?? authorizeAntigravity)(),
                shutdown.signal,
              )
            } catch {
              throw new Error(LOGIN_FAILED)
            }
          })()
          await admit()
          const state = new URL(authorization.url).searchParams.get('state')
          if (!state) throw new Error(LOGIN_FAILED)
          let listener: OAuthListener | undefined
          let code: Promise<string>
          const waitForCode = input.oauth?.waitForCode
          if (waitForCode) {
            code = Promise.resolve().then(() => waitForCode(state))
          } else {
            // Do not queue listener startup: an occupied callback port must return the listener's fixed error.
            listener = await startOAuthListener()
            listeners.add(listener)
            code = listener.waitForCallback().then((url) => {
              if (url.searchParams.get('state') !== state)
                throw new Error(LOGIN_FAILED)
              const value = url.searchParams.get('code')
              if (!value) throw new Error(LOGIN_FAILED)
              return value
            })
          }
          // Handle callback rejection even if a lost-authority check prevents awaiting the code.
          void code.catch(() => {})
          try {
            await admit()
          } catch (error) {
            if (listener) await close(listener)
            throw error
          }
          const ownedListener = listener
          const callback = track(
            (async () => {
              try {
                await admit()
                const value = await abortable(code, shutdown.signal)
                await admit()
                const result = await abortable(
                  (input.oauth?.exchange ?? exchangeAntigravity)(value, state, {
                    signal: shutdown.signal,
                    admit,
                  }),
                  shutdown.signal,
                )
                await admit()
                if (result.type !== 'success') throw new Error(LOGIN_FAILED)
                return result
              } catch {
                throw new Error(LOGIN_FAILED)
              } finally {
                if (ownedListener) await close(ownedListener)
              }
            })(),
          )
          // The host attaches its callback handler only after authorize returns.
          void callback.catch(() => {})
          return {
            mode: 'auto' as const,
            url: authorization.url,
            instructions: 'Complete Google sign-in in your browser.',
            callback,
          }
        })(),
      ),
  }
  return {
    method,
    connectExisting: () =>
      track(
        (async () => {
          let stage = 'initial-admission'
          try {
            await admit()
            if (!input.local?.assertExistingPool) throw new Error(LOGIN_FAILED)
            stage = 'existing-pool-admission'
            // Track the underlying read too: disposal must wait even if abort
            // has already refused the marker to the host.
            await abortable(
              track(input.local.assertExistingPool(admit)),
              shutdown.signal,
            )
            stage = 'final-admission'
            await admit()
            stage = 'placeholder'
            return placeholderCredential({
              integrationID: ANTIGRAVITY_PROVIDER_ID,
              methodID: GA_POOL_RECONNECT_METHOD_ID,
              now: Date.now(),
            })
          } catch (error) {
            const busy = error instanceof AccountStoreBusyError
            // Only fixed codes cross this diagnostic boundary, never raw errors.
            try {
              console.warn(
                `[antigravity.pool-login] stage=${stage} reason=${busy ? 'store-busy' : 'store-refusal'}`,
              )
            } catch {
              // A failed diagnostic sink must not change the host's fixed refusal.
            }
            if (busy) throw new AccountStoreBusyError()
            throw new Error(LOGIN_FAILED)
          }
        })(),
      ),
    onLogin: (result: LoginResult) =>
      track(
        (async () => {
          try {
            await admit()
            await input.local!.persist(result, admit)
            await admit()
          } catch (error) {
            // A durable row is retained even when a later check refuses the host placeholder.
            if (error instanceof AccountStoreBusyError)
              throw new AccountStoreBusyError()
            throw new Error(LOGIN_FAILED)
          }
        })(),
      ),
    async dispose() {
      shutdown.abort(new Error(LOGIN_FAILED))
      await Promise.allSettled([...listeners].map(close))
      while (pending.size) await Promise.allSettled([...pending])
    },
  }
}
