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
