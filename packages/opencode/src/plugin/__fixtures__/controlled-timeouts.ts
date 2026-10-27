import { spyOn } from 'bun:test'

// A manual scheduler for tests whose collaborators do not perform timed I/O.
export function controlTimeouts() {
  type Handle = ReturnType<typeof setTimeout>
  const pending = new Map<Handle, { delay: number; fire: () => void }>()
  let scheduled = Promise.withResolvers<void>()
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ) => {
    const handle = { unref() {} } as Handle
    pending.set(handle, { delay, fire: () => callback(...args) })
    scheduled.resolve()
    return handle
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(
    (handle) => {
      pending.delete(handle as Handle)
    },
  )
  return {
    get size() {
      return pending.size
    },
    async waitForTimer() {
      if (!pending.size) await scheduled.promise
    },
    async next() {
      if (!pending.size) await scheduled.promise
      const [handle, timer] = pending.entries().next().value!
      pending.delete(handle)
      if (!pending.size) scheduled = Promise.withResolvers<void>()
      // Real timer callbacks run after the preceding tick's promise finalizers.
      await new Promise<void>((resolve) => setImmediate(resolve))
      timer.fire()
      return timer.delay
    },
    restore() {
      set.mockRestore()
      clear.mockRestore()
    },
  }
}
