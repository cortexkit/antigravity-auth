/**
 * Composition seam for the opencode Antigravity plugin.
 *
 * `createAntigravityPlugin` is the single host-facing factory. Its surface
 * stayed stable for years (input → PluginResult) so production callers
 * never needed to think about which fetch, transport, or OAuth primitive
 * actually runs under the hood. Tests had to either reach for
 * `mock.module('./agy-transport', …)` or stub `globalThis.fetch` — both
 * leaks that pull on module-graph seams that should be invisible to the
 * factory's public surface.
 *
 * The contract here is intentionally narrow:
 *   - Every dependency below has a default that maps to the current
 *     production function (i.e. no behavior change in production).
 *   - Tests inject deterministic doubles for fetch / transport / OAuth /
 *     filesystem roots / clock so the e2e workspace can run without
 *     hitting the public internet or a real disk root.
 *   - No dependency below is intended to leak into the public exports of
 *     `packages/opencode/index.ts`. That barrel stays at "create the
 *     plugin and give me a PluginResult" — the override shape is a test-
 *     time contract, not a stable API.
 *
 * Anything that already had an inline `dependencies:` injection point on
 * a sub-factory (auth-loader, oauth-methods) is intentionally NOT re-
 * surfaced here. Those seams already work; the goal of THIS file is to
 * catch the seams that did NOT exist yet (fetch, transport, env-resolved
 * filesystem roots, clock).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  type AgyTransportOptions,
  fetchWithAgyCliTransport,
} from '@cortexkit/antigravity-auth-core'

import { authorizeAntigravity, exchangeAntigravity } from '../antigravity/oauth'
import type { AntigravityConfig } from './config'
import type { GetAuth, PluginClient } from './types'

/**
 * Transport adapter shape — wraps the existing `fetchWithAgyCliTransport`
 * export from core so the interceptor never reaches across the package
 * boundary. Keeping it in this file (rather than re-exporting core)
 * means we can change the transport signature without rippling through
 * plugin callers.
 */
export type AgyTransport = (
  url: string,
  init?: RequestInit,
  options?: AgyTransportOptions,
) => Promise<Response>

/**
 * Per-call HTTP shape used for non-Antigravity URLs (e.g. loopback RPC,
 * local project probes). Tests inject a deterministic stub; production
 * keeps `globalThis.fetch` so the interceptor transparently benefits from
 * whatever fetch the host runtime provides.
 */
export type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface FilesystemRoots {
  /** Root used for project-scoped config (`{root}/.opencode/antigravity.json`). */
  projectRoot: string
  /** Root used for the user-level config (`~/.config/opencode/antigravity.json`). */
  userConfigRoot: string
  /** Root used for the sidebar state file. */
  sidebarStateRoot: string
  /** Root used for the RPC server port file. */
  rpcRoot: string
}

export interface OAuthOperations {
  authorize: typeof authorizeAntigravity
  exchange: typeof exchangeAntigravity
}

export interface ClockFunctions {
  now(): number
  random(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/**
 * Fully resolved dependency bag consumed by every plugin sub-module.
 *
 * `resolvePluginDependencies` fills any missing slot with the production
 * default; `createAntigravityPlugin` calls it once and threads the result
 * into fetch-interceptor / quota / auth-loader / oauth-methods.
 */
export interface PluginDependencies {
  fetchImpl: FetchImpl
  agyTransport: AgyTransport
  filesystemRoots: FilesystemRoots
  oauth: OAuthOperations
  clock: ClockFunctions
}

/**
 * User-supplied override bag — every field is optional. Production callers
 * omit it entirely; tests fill only the slots they care about (typically
 * `fetchImpl`, `agyTransport`, `filesystemRoots`).
 */
export interface PluginDependencyOverrides {
  fetchImpl?: FetchImpl
  agyTransport?: AgyTransport
  filesystemRoots?: Partial<FilesystemRoots>
  oauth?: Partial<OAuthOperations>
  clock?: Partial<ClockFunctions>
}

/**
 * Carry context the sub-factories need (the active client, the resolved
 * dependencies, plus the read-only config). Passed to the fetch
 * interceptor, quota manager, auth loader, and oauth methods so each
 * one sees the same bag without having to resolve defaults twice.
 */
export interface ResolvedPluginContext {
  client: PluginClient
  config: AntigravityConfig
  providerId: string
  directory: string
  dependencies: PluginDependencies
}

/**
 * Default filesystem roots that mirror the loader's production layout.
 *
 * Tests override `filesystemRoots` to point at a temp directory — the
 * plugin will then read/write config + sidebar + port files inside the
 * test's mkdtemp root, never touching the host's actual HOME or XDG
 * dirs.
 */
export function defaultFilesystemRoots(): FilesystemRoots {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const xdgState =
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return {
    projectRoot: process.cwd(),
    userConfigRoot: join(xdgConfig, 'opencode'),
    sidebarStateRoot: join(xdgState, 'cortexkit', 'antigravity-auth'),
    rpcRoot: join(xdgState, 'cortexkit', 'antigravity-auth', 'rpc'),
  }
}

/**
 * Build the default dependency bag used by production. Each default is
 * deliberately written so the e2e tests can re-use the same functions
 * (e.g. `fetchImpl` defaults to `globalThis.fetch` — a test that wants
 * a stub can replace `globalThis.fetch` and the production bag picks it
 * up on the next call).
 */
export function resolvePluginDependencies(
  overrides: PluginDependencyOverrides = {},
): PluginDependencies {
  const fetchImpl: FetchImpl =
    overrides.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const agyTransport: AgyTransport =
    overrides.agyTransport ?? fetchWithAgyCliTransport
  const roots = {
    ...defaultFilesystemRoots(),
    ...overrides.filesystemRoots,
  }
  const oauth: OAuthOperations = {
    authorize: overrides.oauth?.authorize ?? authorizeAntigravity,
    exchange: overrides.oauth?.exchange ?? exchangeAntigravity,
  }
  const clock: ClockFunctions = {
    now: overrides.clock?.now ?? (() => Date.now()),
    random: overrides.clock?.random ?? Math.random,
    sleep: overrides.clock?.sleep ?? defaultSleep,
  }
  return {
    fetchImpl,
    agyTransport,
    filesystemRoots: roots,
    oauth,
    clock,
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error('Aborted'),
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Default `getAuth` placeholder used by sub-modules that require one
 * (auth-loader, fetch-interceptor). The plugin entry builds the live
 * version once auth has loaded.
 */
export const placeholderGetAuth: GetAuth = async () => ({
  type: 'api_key',
  key: '',
})
