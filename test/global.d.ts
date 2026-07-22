/**
 * Type declarations for helpers installed on `globalThis` by `test/setup.ts`.
 * Bun has no stubGlobal / resetModules primitives, so the preload wires
 * three small helpers onto the global so tests can spell the missing APIs
 * with a stable shape.
 */

declare global {
  // eslint-disable-next-line no-var
  var stubbed: (name: string, value: unknown) => void
  // eslint-disable-next-line no-var
  var unstubAllGlobals: () => void
  // eslint-disable-next-line no-var
  var freshImport: (specifier: string) => Promise<unknown>
}

export {}
