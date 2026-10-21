/**
 * Antigravity accounts served from a Claustrum vault ("custody mode").
 *
 * Terms used below:
 * - roster: the non-secret list of vault accounts this host may route to
 *   (route id, credential id, account identity, enabled/declined state).
 * - receipt: what Claustrum serves for one send attempt: a fresh bearer, the
 *   Antigravity project for the model request, the account identity the vault
 *   asserted, and the record version it served for the credential.
 * - host auth slot: the host's own Google credential record. Pi temporarily
 *   replaces it with a non-secret marker and retains a backup; OpenCode may
 *   keep its existing login. Neither is read by this vault account source.
 *
 * The host passes in the library's public `./claustrum` module; every library
 * type here is taken from that module's own declarations.
 *
 * Rules:
 * - Each send attempt to Google (each endpoint fallback, each 401 retry,
 *   quota and profile reads) gets a new admission with a fresh receipt, and
 *   takes its bearer and project from that receipt only. Nothing is cached or
 *   refreshed locally.
 * - Google bearers are opaque: a receipt is accepted only when the vault
 *   asserted the credential and the account the selected route names. No
 *   token is parsed for an identity, and API-key credentials are refused.
 * - Nothing is served unless custody is active. The host's local credentials
 *   stay dormant: this source never reads or refreshes them.
 */

import type { CommonAuthClaustrumModule } from './common-auth-runtime.ts'
import type { QuotaSummary } from './quota-types.ts'
import {
  ANTIGRAVITY_VAULT_FAMILY,
  ANTIGRAVITY_VAULT_REQUIRE_ASSERTION,
  type AntigravityVaultHost,
} from './vault-family.ts'
import {
  type EmptyVaultRosterCause,
  emptyVaultRosterCause,
} from './vault-grant-reach.ts'
import {
  type AntigravityVaultStateFs,
  type AntigravityVaultStateUpdate,
  commitVaultProviderState,
  type VaultProviderStateCommitResult,
  type VaultStateAttribution,
} from './vault-provider-state.ts'

// ---------------------------------------------------------------------------
// Types taken from the public `./claustrum` module
// ---------------------------------------------------------------------------

declare const Consumer: CommonAuthClaustrumModule['ClaustrumConsumer']
type ClaustrumConsumerClass = typeof Consumer<VaultBackgroundQuotaReading>
type ClaustrumConsumerInstance = InstanceType<ClaustrumConsumerClass>

/** Quota with its producer's observation time and admission attribution for the write. */
export interface VaultBackgroundQuotaReading {
  quota: QuotaSummary
  observedAt?: number
  accountIdentity?: string
  quotaAttribution?: VaultStateAttribution
}

export type VaultConsumerOptions =
  ConstructorParameters<ClaustrumConsumerClass>[0]
export type VaultScopedClient = Awaited<
  ReturnType<VaultConsumerOptions['connect']>
>
export type VaultScopedReceipt = Awaited<
  ReturnType<ClaustrumConsumerInstance['authorize']>
>
export type VaultRoster = NonNullable<
  ReturnType<ClaustrumConsumerInstance['snapshot']>
>
export type VaultRosterRow = VaultRoster['rows'][number]
export type VaultReporterSource = Parameters<
  ClaustrumConsumerInstance['reportFailure']
>[2]
export type VaultLogger = NonNullable<VaultConsumerOptions['logger']>
/**
 * What the vault's latest account listing reported about this host's grants:
 * how many it holds and what each one selects. Only a known report has this
 * shape; an unknown one is `undefined` at each use.
 */
export type VaultGrantReach = NonNullable<
  ReturnType<ClaustrumConsumerInstance['grantReach']>
>

/** The consumer methods this source calls. */
export type VaultClaustrumConsumer = Pick<
  ClaustrumConsumerInstance,
  | 'snapshot'
  | 'refresh'
  | 'start'
  | 'authorize'
  | 'reportFailure'
  | 'decline'
  | 'accept'
  | 'close'
  | 'grantReach'
> &
  Partial<
    Pick<
      ClaustrumConsumerInstance,
      'pollInsulaQuotaForRoute' | 'lookupInsulaQuotaForRoute'
    >
  >

/**
 * The part of `./claustrum` this source uses. The module namespace itself
 * assigns to it; tests can pass a smaller stand-in.
 */
