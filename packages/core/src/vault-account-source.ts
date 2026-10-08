/**
 * Antigravity accounts served from a Claustrum vault ("custody mode").
 *
 * Terms used below:
 * - roster: the non-secret list of vault accounts this host may route to
 *   (route id, credential id, account identity, enabled/declined state).
 * - receipt: what the vault serves for one physical send: a fresh bearer, the
 *   Antigravity project, the account identity the vault asserted and the
 *   record version of the credential.
 *
 * The host passes in the library's public `./claustrum` module; every library
 * type here is taken from that module's own declarations.
 *
 * Rules:
 * - Each physical upstream send (each endpoint fallback, each 401 retry,
 *   quota and profile reads) gets a fresh receipt, and takes its bearer and
 *   project from that receipt only. Nothing is cached or refreshed locally.
 * - Google bearers are opaque: a receipt is accepted only when the vault
 *   asserted the credential and the account the selected route names. No
 *   token is parsed for an identity, and API-key credentials are refused.
 * - Nothing is served unless custody is active and the host's auth slot holds
 *   no real login. The host reads its own slot; this module never touches it.
 */

import type { CommonAuthClaustrumModule } from './common-auth-runtime.ts'
import {
  ANTIGRAVITY_VAULT_FAMILY,
  ANTIGRAVITY_VAULT_REQUIRE_ASSERTION,
  type AntigravityVaultHost,
} from './vault-family.ts'
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

type ClaustrumConsumerClass = CommonAuthClaustrumModule['ClaustrumConsumer']
type ClaustrumConsumerInstance = InstanceType<ClaustrumConsumerClass>

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
>

/**
 * The part of `./claustrum` this source uses. The module namespace itself
 * assigns to it; tests can pass a smaller stand-in.
 */
export interface VaultClaustrumPort
  extends Pick<
    CommonAuthClaustrumModule,
    | 'assertHostSlotMatchesMode'
    | 'decideScopedRetryAfter401'
    | 'isDeclined'
    | 'mutateVaultRoster'
  > {
  ClaustrumConsumer: new (
    options: VaultConsumerOptions,
  ) => VaultClaustrumConsumer
}

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

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

/** A refusal made here before anything is sent; library refusals keep their own errors. */
export class AntigravityVaultSourceError extends Error {
  readonly kind: AntigravityVaultSourceFailureKind

  constructor(kind: AntigravityVaultSourceFailureKind, message: string) {
    super(message)
    this.name = 'AntigravityVaultSourceError'
    this.kind = kind
  }
}

/**
 * A selectable vault account, captured from the roster before any await.
 * Admission refuses it once its route names another credential or account.
 */
export interface VaultRouteRef {
  readonly routeId: string
  readonly credentialId: string
  readonly accountIdentity: string
  /** Display label; may hold personal data. */
  readonly label: string
  readonly email?: string
}

/**
 * One physical send's inputs, all from one receipt. Use it for exactly one
 * send. `accessToken` is non-enumerable, so spreads and JSON never copy it.
 */
export interface VaultSendAdmission {
  readonly routeId: string
  readonly credentialId: string
  readonly accountIdentity: string
  readonly recordVersion: number
  /** Project for the request envelope. */
  readonly projectId: string
  readonly accessToken: string
  readonly expiresAtMs: number | null
}

export interface VaultSendOptions {
  /** Request kind (`model`, `quota`, `profile`), logged with a 401 retry. */
  site: string
  signal?: AbortSignal
  reporterSource?: VaultReporterSource
}

export interface AntigravityVaultSourceOptions {
  claustrum: VaultClaustrumPort
  host: AntigravityVaultHost
  /** Provider id of the host auth slot: `google` (OpenCode), `google-antigravity` (Pi). */
  hostProvider: string
  rosterPath: string
  /** This host's enrollment token file. */
  tokenPath: string
  connect: () => Promise<VaultScopedClient>
  isCustodyActive: () => boolean | Promise<boolean>
  /** The host auth slot's current value, read through the host's own API. */
  readHostSlot: () => unknown | Promise<unknown>
  /** Reporter source for a 401 seen by `send`. */
  reporterSource: VaultReporterSource
  /** Provider-state file; without it `commitState` is refused. */
  state?: { path: string; fs: AntigravityVaultStateFs }
  reservedRouteIds?: () => Iterable<string>
  routePrefix?: string
  onRoster?: (roster: VaultRoster) => void
  onError?: (error: unknown) => void
  pollIntervalMs?: number
  now?: () => number
  logger?: VaultLogger
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
   * the receipt that dispatch used. Call again for an endpoint fallback.
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
   * Report the original response status of a dispatch made with `admission`.
   * Only 401 is reported, once per admission; other statuses return false.
   */
  reportServedStatus(
    admission: VaultSendAdmission,
    status: number,
    reporterSource?: VaultReporterSource,
  ): Promise<boolean>
  /** Token- and project-free attribution of an admission, for `commitState`. */
  attribution(admission: VaultSendAdmission): VaultStateAttribution
  /** Update the account's provider state; see `commitVaultProviderState`. */
  commitState(
    attribution: VaultStateAttribution,
    update: AntigravityVaultStateUpdate,
  ): Promise<VaultProviderStateCommitResult>
  decline(ref: VaultRouteRef): Promise<void>
  accept(ref: VaultRouteRef): Promise<void>
  /** Close the vault connection; later calls are refused. */
  close(): void
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

  /** Custody must be on and the host slot must not hold a real login. */
  const assertServing = async (signal?: AbortSignal) => {
    assertOpen(signal)
    if (!(await options.isCustodyActive()))
      throw new AntigravityVaultSourceError(
        'not-active',
        'Antigravity vault custody is not active for this host',
      )
    claustrum.assertHostSlotMatchesMode({
      mode: 'custody',
      auth: await options.readHostSlot(),
      provider: options.hostProvider,
    })
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
    const receipt = await consumer.authorize(ref.routeId, signal)
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
    return true
  }

  /**
   * Fresh proof that the attributed credential, account and record version
   * are still what the vault serves. The proving receipt's token and project
   * are dropped here; they never reach a send.
   */
  const verifyAttribution = async (attribution: VaultStateAttribution) => {
    await assertServing()
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
      await consumer.authorize(attribution.routeId),
    )
    if (proof.recordVersion !== attribution.recordVersion)
      throw new AntigravityVaultSourceError(
        'state-unavailable',
        'The vault now serves another record version for this account',
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
    send: async (ref, dispatch, sendOptions) => {
      const signal = sendOptions.signal
      let admission = await admit(ref, signal)
      let response = await dispatch(admission, signal)
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
          await response.body?.cancel().catch(() => {})
          admission = current
          response = await dispatch(current, signal)
        }
      }
      if (response.status === 401)
        await reportServedStatus(
          admission,
          401,
          sendOptions.reporterSource,
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
    commitState: async (attribution, update) => {
      assertOpen()
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
        verify: verifyAttribution,
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
    close: () => {
      if (closed) return
      closed = true
      consumer.close()
    },
  }
}
