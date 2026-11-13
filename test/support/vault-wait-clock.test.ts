import type { VaultConsumerOptions } from '../../packages/core/dist/index.js'

/** A manual vault clock; disk reads still finish on the real event loop. */
export function vaultWaitClock() {
  const origin = Date.now()
  let elapsed = 0
  let id = 0
  const timers = new Map<
    number,
    { at: number; delay: number; callback: () => void }
  >()
  const setTimeoutImpl = ((callback: () => void, ms: number) => {
    const key = ++id
    timers.set(key, { at: elapsed + ms, delay: ms, callback })
    return key
  }) as unknown as NonNullable<VaultConsumerOptions['setTimeoutImpl']>
  const clearTimeoutImpl = ((key: number) => {
    timers.delete(key)
  }) as unknown as NonNullable<VaultConsumerOptions['clearTimeoutImpl']>
  const clock = {
    now: () => origin + elapsed,
    elapsed: () => elapsed,
    pending: () => timers.size,
    pendingDelays: () =>
      [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b),
    setTimeoutImpl,
    clearTimeoutImpl,
    schedule(callback: () => void, ms: number) {
      const key = setTimeoutImpl(callback, ms)
      return () => clearTimeoutImpl(key)
    },
    advance(ms: number) {
      elapsed += ms
      for (const [key, timer] of [...timers]) {
        if (timer.at <= elapsed && timers.delete(key)) timer.callback()
      }
    },
    async drive<T>(pending: Promise<T>, onTick?: () => void): Promise<T> {
      let done = false
      const result = pending.finally(() => {
        done = true
      })
      // Observe rejection now, not after advancing the clock.
      void result.catch(() => {})
      for (let step = 0; !done && step < 1400; step++) {
        await Bun.sleep(1)
        if (!done) {
          onTick?.()
          clock.advance(50)
        }
      }
      if (!done)
        throw new Error(
          'vault request did not settle within the manual clock horizon',
        )
      return result
    },
  }
  return clock
}
