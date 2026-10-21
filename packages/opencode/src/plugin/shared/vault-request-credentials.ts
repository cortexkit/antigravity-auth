/**
 * Vault-held accounts for the shared request engine, used by OpenCode 1 and
 * OpenCode 2 alike: selection rows built from the vault's selectable routes,
 * the engine's `vault` credential domain over a vault account source, and
 * the rows' durable selection state in the vault's credential-free
 * provider-state file.
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

import {
  AccountSelector,
  type AntigravityQuotaCheckReport,
  type AntigravityVaultAccountSource,
  type EmptyVaultRosterCause,
  type QuotaState,
  type QuotaSummary,
  type SelectableAccount,
  type SelectionSink,
  type VaultAccountState,
  type VaultProviderMetadata,
  type VaultProviderStateCommitResult,
  type VaultProviderStateFile,
  type VaultRouteRef,
  type VaultStateAttribution,
} from '@cortexkit/antigravity-auth-core'

import type { VaultQuotaReason } from '../vault-quota-outcome'
import type {
  RequestSendAdmission,
  VaultRequestCredentials,
} from './request-services.ts'

/**
 * The vault account source operations a vault request path uses. A source
 * without `emptyRosterCause` never names why the vault serves no account.
 */
export type VaultRequestSource = Pick<
  AntigravityVaultAccountSource,
  'refresh' | 'routes' | 'admit' | 'reportServedStatus'
> &
  Partial<
    Pick<AntigravityVaultAccountSource, 'emptyRosterCause' | 'retryAfter401'>
  >

/** The vault account source operations durable selection state uses. */
export type VaultStateSource = Pick<
  AntigravityVaultAccountSource,
  'attribution' | 'commitState'
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
 * takes only the route's display fields from the fresh roster. A kept row's
 * in-memory state is the newest there is; stored state (see
 * `createVaultSelectionState`) is restored only onto rows that are new.
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
  readonly fromKeptReceipt?: true
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
    this.fromKeptReceipt = admission.fromKeptReceipt
    this.report401 = report
  }
}

/**
 * The shared engine's `vault` credential domain over a vault account source.
 * `onAdmitted` receives each receipt's non-secret attribution, taken by the
 * same source, with the row it was taken for (see
 * `createVaultSelectionState`).
 */
export function createVaultRequestCredentials(
  source: Pick<
    VaultRequestSource,
    'admit' | 'reportServedStatus' | 'retryAfter401'
  >,
  onAdmitted?: {
    readonly source: Pick<VaultStateSource, 'attribution'>
    admitted(row: VaultAccountRow, attribution: VaultStateAttribution): void
  },
): VaultRequestCredentials<VaultAccountRow> {
  const issued = new WeakMap<
    RequestSendAdmission,
    Awaited<ReturnType<VaultRequestSource['admit']>>
  >()
  return {
    domain: 'vault',
    ...(source.retryAfter401 && {
      retryAfter401(
        served: RequestSendAdmission,
        current: RequestSendAdmission | undefined,
        site: string,
      ) {
        const original = issued.get(served)
        if (!original)
          throw new Error('Retry requires an original vault admission')
        return source.retryAfter401!(
          original,
          current && issued.get(current),
          site,
        )
      },
    }),
    async admit({ account, signal }) {
      const admission = await source.admit(account.route, signal)
      if (onAdmitted)
        onAdmitted.admitted(account, onAdmitted.source.attribution(admission))
      const grant = new VaultSendGrant(admission, (status) =>
        source.reportServedStatus(admission, status),
      )
      issued.set(grant, admission)
      return grant
    },
  }
}

// ---------------------------------------------------------------------------
// Durable selection state
// ---------------------------------------------------------------------------

/**
 * The selection fields a vault row keeps across restarts. Everything else a
 * row holds is either the vault's (the route, enabled) or in memory only
 * (per-quota-key touches, failure counters).
 */
