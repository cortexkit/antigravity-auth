/** Install a host bridge for one operation without leaking it into another test. */
export async function withVaultHost<T>(
  marker: 'thalamus' | undefined,
  accessor: ((pluginId: string) => unknown) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const key = Symbol.for('cortexkit.vault')
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const previousMarker = process.env.CORTEXKIT_VAULT_HOST
  if (marker === undefined) delete process.env.CORTEXKIT_VAULT_HOST
  else process.env.CORTEXKIT_VAULT_HOST = marker
  if (accessor)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: accessor,
    })
  else Reflect.deleteProperty(globalThis, key)
  try {
    return await operation()
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
    if (previousMarker === undefined) delete process.env.CORTEXKIT_VAULT_HOST
    else process.env.CORTEXKIT_VAULT_HOST = previousMarker
  }
}

/** Each accessor call creates a fresh client; track its close calls separately. */
export function createVaultHostRelay<
  T extends { close(): void | Promise<void> },
>(createClient: () => T) {
  const calls: { pluginId: string; client: T; closes: number }[] = []
  return {
    calls,
    accessor(pluginId: string): T {
      const client = createClient()
      if (calls.some((call) => call.client === client))
        throw new Error(
          'The test relay must create a fresh client for each call.',
        )
      const close = client.close.bind(client)
      const call = { pluginId, client, closes: 0 }
      client.close = () => {
        call.closes++
        return close()
      }
      calls.push(call)
      return client
    },
  }
}

/** Probe fixture with no accounts; wrap it in createVaultHostRelay to track ownership. */
export function emptyVaultHostClient() {
  return {
    async listScoped() {
      return { view: 'empty', rows: [] }
    },
    async getScoped() {
      throw new Error('An empty relay cannot serve a credential.')
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
}