export interface VaultClaustrumPort
  extends Pick<
    CommonAuthClaustrumModule,
    'decideScopedRetryAfter401' | 'isDeclined' | 'mutateVaultRoster'
  > {
  ClaustrumConsumer: new (
    options: VaultConsumerOptions,
  ) => VaultClaustrumConsumer
}

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

/** Stop waiting for a receipt on cancellation; a late receipt can never dispatch or verify a write. */
function untilAborted<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export type AntigravityVaultSourceFailureKind =
  | 'closed'
  | 'not-active'
  | 'route-unavailable'
  | 'api-key-refused'
  | 'identity-unasserted'
  | 'identity-contradicted'
  | 'project-missing'
  | 'invalid-receipt'
  | 'not-issued'
  | 'state-unavailable'

/**
 * A refusal by this source before any request reaches Google. Refusals made
 * by the Claustrum library itself arrive as the library's own errors.
 */
export class AntigravityVaultSourceError extends Error {
  readonly kind: AntigravityVaultSourceFailureKind

  constructor(
    kind: AntigravityVaultSourceFailureKind,
    message: string,
    readonly reason?: 'version-changed',
  ) {
    super(message)
    this.name = 'AntigravityVaultSourceError'
    this.kind = kind
  }
}

/**
 * A selectable vault account: the route plus the credential id and account
 * identity the roster named when it was captured, before any await. `admit`
 * refuses the ref once the current roster routes it to another credential or
 * account.
 */
export interface VaultRouteRef {
  readonly routeId: string
  readonly credentialId: string
  readonly accountIdentity: string
  /** The roster row's display label; may hold personal data. */
  readonly label: string
  readonly email?: string
}

/**
 * The inputs of one send attempt, all taken from one Claustrum receipt. Use it
 * for exactly one attempt. `accessToken` is non-enumerable, so spreads and JSON
 * never copy it.
 */
export interface VaultSendAdmission {
  /** True only when the consumer served its in-memory receipt during an outage. */
  readonly fromKeptReceipt?: true
  readonly routeId: string
  readonly credentialId: string
  readonly accountIdentity: string
  /** The record version Claustrum served; a 401 is reported against it. */
  readonly recordVersion: number
  /** Antigravity project to put in the model request body. */
  readonly projectId: string
  readonly accessToken: string
  readonly expiresAtMs: number | null
}

export interface VaultSendOptions {
  /**
   * Request kind (`model`, `quota`, `profile`). The library logs it with its
   * decision whether to retry a 401.
   */
  site: string
  signal?: AbortSignal
  reporterSource?: VaultReporterSource
}

export interface AntigravityVaultSourceOptions {
  claustrum: VaultClaustrumPort
  host: AntigravityVaultHost
  rosterPath: string
  /** Enrollment token file that setup wrote for this host (`host`). */
  tokenPath: string
  connect: () => Promise<VaultScopedClient>
  isCustodyActive: () => boolean | Promise<boolean>
  /**
   * How a 401 reached this plugin, passed to Claustrum with the 401 report
   * that `send` makes.
   */
  reporterSource: VaultReporterSource
  /**
   * Credential-free per-account state file (see `vault-provider-state.ts`) and
   * the `./fs` functions that lock and write it. Without it `commitState` has
   * nowhere to write and is refused.
   */
  state?: { path: string; fs: AntigravityVaultStateFs }
  reservedRouteIds?: () => Iterable<string>
  routePrefix?: string
  onRoster?: (roster: VaultRoster) => void
  onError?: (error: unknown) => void
  pollIntervalMs?: number
  now?: () => number
  logger?: VaultLogger
  insula?: VaultConsumerOptions['insula']
}