type DurableSelection = Pick<
  VaultProviderMetadata,
  | 'lastUsed'
  | 'lastSwitchReason'
  | 'rateLimitResetTimes'
  | 'coolingDownUntil'
  | 'cooldownReason'
  | 'fingerprint'
  | 'fingerprintHistory'
  | 'verificationRequired'
  | 'verificationRequiredAt'
  | 'verificationRequiredReason'
  | 'verificationUrl'
  | 'accountIneligible'
  | 'accountIneligibleAt'
  | 'accountIneligibleReason'
  | 'eligibilityStateUpdatedAt'
  | 'dailyRequestCounts'
>

function present<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value
}

function storedResets(
  resets: VaultAccountRow['rateLimitResetTimes'],
): Record<string, number> {
  const stored: Record<string, number> = {}
  for (const [key, at] of Object.entries(resets))
    if (typeof at === 'number') stored[key] = at
  return stored
}

/** The row's quota groups from a stored quota reading. */
export function cachedQuotaOf(
  quota: QuotaState,
): VaultAccountRow['cachedQuota'] {
  const groups = quota.cachedQuota
  if (groups == null) return undefined
  const out: NonNullable<VaultAccountRow['cachedQuota']> = {}
  for (const name of ['gemini', 'non-gemini'] as const) {
    const group = groups[name]
    if (group === undefined) continue
    out[name] = {
      modelCount: group.modelCount,
      ...(group.remainingFraction != null
        ? { remainingFraction: group.remainingFraction }
        : {}),
      ...(group.resetTime != null ? { resetTime: group.resetTime } : {}),
      ...(group.windows != null
        ? {
            windows: group.windows.map((window) => ({
              window: window.window,
              remainingFraction: window.remainingFraction,
              resetTime: window.resetTime,
            })),
          }
        : {}),
    }
  }
  return out
}

/** The row's durable selection fields as provider metadata. */
function durableSelectionOf(row: VaultAccountRow): DurableSelection {
  return {
    lastUsed: row.lastUsed,
    ...(row.lastSwitchReason !== undefined
      ? { lastSwitchReason: row.lastSwitchReason }
      : {}),
    rateLimitResetTimes: storedResets(row.rateLimitResetTimes),
    ...(row.coolingDownUntil !== undefined
      ? { coolingDownUntil: row.coolingDownUntil }
      : {}),
    ...(row.cooldownReason !== undefined
      ? { cooldownReason: row.cooldownReason }
      : {}),
    ...(row.fingerprint !== undefined
      ? { fingerprint: structuredClone(row.fingerprint) }
      : {}),
    ...(row.fingerprintHistory !== undefined
      ? { fingerprintHistory: structuredClone(row.fingerprintHistory) }
      : {}),
    ...(row.verificationRequired !== undefined
      ? { verificationRequired: row.verificationRequired }
      : {}),
    ...(row.verificationRequiredAt !== undefined
      ? { verificationRequiredAt: row.verificationRequiredAt }
      : {}),
    ...(row.verificationRequiredReason !== undefined
      ? { verificationRequiredReason: row.verificationRequiredReason }
      : {}),
    ...(row.verificationUrl !== undefined
      ? { verificationUrl: row.verificationUrl }
      : {}),
    ...(row.accountIneligible !== undefined
      ? { accountIneligible: row.accountIneligible }
      : {}),
    ...(row.accountIneligibleAt !== undefined
      ? { accountIneligibleAt: row.accountIneligibleAt }
      : {}),
    ...(row.accountIneligibleReason !== undefined
      ? { accountIneligibleReason: row.accountIneligibleReason }
      : {}),
    ...(row.eligibilityStateUpdatedAt !== undefined
      ? { eligibilityStateUpdatedAt: row.eligibilityStateUpdatedAt }
      : {}),
    ...(row.dailyRequestCounts !== undefined
      ? { dailyRequestCounts: { ...row.dailyRequestCounts } }
      : {}),
  }
}

