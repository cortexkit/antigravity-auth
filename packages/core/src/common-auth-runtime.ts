/**
 * Typed, lazily loaded bindings to the public entries of @cortexkit/common-auth
 * that this package ships inside itself.
 *
 * The library's public `./store`, `./fs`, `./routing`, `./quota`,
 * `./commands`, `./auth-menu`, `./claustrum` and `./logger` entries are copied
 * byte for byte from the verified library archive into `common-auth-embedded/`
 * by the repository's single common-auth emitter; `source-output.json` there
 * records the archive and every file hash. Nothing here re-implements or wraps
 * library behaviour: each type is the genuine module namespace type, and each
 * loader returns the genuine module.
 *
 * The loaders use dynamic imports so that importing the package root does not
 * evaluate the store, the command menu or the vault client. A loaded module is
 * cached for the life of the process; a failed load is not cached, so a later
 * call can retry it. `./claustrum` additionally needs the
 * `@cortexkit/claustrum-client` dependency, which is only resolved when
 * `loadCommonAuthClaustrum` is called.
 *
 * Static consumers can import the same modules through this package's
 * `./common-auth/<entry>` subpath exports instead.
 */

/** The library's public `./store` entry: the lease-backed pool store. */
export type CommonAuthStoreModule =
  typeof import('./common-auth-embedded/store/index.js')
/** The library's public `./fs` entry: file leases and atomic writes. */
export type CommonAuthFsModule =
  typeof import('./common-auth-embedded/fs/index.js')
/** The library's public `./routing` entry: admission and route selection. */
export type CommonAuthRoutingModule =
  typeof import('./common-auth-embedded/routing/index.js')
/** The library's public `./quota` entry: quota maps, merge and projection. */
export type CommonAuthQuotaModule =
  typeof import('./common-auth-embedded/quota/index.js')
/** The library's public `./commands` entry: the shared command menu. */
export type CommonAuthCommandsModule =
  typeof import('./common-auth-embedded/commands/index.js')
/** The library's public `./auth-menu` entry: the terminal account menu. */
export type CommonAuthAuthMenuModule =
  typeof import('./common-auth-embedded/auth-menu/index.js')
/** The library's public `./claustrum` entry: vault credential custody. */
export type CommonAuthClaustrumModule =
  typeof import('./common-auth-embedded/claustrum/index.js')
/** The library's public `./logger` entry: the redacting logger engine. */
export type CommonAuthLoggerModule =
  typeof import('./common-auth-embedded/logger/index.js')

/**
 * The `./store` and `./fs` entries of one library copy, as an account
 * repository is built on them. Both come from the same embedded copy, so the
 * store's own locks and the repository's file leases share one implementation.
 */
export interface CommonAuthStoreModules {
  readonly store: CommonAuthStoreModule
  readonly fs: CommonAuthFsModule
}

function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (!pending) {
      pending = load().catch((error: unknown) => {
        pending = undefined
        throw error
      })
    }
    return pending
  }
}

/** Loads the library's public `./store` entry. */
export const loadCommonAuthStore: () => Promise<CommonAuthStoreModule> =
  memoize(() => import('./common-auth-embedded/store/index.js'))

/** Loads the library's public `./fs` entry. */
export const loadCommonAuthFs: () => Promise<CommonAuthFsModule> = memoize(
  () => import('./common-auth-embedded/fs/index.js'),
)

/** Loads the library's public `./routing` entry. */
export const loadCommonAuthRouting: () => Promise<CommonAuthRoutingModule> =
  memoize(() => import('./common-auth-embedded/routing/index.js'))

/** Loads the library's public `./quota` entry. */
export const loadCommonAuthQuota: () => Promise<CommonAuthQuotaModule> =
  memoize(() => import('./common-auth-embedded/quota/index.js'))

/** Loads the library's public `./commands` entry. */
export const loadCommonAuthCommands: () => Promise<CommonAuthCommandsModule> =
  memoize(() => import('./common-auth-embedded/commands/index.js'))

/** Loads the library's public `./auth-menu` entry. */
export const loadCommonAuthAuthMenu: () => Promise<CommonAuthAuthMenuModule> =
  memoize(() => import('./common-auth-embedded/auth-menu/index.js'))

/**
 * Loads the library's public `./claustrum` entry. This also loads the
 * installed `@cortexkit/claustrum-client`; a missing client rejects here, not
 * when the package root is imported.
 */
export const loadCommonAuthClaustrum: () => Promise<CommonAuthClaustrumModule> =
  memoize(() => import('./common-auth-embedded/claustrum/index.js'))

/** Loads the library's public `./logger` entry. */
export const loadCommonAuthLogger: () => Promise<CommonAuthLoggerModule> =
  memoize(() => import('./common-auth-embedded/logger/index.js'))

/** Loads the `./store` and `./fs` entries an account repository needs. */
export async function loadCommonAuthStoreModules(): Promise<CommonAuthStoreModules> {
  const [store, fs] = await Promise.all([
    loadCommonAuthStore(),
    loadCommonAuthFs(),
  ])
  return { store, fs }
}
