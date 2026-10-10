import { afterAll, afterEach, beforeEach, it, test } from 'bun:test'
import { TestLifetime } from './test-lifetime.ts'

/** Create once in each file so hooks and ownership remain scoped to that file. */
export function lifetimeHooks(hookTimeout = 5_000) {
  let lifetime = new TestLifetime()
  beforeEach(async () => {
    // Do not run successor setup while the previous body can still use its state.
    const name = lifetime.pendingBodyName
    const drained = lifetime.drain(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (name) {
        // An overloaded event loop may let Bun's deadline run before our timer.
        // Print the owner immediately as well, so even that failure has context.
        console.error(`Waiting for previous test body: ${name}`)
        // Fail before Bun abandons this hook so the diagnostic names the owner.
        // The drain continues; neither cleanup nor successor setup runs early.
        await Promise.race([
          drained,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`Still waiting for previous test body: ${name}`),
                ),
              hookTimeout * 0.9,
            )
          }),
        ])
      } else await drained
      lifetime = new TestLifetime()
    } finally {
      clearTimeout(timer)
    }
  }, hookTimeout)
  // Same budget as the other lifetime hooks: by default Bun's own 5 s, and a
  // short child fixture's whole run stays bounded by the timeout it chose.
  afterAll(() => lifetime.drain(() => {}), hookTimeout)

  function registrar<T extends typeof test>(register: T, owner?: unknown): T {
    return new Proxy(register, {
      apply: (target, receiver, args: unknown[]) => {
        const body = args[1]
        if (typeof body === 'function') {
          args[1] = (...values: unknown[]) =>
            lifetime.runnerBody(() => {
              if (body.length <= values.length)
                return Reflect.apply(body, undefined, values)
              return new Promise<void>((resolve, reject) => {
                Reflect.apply(body, undefined, [
                  ...values,
                  (error?: unknown) =>
                    error === undefined ? resolve() : reject(error),
                ])
              })
            }, String(args[0]))
        }
        return Reflect.apply(target, owner ?? receiver, args)
      },
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver)
        if (
          ['each', 'skipIf', 'todoIf', 'if'].includes(String(key)) &&
          typeof value === 'function'
        )
          return (...args: unknown[]) =>
            registrar(Reflect.apply(value, target, args) as typeof test)
        return typeof value === 'function'
          ? registrar(value as typeof test, target)
          : value
      },
    })
  }

  function hook(body: Parameters<typeof afterEach>[0]): Promise<unknown> {
    if (body.length === 0)
      return Promise.resolve().then(() => Reflect.apply(body, undefined, []))
    return new Promise<void>((resolve, reject) => {
      Reflect.apply(body, undefined, [
        (error?: unknown) => (error === undefined ? resolve() : reject(error)),
      ])
    })
  }

  return {
    it: registrar(it),
    test: registrar(test),
    afterEach: ((body, timeout) =>
      afterEach(
        () => lifetime.drain(() => hook(body)),
        timeout,
      )) as typeof afterEach,
    afterAll: ((body, timeout) =>
      afterAll(
        () => lifetime.drain(() => hook(body)),
        timeout,
      )) as typeof afterAll,
    get lifetime() {
      return lifetime
    },
  }
}
