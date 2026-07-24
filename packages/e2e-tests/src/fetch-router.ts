/**
 * Standalone fetch-router helper. Lives outside `setup.ts` so non-test
 * entry points (debug scripts, ad-hoc harnesses) can install a router
 * without invoking the `bun:test` `beforeEach` hooks the rest of
 * `setup.ts` requires.
 *
 * `setup.ts` re-uses this module — the test preload installs
 * `globalThis.fetch = guardedFetch`, and `guardedFetch` consults the
 * router installed here. Production tests should always go through
 * `setup.ts`; this module is exposed only so debug code can plug into
 * the same deny-list infrastructure.
 */

let fetchRouter:
  | ((
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      host: typeof globalThis.fetch,
    ) => Promise<Response | undefined>)
  | null = null
let hostFetch: typeof globalThis.fetch | null = null

export function installFetchRouter(
  router: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    host: typeof globalThis.fetch,
  ) => Promise<Response | undefined>,
  host: typeof globalThis.fetch,
): void {
  fetchRouter = router
  hostFetch = host
}

export function resetFetchRouter(): void {
  fetchRouter = null
  hostFetch = null
}

export function runFetchRouter(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> | undefined {
  if (!fetchRouter) return undefined
  if (!hostFetch) return undefined
  return fetchRouter(input, init, hostFetch) as Promise<Response> | undefined
}
