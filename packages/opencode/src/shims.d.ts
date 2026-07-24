declare module '@openauthjs/openauth/pkce' {
  interface PkcePair {
    challenge: string
    verifier: string
  }

  export function generatePKCE(): Promise<PkcePair>
}

/**
 * Ambient declarations for OpenTUI's internal `scripts/solid-transform`
 * helper. The `@opentui/solid` package does not export this subpath, but
 * `scripts/build-tui.ts` consumes it directly so we declare the module
 * shape here to keep `tsc --noEmit` happy without reaching into node_modules.
 */
declare module '@opentui/solid/scripts/solid-transform' {
  export type ResolveImportPath = (specifier: string) => string | null
  export interface TransformSolidSourceOptions {
    filename: string
    moduleName?: string
    resolvePath?: ResolveImportPath
  }
  export function stripQueryAndHash(path: string): string
  export function isNodeModulesPath(path: string): boolean
  export function resolveNodeSolidRuntimeImport(
    specifier: string,
  ): string | null
  export function transformSolidSource(
    code: string,
    options: TransformSolidSourceOptions,
  ): Promise<string>
}