export interface AntigravityVaultAccountSource {
  readonly host: AntigravityVaultHost
  start(): void
  refresh(): Promise<VaultRoster | undefined>
  /** Selectable accounts from the last committed roster. */
  routes(): VaultRouteRef[]
  /** A fresh receipt for one physical send on `ref`. */
  admit(ref: VaultRouteRef, signal?: AbortSignal): Promise<VaultSendAdmission>
  /**
   * Admit and dispatch. When the original response status of the dispatch is
   * 401, retry once with a fresh receipt only if the vault now serves a newer
   * version of the same credential and account; a final 401 is reported with
   * the receipt that dispatch used. When the caller tries another Antigravity
   * endpoint after a failure, that attempt is a new `send` with a new
   * admission.
   */
  send(
    ref: VaultRouteRef,
    dispatch: (
      admission: VaultSendAdmission,
      signal?: AbortSignal,
    ) => Promise<Response>,
    options: VaultSendOptions,
  ): Promise<Response>
  /**
   * Report to Claustrum that the request sent with `admission` got a 401, so
   * the vault can mark that served record version bad. Pass the original
   * response status; only 401 is reported, once per admission, against that
   * admission's own receipt and record version. A kept receipt is discarded
   * without contacting the vault and returns false, as do other statuses.
   */
  reportServedStatus(
    admission: VaultSendAdmission,
    status: number,
    reporterSource?: VaultReporterSource,
  ): Promise<boolean>
  /** Apply the consumer's retry policy to the original receipts behind these admissions. */
  retryAfter401?(
    served: VaultSendAdmission,
    current: VaultSendAdmission | undefined,
    site: string,
  ): boolean
  /**
   * The non-secret facts that tie an observation (usage, quota) to the send
   * that produced it: route, credential id, asserted account and served record
   * version. Carries no token or project; pass it to `commitState`.
   */
  attribution(admission: VaultSendAdmission): VaultStateAttribution
  /** Cache first; only a usable account reading obtains an admission to bind its write. */
  pollInsulaQuotaForRoute?(
    ref: VaultRouteRef,
    fallback: () => Promise<VaultBackgroundQuotaReading | undefined>,
    signal?: AbortSignal,
    onSkip?: (reason: 'cold' | 'upstream-failed') => void,
  ): Promise<VaultBackgroundQuotaReading | undefined>
  /**
   * Update the account's provider state; see `commitVaultProviderState`. The
   * write is refused unless the roster and a fresh receipt still show the
   * attributed credential, account and record version. If the vault has since
   * served a newer record version, even for the same account, the observation
   * is dropped rather than attributed to the newer version.
   */
  commitState(
    attribution: VaultStateAttribution,
    update: AntigravityVaultStateUpdate,
    signal?: AbortSignal,
  ): Promise<VaultProviderStateCommitResult>
  decline(ref: VaultRouteRef): Promise<void>
  accept(ref: VaultRouteRef): Promise<void>
  /**
   * The grants named by the latest discovery, which explain an empty roster.
   * Undefined means unknown, never zero grants: nothing was discovered yet, the
   * vault is too old to report grants, or the source is closed.
   */
  grantReach(): VaultGrantReach | undefined
  /**
   * Why the last committed roster lists no accounts at all, read without any
   * I/O. `unknown` unless that roster holds no rows and the vault reported this
   * host's grants with it. A roster whose rows are all declined, disabled or
   * stale is not empty, so it is `unknown` too.
   */
  emptyRosterCause(): EmptyVaultRosterCause
  /** Close the vault connection; later calls are refused. */
  close(): void
}

/**
 * Path of the Claustrum connection file to pass as the client's
 * `connectionFile`, resolved by `@cortexkit/claustrum-client`'s own
 * `resolveClaustrumConnectionPath`: `explicit` when given, else the
 * `SUBC_CONNECTION_FILE` or `CLAUSTRUM_SUBC_CONNECTION` environment variable,
 * else the client's default path. The client package is imported only when
 * this is called, so importing core never loads it, and its errors pass
 * through unchanged. Resolving the path opens no connection and reads no
 * enrollment or host credential.
 */
