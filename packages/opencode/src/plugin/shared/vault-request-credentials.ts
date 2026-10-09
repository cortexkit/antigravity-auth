/**
 * Vault-held accounts for the shared request engine, used by OpenCode 1 and
 * OpenCode 2 alike: selection rows built from the vault's selectable routes,
 * and the engine's `vault` credential domain over a vault account source.
 *
 * A row carries the route and selection bookkeeping only; no token, refresh
 * token, project or local repository reference. Every physical send asks
 * the source for a fresh receipt for the selected row's route and uses that
 * receipt's token and project for that send only; a 401 is reported against
 * the exact receipt that served it. Nothing is refreshed locally, cached or
 * written to a row.
 *
 * The module imports no host SDK and no composition root: the source is the
 * core vault account source (or anything with the same operations).
 */

import type {
  AntigravityVaultAccountSource,
  SelectableAccount,
  VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'

import type {
  RequestSendAdmission,
  VaultRequestCredentials,
} from './request-services.ts'

/** The vault account source operations a vault request path uses. */
export type VaultRequestSource = Pick<
  AntigravityVaultAccountSource,
  'refresh' | 'routes' | 'admit' | 'reportServedStatus'
>

/**
 * A vault-backed pool row: selection metadata plus the vault route it was
 * listed under.
 */
export type VaultAccountRow = SelectableAccount & {
  route: VaultRouteRef
}

/**
 * Selection rows for the vault's selectable routes, in roster order, with
 * no selection history.
 */
export function vaultAccountRows(
  routes: readonly VaultRouteRef[],
): VaultAccountRow[] {
  return routes.map((route, index) => ({
    index,
    enabled: true,
    lastUsed: 0,
    rateLimitResetTimes: {},
    touchedForQuota: {},
    route,
    ...(route.email !== undefined ? { email: route.email } : {}),
  }))
}

/**
 * A vault row's identity for `AccountSelector.replaceAccounts`: its route,
 * credential and asserted account. A route that now names another
 * credential or account is a different row.
 */
export function vaultAccountRowKey(row: VaultAccountRow): string {
  return JSON.stringify([
    row.route.routeId,
    row.route.credentialId,
    row.route.accountIdentity,
  ])
}

/**
 * Keeps a vault row's in-memory selection state across a roster re-read and
 * takes only the route's display fields from the fresh roster; the vault
 * keeps no cooldown, rate-limit or usage state for the plugin to reload.
 */
export function refreshVaultAccountRow(
  prior: VaultAccountRow,
  fresh: VaultAccountRow,
): void {
  prior.route = fresh.route
  if (fresh.email === undefined) delete prior.email
  else prior.email = fresh.email
}

/**
 * One physical send's grant from one vault receipt. The access token is a
 * non-enumerable property, as the source served it, so spreading or
 * serializing a grant never copies it.
 */
class VaultSendGrant implements RequestSendAdmission {
  declare readonly accessToken: string
  readonly credentialId: string
  readonly accountIdentity: string
  readonly recordVersion: number
  readonly projectId: string
  readonly report401: (status: number) => Promise<unknown>

  constructor(
    admission: Awaited<ReturnType<VaultRequestSource['admit']>>,
    report: (status: number) => Promise<unknown>,
  ) {
    Object.defineProperty(this, 'accessToken', {
      value: admission.accessToken,
      enumerable: false,
    })
    this.credentialId = admission.credentialId
    this.accountIdentity = admission.accountIdentity
    this.recordVersion = admission.recordVersion
    this.projectId = admission.projectId
    this.report401 = report
  }
}

/** The shared engine's `vault` credential domain over a vault account source. */
export function createVaultRequestCredentials(
  source: Pick<VaultRequestSource, 'admit' | 'reportServedStatus'>,
): VaultRequestCredentials<VaultAccountRow> {
  return {
    domain: 'vault',
    async admit({ account, signal }) {
      const admission = await source.admit(account.route, signal)
      return new VaultSendGrant(admission, (status) =>
        source.reportServedStatus(admission, status),
      )
    },
  }
}