/** Puts stored selection fields onto a fresh row. */
function applyDurableSelection(
  row: VaultAccountRow,
  metadata: VaultProviderMetadata,
): void {
  row.lastUsed = metadata.lastUsed
  const reason = present(metadata.lastSwitchReason)
  if (reason !== undefined) row.lastSwitchReason = reason
  const resets = present(metadata.rateLimitResetTimes)
  if (resets !== undefined) {
    const copy: VaultAccountRow['rateLimitResetTimes'] = {}
    for (const [key, at] of Object.entries(resets))
      if (typeof at === 'number') copy[key] = at
    row.rateLimitResetTimes = copy
  }
  const until = present(metadata.coolingDownUntil)
  const cooldownReason = present(metadata.cooldownReason)
  if (until !== undefined && cooldownReason !== undefined) {
    row.coolingDownUntil = until
    row.cooldownReason = cooldownReason
  }
  const fingerprint = present(metadata.fingerprint)
  if (fingerprint !== undefined) row.fingerprint = structuredClone(fingerprint)
  const history = present(metadata.fingerprintHistory)
  if (history !== undefined) row.fingerprintHistory = structuredClone(history)
  const verification = present(metadata.verificationRequired)
  if (verification !== undefined) row.verificationRequired = verification
  const verificationAt = present(metadata.verificationRequiredAt)
  if (verificationAt !== undefined) row.verificationRequiredAt = verificationAt
  const verificationReason = present(metadata.verificationRequiredReason)
  if (verificationReason !== undefined)
    row.verificationRequiredReason = verificationReason
  const verificationUrl = present(metadata.verificationUrl)
  if (verificationUrl !== undefined) row.verificationUrl = verificationUrl
  const ineligible = present(metadata.accountIneligible)
  if (ineligible !== undefined) row.accountIneligible = ineligible
  const ineligibleAt = present(metadata.accountIneligibleAt)
  if (ineligibleAt !== undefined) row.accountIneligibleAt = ineligibleAt
  const ineligibleReason = present(metadata.accountIneligibleReason)
  if (ineligibleReason !== undefined)
    row.accountIneligibleReason = ineligibleReason
  const eligibilityAt = present(metadata.eligibilityStateUpdatedAt)
  if (eligibilityAt !== undefined) row.eligibilityStateUpdatedAt = eligibilityAt
  const counts = present(metadata.dailyRequestCounts)
  if (counts !== undefined) row.dailyRequestCounts = { ...counts }
}

/** Whether stored state was written for exactly this row's route and credential. */
function stateBelongsTo(
  state: VaultAccountState,
  row: VaultAccountRow,
): boolean {
  return (
    state.observed.routeId === row.route.routeId &&
    state.observed.credentialId === row.route.credentialId
  )
}

export interface VaultSelectionStateOptions {
  /** The vault source's attribution-fenced state commit. */
  readonly source: Pick<VaultStateSource, 'commitState'>
  /** Reads the provider-state file the source commits to. */
  readonly readState: () => Promise<VaultProviderStateFile>
  readonly now?: () => number
  /** Receives a refused or failed write; the observation is then dropped. */
  readonly onError?: (error: unknown) => void
}

export interface VaultSelectionState {
  /** The selector's sink: every reported transition marks its row changed. */
  readonly sink: SelectionSink<VaultAccountRow>
  /** Records the receipt attribution that last served `row`. */
  admitted(row: VaultAccountRow, attribution: VaultStateAttribution): void
  /**
   * Restores stored selection state onto fresh rows. A row takes state only
   * when that state was last written for the same asserted account, route
   * and credential; state of another account, route or credential is left
   * alone.
   */
  hydrate(rows: readonly VaultAccountRow[]): Promise<void>
  /**
   * Writes each changed row's selection state, attributed to the receipt
   * that last served it. A row not yet served in this process has no
   * attribution and stays changed until it is. The source refuses a write
   * whose credential, account or record version the vault no longer serves,
   * and the change is dropped rather than re-attributed.
   */
  flush(): Promise<void>
  /** Records a quota reading taken with the receipt `attribution` names. */
  recordQuota(
    attribution: VaultStateAttribution,
    quota: QuotaState,
    signal?: AbortSignal,
  ): Promise<VaultProviderStateCommitResult>
}