export async function resolveClaustrumConnectionPath(
  explicit?: string,
): Promise<string> {
  const client = await import('@cortexkit/claustrum-client')
  return client.resolveClaustrumConnectionPath(explicit)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface IssuedAdmission {
  readonly receipt: VaultScopedReceipt
  reported: boolean
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Rows whose route, credential and account are all known and serviceable. */
function routeRefs(
  roster: VaultRoster | undefined,
  isDeclined: VaultClaustrumPort['isDeclined'],
): VaultRouteRef[] {
  if (!roster) return []
  const refs: VaultRouteRef[] = []
  for (const row of roster.rows) {
    if (!isServiceableRow(row, roster, isDeclined)) continue
    refs.push(
      Object.freeze({
        routeId: row.routeId,
        credentialId: row.credentialId,
        accountIdentity: row.accountIdentity as string,
        label: row.label,
        ...(row.email !== undefined && { email: row.email }),
      }),
    )
  }
  return refs
}

function isServiceableRow(
  row: VaultRosterRow,
  roster: VaultRoster,
  isDeclined: VaultClaustrumPort['isDeclined'],
): boolean {
  return (
    row.enabled &&
    row.state === 'active' &&
    row.credentialType === 'oauth' &&
    row.stale !== true &&
    row.unclaimed !== true &&
    isNonEmpty(row.accountIdentity) &&
    !isDeclined(roster.declined, row.credentialId, row.accountIdentity)
  )
}

/**
 * Check a receipt against the selected route and turn it into an admission.
 * Throws before anything is sent when the receipt does not prove the route's
 * credential and account, or carries no project.
 */
function admissionFromReceipt(
  ref: VaultRouteRef,
  receipt: VaultScopedReceipt,
): VaultSendAdmission {
  if (receipt.credentialType !== 'oauth')
    throw new AntigravityVaultSourceError(
      'api-key-refused',
      'Antigravity vault routes serve OAuth credentials only',
    )
  if (
    receipt.accountIdentitySource !== 'asserted' ||
    receipt.assertedCredentialId === undefined ||
    receipt.assertedAccountIdentity === undefined
  )
    throw new AntigravityVaultSourceError(
      'identity-unasserted',
      'The vault did not assert the credential and account for this send',
    )
  if (
    receipt.credentialId !== ref.credentialId ||
    receipt.assertedCredentialId !== ref.credentialId ||
    receipt.assertedAccountIdentity !== ref.accountIdentity ||
    receipt.accountIdentity !== ref.accountIdentity ||
    receipt.expectedAccountIdentity !== ref.accountIdentity
  )
    throw new AntigravityVaultSourceError(
      'identity-contradicted',
      'The vault served a different credential or account than the selected route',
    )
  if (!isNonEmpty(receipt.projectId) || /\s/.test(receipt.projectId))
    throw new AntigravityVaultSourceError(
      'project-missing',
      'The vault served no Antigravity project for this send',
    )
  if (
    !isNonEmpty(receipt.accessToken) ||
    !Number.isSafeInteger(receipt.recordVersion) ||
    receipt.recordVersion < 0
  )
    throw new AntigravityVaultSourceError(
      'invalid-receipt',
      'The vault receipt carries no usable token or record version',
    )
  const admission = {
    routeId: ref.routeId,
    credentialId: receipt.credentialId,
    accountIdentity: receipt.assertedAccountIdentity,
    recordVersion: receipt.recordVersion,
    projectId: receipt.projectId,
    expiresAtMs: receipt.expiresAtMs,
    fromKeptReceipt: receipt.fromKeptReceipt,
  }
  Object.defineProperty(admission, 'accessToken', {
    value: receipt.accessToken,
    enumerable: false,
  })
  return Object.freeze(admission) as VaultSendAdmission
}

export function createAntigravityVaultAccountSource(
  options: AntigravityVaultSourceOptions,
): AntigravityVaultAccountSource {
  const { claustrum } = options
  const consumer = new claustrum.ClaustrumConsumer({
    rosterPath: options.rosterPath,
    tokenPath: options.tokenPath,
    family: { ...ANTIGRAVITY_VAULT_FAMILY },
    connect: options.connect,
    isCustodyActive: options.isCustodyActive,
    requireAssertion: ANTIGRAVITY_VAULT_REQUIRE_ASSERTION,
    ...(options.reservedRouteIds && {
      reservedRouteIds: options.reservedRouteIds,
    }),
    ...(options.routePrefix !== undefined && {
      routePrefix: options.routePrefix,
    }),
    ...(options.onRoster && { onRoster: options.onRoster }),
    ...(options.onError && { onError: options.onError }),
    ...(options.pollIntervalMs !== undefined && {
      pollIntervalMs: options.pollIntervalMs,
    }),
    ...(options.now && { now: options.now }),
    ...(options.logger && { logger: options.logger }),
    ...(options.insula && { insula: options.insula }),
  })
  const issued = new WeakMap<VaultSendAdmission, IssuedAdmission>()
  const isDeclined = claustrum.isDeclined.bind(claustrum)
  let closed = false

  const assertOpen = (signal?: AbortSignal) => {
    if (closed)
      throw new AntigravityVaultSourceError(
        'closed',
        'Antigravity vault source is closed',
      )
    signal?.throwIfAborted()
  }

  /** Require approved vault access before obtaining credentials for an operation. */
  const assertServing = async (signal?: AbortSignal) => {
    assertOpen(signal)
    if (
      !(await untilAborted(Promise.resolve(options.isCustodyActive()), signal))
    )
      throw new AntigravityVaultSourceError(
        'not-active',
        'Antigravity vault custody is not active for this host',
      )
    assertOpen(signal)
  }

  /** The ref must still name a serviceable row of the last committed roster. */
  const assertCurrentRoute = (ref: VaultRouteRef) => {
    const roster = consumer.snapshot()
    const row = roster?.rows.find((entry) => entry.routeId === ref.routeId)
    if (
      !roster ||
      !row ||
      row.credentialId !== ref.credentialId ||
      row.accountIdentity !== ref.accountIdentity ||
      !isServiceableRow(row, roster, isDeclined)
    )
      throw new AntigravityVaultSourceError(
        'route-unavailable',
        'The selected vault route is declined, removed or changed',
      )
  }

  const admit = async (
    ref: VaultRouteRef,
    signal?: AbortSignal,
  ): Promise<VaultSendAdmission> => {
    await assertServing(signal)
    assertCurrentRoute(ref)
    const receipt = await untilAborted(
      consumer.authorize(ref.routeId, signal),
      signal,
    )
    assertOpen(signal)
    const admission = admissionFromReceipt(ref, receipt)
    issued.set(admission, { receipt, reported: false })
    return admission
  }

  const issuedEntry = (admission: VaultSendAdmission): IssuedAdmission => {
    const entry = issued.get(admission)
    if (!entry)
      throw new AntigravityVaultSourceError(
        'not-issued',
        'This admission was not issued by this vault source',
      )
    return entry
  }

  const reportServedStatus = async (
    admission: VaultSendAdmission,
    status: number,
    reporterSource?: VaultReporterSource,
  ): Promise<boolean> => {
    const entry = issuedEntry(admission)
    if (status !== 401 || entry.reported) return false
    assertOpen()
    entry.reported = true
    await consumer.reportFailure(
      entry.receipt,
      401,
      reporterSource ?? options.reporterSource,
    )
    return entry.receipt.fromKeptReceipt !== true
  }

  /**
   * Fresh proof that the attributed credential, account and record version
   * are still what the vault serves. The proving receipt's token and project
   * are dropped here; they never reach a send.
   */
  const verifyAttribution = async (
    attribution: VaultStateAttribution,
    signal?: AbortSignal,
  ) => {
    await assertServing(signal)
    // Authorizing without a committed roster would make the consumer discover
    // and commit one, which takes the roster lock the caller already holds.
    if (!consumer.snapshot())
      throw new AntigravityVaultSourceError(
        'state-unavailable',
        'No committed vault roster to verify the account against',
      )
    const ref: VaultRouteRef = {
      routeId: attribution.routeId,
      credentialId: attribution.credentialId,
      accountIdentity: attribution.accountIdentity,
      label: '',
    }
    const proof = admissionFromReceipt(
      ref,
      await untilAborted(
        consumer.authorize(attribution.routeId, signal),
        signal,
      ),
    )
    assertOpen(signal)
    if (proof.recordVersion !== attribution.recordVersion)
      throw new AntigravityVaultSourceError(
        'state-unavailable',
        'The vault now serves another record version for this account',
        'version-changed',
      )
  }

  return {
    host: options.host,
    start: () => {
      assertOpen()
      consumer.start()
    },
    refresh: async () => {
      assertOpen()
      return consumer.refresh()
    },
    routes: () => (closed ? [] : routeRefs(consumer.snapshot(), isDeclined)),
    admit,
    retryAfter401: (served, current, site) =>
      claustrum.decideScopedRetryAfter401(
        site,
        issuedEntry(served).receipt,
        current && issuedEntry(current).receipt,
        options.logger,
      ),
    send: async (ref, dispatch, sendOptions) => {
      const signal = sendOptions.signal
      let admission = await admit(ref, signal)
      let response = await dispatch(admission, signal)
      if (response.status === 401 && admission.fromKeptReceipt) {
        await reportServedStatus(admission, 401, sendOptions.reporterSource)
        return response
      }
      if (response.status === 401 && !signal?.aborted) {
        let current: VaultSendAdmission | undefined
        try {
          current = await admit(ref, signal)
        } catch {
          // No retry: the original 401 response is kept and reported below
          // with the receipt of the dispatch that received it.
        }
        const servedReceipt = issuedEntry(admission).receipt
        const currentReceipt = current && issuedEntry(current).receipt
        if (
          current &&
          claustrum.decideScopedRetryAfter401(
            sendOptions.site,
            servedReceipt,
            currentReceipt,
            options.logger,
          )
        ) {
          await untilAborted(
            response.body?.cancel() ?? Promise.resolve(),
            signal,
          ).catch(() => {})
          assertOpen(signal)
          admission = current
          response = await dispatch(current, signal)
        }
      }
      if (response.status === 401)
        await untilAborted(
          reportServedStatus(admission, 401, sendOptions.reporterSource),
          signal,
        ).catch((error: unknown) => options.onError?.(error))
      return response
    },
    reportServedStatus,
    attribution: (admission) => {
      issuedEntry(admission)
      return Object.freeze({
        routeId: admission.routeId,
        credentialId: admission.credentialId,
        accountIdentity: admission.accountIdentity,
        recordVersion: admission.recordVersion,
      })
    },
    pollInsulaQuotaForRoute: async (ref, fallback, signal, onSkip) => {
      await assertServing(signal)
      assertCurrentRoute(ref)
      if (!consumer.pollInsulaQuotaForRoute) return fallback()
      let usedFallback = false
      const reading = await untilAborted(
        consumer.pollInsulaQuotaForRoute(ref.routeId, () => {
          usedFallback = true
          return fallback()
        }),
        signal,
      )
      if (reading === undefined) {
        // Polling returns no reading while insula is cold or its upstream fetch
        // failed. Look up that cache-only reason for the host's tick outcome.
        const result = consumer.lookupInsulaQuotaForRoute
          ? await untilAborted(
              consumer.lookupInsulaQuotaForRoute(ref.routeId),
              signal,
            )
          : undefined
        if (result?.miss === 'cold' || result?.miss === 'upstream-failed')
          onSkip?.(result.miss)
        return undefined
      }
      if (usedFallback) return reading
      if (reading.accountIdentity !== ref.accountIdentity)
        throw new AntigravityVaultSourceError(
          'identity-contradicted',
          'The background quota reading belongs to another vault account',
        )
      // The admission binds the write, not the observation time. Its bearer is
      // never dispatched: the reading was already obtained by insula.
      const admission = await admit(ref, signal)
      return {
        ...reading,
        quotaAttribution: {
          routeId: admission.routeId,
          credentialId: admission.credentialId,
          accountIdentity: admission.accountIdentity,
          recordVersion: admission.recordVersion,
        },
      }
    },
    commitState: async (attribution, update, signal) => {
      assertOpen(signal)
      if (!options.state)
        throw new AntigravityVaultSourceError(
          'state-unavailable',
          'No provider-state sidecar is configured for this vault source',
        )
      return commitVaultProviderState({
        claustrum,
        fs: options.state.fs,
        rosterPath: options.rosterPath,
        statePath: options.state.path,
        attribution,
        verify: (by) => verifyAttribution(by, signal),
        signal,
        update,
      })
    },
    decline: async (ref) => {
      assertOpen()
      await consumer.decline(ref.routeId)
    },
    accept: async (ref) => {
      assertOpen()
      await consumer.accept(ref.routeId)
    },
    grantReach: () => (closed ? undefined : consumer.grantReach()),
    emptyRosterCause: () =>
      closed || consumer.snapshot()?.rows.length !== 0
        ? 'unknown'
        : emptyVaultRosterCause(consumer.grantReach()),
    close: () => {
      if (closed) return
      closed = true
      consumer.close()
    },
  }
}
