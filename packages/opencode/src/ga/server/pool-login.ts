import {
  AccountStoreBusyError,
  ANTIGRAVITY_PROVIDER_ID,
  type AntigravityTokenExchangeResult,
  authorizeAntigravity,
  createOAuthCallbackValidator,
  exchangeAntigravity,
} from '@cortexkit/antigravity-auth-core'
import { EngineRefusalError } from '@cortexkit/antigravity-auth-core/engine'

import {
  GA_POOL_PASTE_PROMPT,
  OPENCODE2_POOL_AUTH_LABEL,
  OPENCODE2_POOL_PASTE_AUTH_LABEL,
} from '../../auth-method-labels.ts'
import type { PoolLoginMethod } from '../../common-auth-embedded/opencode2/index.js'
import { placeholderCredential } from '../../common-auth-embedded/opencode2/index.js'
import { type OAuthListener, startOAuthListener } from '../../plugin/server.ts'
import type { GaPluginOverrides } from './index.ts'

export const GA_POOL_METHOD_ID = 'antigravity-auth-pool-browser'
export const GA_POOL_PASTE_METHOD_ID = 'antigravity-auth-pool-paste'
export const GA_POOL_RECONNECT_METHOD_ID = 'antigravity-auth-pool-reconnect'
type LoginResult = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

export interface GaLocalLogin {
  assertAdmission(): Promise<void>
  assertExistingPool?(admit: () => Promise<void>): Promise<void>
  persist(result: LoginResult, admit: () => Promise<void>): Promise<void>
}

export interface GaPoolLoginAttempt {
  readonly url: string
  readonly completion: Promise<LoginResult>
  paste(value: string): Promise<LoginResult>
  cancel(): Promise<void>
}

interface GaPoolLogin {
  readonly method: PoolLoginMethod<LoginResult>
  readonly pasteMethod: PoolLoginMethod<LoginResult>
  start(listen?: boolean): Promise<GaPoolLoginAttempt>
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
    } catch (error) {
      if (error instanceof EngineRefusalError) throw error
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
  const start = (listen = true): Promise<GaPoolLoginAttempt> =>
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
        const validator = createOAuthCallbackValidator(authorization.url)
        const { state } = validator
        if (!state) throw new Error(LOGIN_FAILED)
        let listener: OAuthListener | undefined
        const code = Promise.withResolvers<string>()
        const claim = (value: string | URL) => {
          const result = validator.claim(value)
          if ('error' in result) throw new Error(LOGIN_FAILED)
          code.resolve(result.code)
        }
        const waitForCode = input.oauth?.waitForCode
        if (listen && waitForCode) {
          void Promise.resolve()
            .then(() => waitForCode(state))
            .then(claim, code.reject)
            .catch(() => {})
        } else if (listen) {
          // Do not queue listener startup: an occupied callback port must return the listener's fixed error.
          listener = await startOAuthListener()
          listeners.add(listener)
          void listener
            .waitForCallback()
            .then(claim, code.reject)
            .catch(code.reject)
        }
        // Handle callback rejection even if local sign-in is refused before the code is awaited.
        void code.promise.catch(() => {})
        try {
          await admit()
        } catch (error) {
          if (listener) await close(listener)
          throw error
        }
        const ownedListener = listener
        const cancellation = new AbortController()
        const signal = AbortSignal.any([shutdown.signal, cancellation.signal])
        const admitAttempt = async () => {
          signal.throwIfAborted()
          await admit()
          signal.throwIfAborted()
        }
        const timeout = setTimeout(
          () => code.reject(new Error(LOGIN_FAILED)),
          5 * 60 * 1000,
        )
        timeout.unref?.()
        const callback = track(
          (async () => {
            try {
              await admitAttempt()
              const value = await abortable(code.promise, signal)
              if (ownedListener) await close(ownedListener)
              await admitAttempt()
              const result = await abortable(
                (input.oauth?.exchange ?? exchangeAntigravity)(value, state, {
                  signal,
                  admit: admitAttempt,
                }),
                signal,
              )
              await admitAttempt()
              if (result.type !== 'success') throw new Error(LOGIN_FAILED)
              return result
            } catch (error) {
              if (error instanceof EngineRefusalError) throw error
              throw new Error(LOGIN_FAILED)
            } finally {
              validator.close()
              clearTimeout(timeout)
              if (ownedListener) await close(ownedListener)
            }
          })(),
        )
        // The host attaches its callback handler only after authorize returns.
        void callback.catch(() => {})
        return {
          url: authorization.url,
          completion: callback,
          async paste(value) {
            await admitAttempt()
            if (listen && !value.trim()) return callback
            claim(value)
            return callback
          },
          async cancel() {
            validator.close()
            cancellation.abort(new Error(LOGIN_FAILED))
            code.reject(new Error(LOGIN_FAILED))
            if (ownedListener) await close(ownedListener)
          },
        }
      })(),
    )
  const method: PoolLoginMethod<LoginResult> = {
    method: {
      id: GA_POOL_METHOD_ID,
      type: 'oauth',
      label: OPENCODE2_POOL_AUTH_LABEL,
    },
    async authorize() {
      const attempt = await start()
      return {
        mode: 'auto',
        url: attempt.url,
        instructions: 'Complete Google sign-in in your browser.',
        callback: attempt.completion,
      }
    },
  }
  const pasteMethod: PoolLoginMethod<LoginResult> = {
    method: {
      id: GA_POOL_PASTE_METHOD_ID,
      type: 'oauth',
      label: OPENCODE2_POOL_PASTE_AUTH_LABEL,
    },
    async authorize() {
      const attempt = await start(false)
      return {
        mode: 'code',
        url: attempt.url,
        instructions: GA_POOL_PASTE_PROMPT,
        callback: (value) => attempt.paste(value),
      }
    },
  }
  return {
    method,
    pasteMethod,
    start,
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
            if (error instanceof EngineRefusalError) throw error
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