/**
 * Durable selection state for vault rows, kept in the vault source's
 * credential-free provider-state file by asserted account. The selector
 * stays the only selection policy: this only saves and restores the fields
 * it already maintains.
 */
export function createVaultSelectionState(
  options: VaultSelectionStateOptions,
): VaultSelectionState {
  const now = options.now ?? (() => Date.now())
  const attributions = new WeakMap<VaultAccountRow, VaultStateAttribution>()
  const changed = new Set<VaultAccountRow>()
  let writing: Promise<void> = Promise.resolve()
  const mark = (row: VaultAccountRow) => {
    changed.add(row)
  }
  const report = (error: unknown) => {
    try {
      options.onError?.(error)
    } catch {
      // A diagnostic callback cannot change what was written.
    }
  }

  const writeRow = async (row: VaultAccountRow): Promise<void> => {
    const attribution = attributions.get(row)
    if (attribution === undefined) return
    changed.delete(row)
    const selection = durableSelectionOf(row)
    try {
      await options.source.commitState(attribution, (current) => ({
        metadata: {
          ...(current?.metadata ?? { addedAt: now() }),
          ...selection,
        },
        ...(current?.quota !== undefined ? { quota: current.quota } : {}),
        ...(current?.extensions !== undefined
          ? { extensions: current.extensions }
          : {}),
      }))
    } catch (error) {
      report(error)
    }
  }

  const flush = (): Promise<void> => {
    writing = writing.then(async () => {
      for (const row of [...changed]) await writeRow(row)
    })
    return writing
  }

  return {
    sink: {
      rateLimit: mark,
      cooldown: mark,
      switched: mark,
      lastUsed: mark,
      usage: mark,
      accessVerdict: mark,
      fingerprint: mark,
      requestSave: () => {
        void flush()
      },
    },
    admitted(row, attribution) {
      attributions.set(row, attribution)
    },
    async hydrate(rows) {
      const file = await options.readState()
      for (const row of rows) {
        const identity = row.route.accountIdentity
        if (!Object.hasOwn(file.accounts, identity)) continue
        const state = file.accounts[identity]
        if (state === undefined || !stateBelongsTo(state, row)) continue
        if (state.metadata !== undefined)
          applyDurableSelection(row, state.metadata)
        if (state.quota !== undefined) {
          const cached = cachedQuotaOf(state.quota)
          if (cached !== undefined) row.cachedQuota = cached
          const updatedAt = present(state.quota.cachedQuotaUpdatedAt)
          if (updatedAt !== undefined) row.cachedQuotaUpdatedAt = updatedAt
        }
      }
    },
    flush,
    recordQuota(attribution, quota, signal) {
      return options.source.commitState(
        attribution,
        (current) => ({
          ...(current?.metadata !== undefined
            ? { metadata: current.metadata }
            : {}),
          quota,
          ...(current?.extensions !== undefined
            ? { extensions: current.extensions }
            : {}),
        }),
        signal,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// The vault account pool
// ---------------------------------------------------------------------------

export interface VaultAccountPoolOptions {
  readonly source: VaultRequestSource
  /**
   * Makes the pool's selection state durable (see
   * `createVaultSelectionState`): the same source's attribution and fenced
   * commit, and a reader of the provider-state file it commits to. Without
   * it, selection state lives in memory only.
   */
  readonly durable?: {
    readonly source: VaultStateSource
    readonly readState: () => Promise<VaultProviderStateFile>
    /** Receives a refused or failed state write. */
    readonly onError?: (error: unknown) => void
  }
  readonly now?: () => number
  /**
   * The host's message for a request that finds no account, given why the
   * source's roster is empty; undefined keeps the general vault remedy.
   * Without it, requests always get the general remedy.
   */
  readonly emptyRosterRefusal?: (
    cause: EmptyVaultRosterCause,
  ) => string | undefined
}

/**
 * One host location's vault-held accounts for the shared request engine:
 * the one `AccountSelector` over the vault's routes, the engine's vault
 * credentials, and (with `readState`) the selector's durable state. Both
 * OpenCode hosts build their vault request path on this, so a location has
 * exactly one authoritative selector and one place its state is saved.
 */
export interface VaultAccountPool {
  readonly selector: AccountSelector<VaultAccountRow>
  readonly credentials: VaultRequestCredentials<VaultAccountRow>
  /** The durable selection state, when the pool has a state file. */
  readonly state: VaultSelectionState | undefined
  /**
   * Brings the rows up to date with the source's roster: the first call
   * reads the roster from the vault (a failed read is retried by the next
   * call); later calls take the source's last committed routes. New rows
   * get their stored state; kept rows keep their in-memory state.
   */
  sync(): Promise<void>
  /** Re-reads the roster from the vault now, then syncs the rows. */
  refresh(): Promise<void>
  /** Writes pending selection state. */
  flush(): Promise<void>
}

export function createVaultAccountPool(
  options: VaultAccountPoolOptions,
): VaultAccountPool {
  const { source, durable } = options
  const state = durable
    ? createVaultSelectionState({
        source: durable.source,
        readState: durable.readState,
        ...(options.now ? { now: options.now } : {}),
        ...(durable.onError ? { onError: durable.onError } : {}),
      })
    : undefined
  const selector = new AccountSelector<VaultAccountRow>({
    ...(options.now ? { now: options.now } : {}),
    ...(state ? { sink: state.sink } : {}),
  })
  const credentials = createVaultRequestCredentials(
    source,
    state && durable
      ? {
          source: durable.source,
          admitted: (row, attribution) => state.admitted(row, attribution),
        }
      : undefined,
  )
  const refusal = options.emptyRosterRefusal
  if (refusal)
    credentials.emptyRosterRefusal = () =>
      refusal(source.emptyRosterCause?.() ?? 'unknown')

  /** Fresh rows for the source's routes, with stored state on new ones. */
  const rowsFromSource = async (): Promise<VaultAccountRow[]> => {
    const rows = vaultAccountRows(source.routes())
    if (state) {
      const kept = new Set(selector.rows.map(vaultAccountRowKey))
      const added = rows.filter((row) => !kept.has(vaultAccountRowKey(row)))
      if (added.length > 0) await state.hydrate(added)
    }
    return rows
  }
  const replace = async () => {
    selector.replaceAccounts(await rowsFromSource(), {
      keyOf: vaultAccountRowKey,
      refresh: refreshVaultAccountRow,
    })
  }

  let firstRead: Promise<void> | null = null
  const readOnce = (): Promise<void> => {
    firstRead ??= (async () => {
      await source.refresh()
      selector.resetAccounts(await rowsFromSource())
    })().catch((error: unknown) => {
      firstRead = null
      throw error
    })
    return firstRead
  }

  const waitForFirstRoster = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Discovery belongs to the source and may be shared with its observer.
      // Bound the caller's wait without canceling that shared roster discovery.
      await Promise.race([
        readOnce(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'The vault roster is not available yet. Check vault access and try the request again.',
                ),
              ),
            2_000,
          )
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    selector,
    credentials,
    state,
    async sync() {
      const pending = firstRead
      await waitForFirstRoster()
      // The first read just installed the rows; later calls re-sync.
      if (pending !== null) await replace()
    },
    async refresh() {
      await waitForFirstRoster()
      await source.refresh()
      await replace()
    },
    flush: async () => {
      await state?.flush()
    },
  }
}

// ---------------------------------------------------------------------------
// Quota checks
// ---------------------------------------------------------------------------

/**
 * A quota reading for one vault account, as the vault quota check returns
 * it: the summary and the credential-free admission attribution that binds
 * its write. Insula readings also carry their original observation time.
 */
export interface VaultQuotaAnswer {
  readonly quota: QuotaSummary
  readonly quotaAttribution?: VaultStateAttribution
  /** Producer observation time; absent for a direct poll dated on completion. */
  readonly observedAt?: number
}

/** The stored quota reading for a summary taken at `at`. */
export function vaultQuotaState(quota: QuotaSummary, at: number): QuotaState {
  const cachedQuota: NonNullable<QuotaState['cachedQuota']> = {}
  for (const [name, group] of Object.entries(quota.groups)) {
    if (group === undefined) continue
    cachedQuota[name] = {
      modelCount: group.modelCount,
      ...(group.remainingFraction !== undefined
        ? { remainingFraction: group.remainingFraction }
        : {}),
      ...(group.resetTime !== undefined ? { resetTime: group.resetTime } : {}),
      ...(group.windows !== undefined
        ? { windows: group.windows.map((window) => ({ ...window })) }
        : {}),
    }
  }
  return { schemaVersion: 1, cachedQuota, cachedQuotaUpdatedAt: at }
}

/**
 * Checks quota for every row of a durable vault pool and records each
 * reading through the source's provider-state commit. Admission attribution
 * binds the write; the reading keeps its observation time. A row counts as
 * checked only when its reading was written; a reading with an error, without
 * an attribution, or whose
 * write the source refuses (another credential, account or a newer record
 * version) is not checked and is not shown. A written reading is also put
 * on the row that is still at that route, credential and account. An
 * aborted `signal` stops the check; the remaining rows are not checked.
 */
export async function checkVaultQuota(input: {
  readonly pool: Pick<VaultAccountPool, 'selector' | 'state'>
  /** One vault account's quota check (the shared vault quota helper). */
  readonly fetchReading: (
    ref: VaultRouteRef,
    signal: AbortSignal,
  ) => Promise<VaultQuotaAnswer | undefined>
  readonly signal: AbortSignal
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
  readonly onOutcome?: (reason: VaultQuotaReason, error?: unknown) => void
  readonly onStage?: (stage: 'fetch' | 'commit') => void
}): Promise<AntigravityQuotaCheckReport> {
  const state = input.pool.state
  const rows = [...input.pool.selector.rows]
  const now = input.now ?? (() => Date.now())
  let checked = 0
  if (state === undefined) input.onOutcome?.('state-invalid')
  for (const row of rows) {
    if (input.signal.aborted || state === undefined) break
    try {
      input.onStage?.('fetch')
      const answer = await input.fetchReading(row.route, input.signal)
      input.signal.throwIfAborted()
      if (answer === undefined) {
        input.onOutcome?.('fetch-failed')
        continue
      }
      const attribution = answer.quotaAttribution
      if (answer.quota.error !== undefined) {
        input.onOutcome?.('fetch-failed')
        continue
      }
      if (attribution === undefined) {
        input.onOutcome?.('unattributed')
        continue
      }
      const reading = vaultQuotaState(answer.quota, answer.observedAt ?? now())
      input.onStage?.('commit')
      input.signal.throwIfAborted()
      const result = await state.recordQuota(attribution, reading, input.signal)
      if (result.status !== 'written') {
        input.onOutcome?.(
          result.status === 'uncertain'
            ? 'write-uncertain'
            : 'commit-unchanged',
          result.status === 'uncertain' ? result.error : undefined,
        )
        continue
      }
      checked += 1
      input.onOutcome?.('recorded')
      const live = input.pool.selector.rows.find(
        (candidate) =>
          candidate.route.routeId === attribution.routeId &&
          candidate.route.credentialId === attribution.credentialId &&
          candidate.route.accountIdentity === attribution.accountIdentity,
      )
      if (live !== undefined) {
        const cached = cachedQuotaOf(reading)
        if (cached !== undefined) live.cachedQuota = cached
        live.cachedQuotaUpdatedAt = reading.cachedQuotaUpdatedAt ?? undefined
      }
    } catch (error) {
      try {
        input.onError?.(error)
      } catch {
        // A diagnostic callback cannot change the report.
      }
    }
  }
  return { checked, notChecked: rows.length - checked }
}
