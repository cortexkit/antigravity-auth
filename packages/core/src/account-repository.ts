/**
 * The Antigravity account repository: typed, attributed operations on the
 * account pool, persisted by common-auth's public lease-backed pool store
 * (its `./store` entry).
 *
 * This module owns everything Antigravity-specific about the pool: how
 * provider metadata is combined when two values meet (`ACCOUNT_STATE_POLICY`),
 * how each observation (project, fingerprint, tier, cooldown, rate limits,
 * usage, access verdicts) changes it, which credential a write is fenced on,
 * the per-account refresh lock, the topology lease that orders changes to
 * the set of rows, the management journal for multi-row destructive
 * operations, and the bookkeeping that lets `flush` and `dispose` drain and
 * report every write.
 *
 * The store and its lease helper are handed in
 * (`createAccountRepositoryFactory`) rather than imported, because the core
 * package does not ship a copy of them; the composition root passes the
 * genuine public `./store` and `./fs` modules, which it has verified.
 * `AccountStoreModule` and `AccountLockModule` declare only the public
 * capabilities this file calls, with the shapes of the public declarations;
 * as structural types they describe what is required, not which module
 * supplies it.
 *
 * Every write about an existing credential is fenced by the store, under the
 * row lock and the store locks, before anything is written: the repository
 * hands the store the caller's `RowRef` as the store's attribution argument,
 * or (for a refresh and a removal) checks the locked row the store shows its
 * `refuse`/`protect` callback. Nothing here checks a ref only before calling
 * the store.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  credentialFenceOf,
  refMismatchReason,
  rowRefKey,
  rowRefOf,
} from './account-identity.ts'
import {
  ACCOUNT_MIGRATION_MANAGEMENT_STEPS,
  ACCOUNT_STORE_GENERATION_SETTINGS_KEY,
  type AccountStoreBinding,
  decodeAccountStoreGeneration,
  readAccountStoreBinding,
} from './account-migration.ts'
import {
  AccountCodecError,
  createProviderStateCodec,
  decodeProviderMetadata,
  decodeProviderState,
  decodeQuotaState,
  decodeRoutingSettings,
  encodeProviderMetadata,
  encodeProviderState,
  encodeQuotaState,
  encodeRoutingSettings,
  QUOTA_CODEC,
} from './account-repository-codecs.ts'
import {
  ACCOUNT_STORE_PROVIDER,
  type AccessVerdict,
  type AccountCredentialStamp,
  type AccountEnableInput,
  type AccountFlushReport,
  type AccountLockSpec,
  type AccountLoginInput,
  type AccountLoginResult,
  type AccountMetadataResult,
  type AccountMetadataView,
  type AccountQuotaView,
  type AccountRefreshOptions,
  type AccountRefreshOutcome,
  type AccountReplaceInput,
  type AccountRepository,
  type AccountRepositoryFailure,
  type AccountRepositoryFailureKind,
  type AccountRepositoryOperation,
  type AccountRepositoryOptions,
  type AccountRepositoryRead,
  type AccountRow,
  type AccountStorePaths,
  type AccountTokenExchange,
  type AccountTransitionResult,
  type AccountUsageResult,
  type ConfiguredProviderStateCodec,
  type CooldownObservation,
  type CreateAccountRepository,
  type FingerprintObservation,
  type JsonObject,
  type JsonValue,
  type LastSwitchReason,
  MANAGEMENT_LOCK_NAME,
  MANAGEMENT_SETTINGS_KEY,
  type ManagementKind,
  type ManagementReceipt,
  type ManagementRecord,
  type MetadataMutator,
  type MetadataTransition,
  PROVIDER_STATE_SCHEMA_VERSION,
  type ProjectObservation,
  type ProviderMetadata,
  type ProviderStateEnvelope,
  type ProviderStatePolicy,
  type ProviderStateReplacement,
  type QuotaCodecContract,
  type QuotaState,
  ROUTING_SETTINGS_KEY,
  ROUTING_SETTINGS_SCHEMA_VERSION,
  type RoutingSettings,
  type RoutingTarget,
  type RowRef,
  refreshProviderLock,
  type StoredRateLimitResetTimes,
  type TierObservation,
  type UsageObservation,
} from './account-repository-types.ts'

// ---------------------------------------------------------------------------
// The store capabilities this repository uses
// ---------------------------------------------------------------------------

/** A credential as the store loads it (common-auth `StoredCredential`). */
export type StoreCredential =
  | {
      type: 'oauth'
      access?: string
      refresh: string
      expires?: number
      lastRefreshedAt?: number
    }
  | {
      type: 'api'
      apiKey: string
      baseURL: string
      authHeader?: 'authorization-bearer' | 'x-api-key'
    }

/** The fields of a loaded store row this repository reads (`PoolRow`). */
export interface StorePoolRow {
  id: string
  type: 'oauth' | 'api'
  enabled: boolean
  addedAt?: number
  identity?: string
  credential?: StoreCredential
  credentialEpoch?: number
  disabledReason?: string
  quota?: unknown
  providerState?: unknown
  providerStateDropped?: 'uncovered' | 'invalid'
  candidate: boolean
  invalid?: 'roster' | 'entry'
  torn?: true
  stamp?: AccountCredentialStamp
  unbound?: true
}

export type StorePoolLoad =
  | { status: 'ready'; rows: StorePoolRow[] }
  | { status: 'pending-migration' }
  | { status: 'error'; file: 'config' | 'state'; reason: string }

export type StoreSettingsRead =
  | {
      status: 'ready' | 'pending-migration'
      settings: Record<string, unknown>
    }
  | { status: 'error'; file: 'config' | 'state'; reason: string }

/** The credential fence of attributed store writes (`Attribution`). */
export interface StoreAttribution {
  credentialEpoch: number
  identity?: string
}

/**
 * A provider-state mutator. Returning undefined clears the state; an
 * attributed `enable`/`disable` mutator may also return the store's
 * decline value.
 */
export type StoreStateMutator = (
  current: unknown,
  row: StorePoolRow,
) => unknown | Promise<unknown>

export interface StoreTransitionOptions {
  attribution: StoreAttribution
  providerState?: StoreStateMutator
}

export interface StoreTransitionResult {
  id: string
  declined?: true
  providerStateOutcome?: 'updated' | 'cleared' | 'unchanged'
  providerState?: unknown
}

export interface StoreRefreshResult {
  access: string
  refresh: string
  expires: number
  identity?: string
  providerState?: unknown
}

export type StoreRefreshOutcome =
  | {
      status: 'rotated'
      rowId: string
      credential: StoreCredential
      identity?: string
    }
  | {
      status: 'identity-contradicted'
      rowId: string
      expectedIdentity: string
      returnedIdentity: string
    }
  | { status: 'refused'; rowId: string; reason: string }

export interface StoreRemoveView {
  row: StorePoolRow | undefined
  config: Readonly<Record<string, unknown>>
}

export type StoreSettingsMutator = (
  settings: Record<string, unknown>,
) => Record<string, unknown> | undefined

/**
 * The pool-store methods this repository calls, with the parameter and
 * result shapes of common-auth's public `PoolStore` (`dist/store/pool.d.ts`).
 * Written as function-typed properties so the compiler checks parameters
 * strictly when the genuine store is assigned to it.
 */
export interface AccountPoolStore {
  read: () => Promise<StorePoolLoad>
  add: (input: {
    id: string
    credential: { type: 'oauth'; refresh: string }
    identity?: string
    providerState?: unknown
  }) => Promise<{
    id: string
    outcome: 'added' | 'added-disabled' | 'completed' | 'rotated'
  }>
  replace: (
    id: string,
    credential: { type: 'oauth'; refresh: string },
    input: { identity?: string; providerState?: unknown },
    options: { attribution: StoreAttribution },
  ) => Promise<{ id: string; credentialEpoch: number }>
  updateProviderState: (
    id: string,
    fence: StoreAttribution,
    mutator: StoreStateMutator,
  ) => Promise<{
    id: string
    providerState?: unknown
    outcome: 'updated' | 'cleared' | 'unchanged'
  }>
  disable: (
    id: string,
    reason: string,
    options: StoreTransitionOptions,
  ) => Promise<StoreTransitionResult>
  enable: (
    id: string,
    options: StoreTransitionOptions,
  ) => Promise<StoreTransitionResult>
  remove: (
    id: string,
    options: {
      extraLocks?: readonly AccountLockSpec[]
      protect: (id: string, view: StoreRemoveView) => string | undefined
    },
  ) => Promise<{ id: string; outcome: 'removed' | 'completed' }>
  reorder: (ids: readonly string[]) => Promise<{ ids: string[] }>
  readSettings: () => Promise<StoreSettingsRead>
  updateSettings: (
    mutator: StoreSettingsMutator,
    options: { extraLocks?: readonly AccountLockSpec[] },
  ) => Promise<{ settings: Record<string, unknown> }>
  recordIdentity: (
    id: string,
    identity: string,
    attribution: { credentialEpoch: number },
  ) => Promise<{ id: string; disabled: string[] }>
  refresh: (
    id: string,
    provider: (
      credential: {
        type: 'oauth'
        refresh: string
        access?: string
        expires?: number
        lastRefreshedAt?: number
      },
      row: StorePoolRow,
    ) => Promise<StoreRefreshResult>,
    options: {
      providerLock: AccountLockSpec
      refuse: (row: StorePoolRow) => Promise<string | undefined>
    },
  ) => Promise<StoreRefreshOutcome>
  recordQuota: (
    id: string,
    attribution: StoreAttribution,
    observation: unknown,
  ) => Promise<void>
  pullsSettled: () => Promise<void>
}

/**
 * A lock the store took, found held by another holder, or released (the
 * store's public `LockEvent`). `name` and `path` name the lock file.
 */
export interface AccountLockEvent {
  type: 'acquired' | 'released' | 'contended'
  name: string
  path: string
}

/** What this repository opens the store with (`OpenPoolStoreOptions`). */
export interface AccountStoreOpenOptions {
  provider: string
  configPath: string
  statePath: string
  quota: QuotaCodecContract
  providerState: ConfiguredProviderStateCodec
  requireCredentialStamps: true
  now: () => number
  onLockEvent?: (event: AccountLockEvent) => void
}

/** Options of the repositories a factory creates, beside the frozen ones. */
export interface AccountRepositoryFactoryOptions {
  /**
   * Observes every lock the store takes, waits for and releases, through
   * the store's own `onLockEvent`; for diagnostics, such as reporting which
   * account's refresh is waiting on another process. The store ignores an
   * observer that throws.
   */
  onLockEvent?: (event: AccountLockEvent) => void
}

/**
 * The fields of the store's failure value (`PoolOperationError`) that the
 * repository reads to turn it into an `AccountRepositoryFailure`.
 */
export interface StoreOperationFailure extends Error {
  readonly rowId: string | undefined
  readonly phase: 'before-first-write' | 'after-first-write' | 'pull'
  readonly retryable: boolean
  readonly kind: AccountRepositoryFailureKind
}

/**
 * The parts of common-auth's public `./store` module the repository needs:
 * the store opener, the value an attributed transition mutator returns to
 * decline, and the store's failure class.
 */
export interface AccountStoreModule {
  readonly openPoolStore: (options: AccountStoreOpenOptions) => AccountPoolStore
  readonly DECLINE_TRANSITION: symbol
  readonly PoolOperationError: abstract new (
    ...args: never[]
  ) => StoreOperationFailure
}

/** What `withLock` hands its callback: a check that the lease is still held. */
export interface AccountLease {
  assertOwned(): Promise<void>
}

/**
 * The parts of common-auth's public `./fs` module the repository needs
 * (`dist/fs/with-lock.d.ts`): `withLock`, which holds a file lease for the
 * duration of a callback and releases it afterwards, and its two failure
 * classes, thrown when the lease cannot be taken in time and when an
 * `assertOwned` finds it lost.
 */
export interface AccountLockModule {
  readonly withLock: <T>(
    target: string,
    options: {
      name: string
      ttlMs: number
      timeoutMs: number
      renew?: boolean
    },
    fn: (lock: AccountLease) => Promise<T>,
  ) => Promise<T>
  readonly LockContentionError: abstract new (...args: never[]) => Error
  readonly LockOwnershipError: abstract new (...args: never[]) => Error
}

/** The genuine public common-auth modules a repository is built on. */
export interface AccountStoreModules {
  /** The package's `./store` entry. */
  store: AccountStoreModule
  /** The package's `./fs` entry, from the same package. */
  fs: AccountLockModule
}

/**
 * Read config and state under the writer's save locks so generation
 * validation cannot observe a partial store write.
 */
const STORE_SAVE_LOCK = {
  name: 'save',
  ttlMs: 10_000,
  timeoutMs: 15_000,
  renew: true,
} as const

/**
 * The lease that orders the local operations that change which rows the
 * pool holds: login, re-authentication, `clear` and `replacePool`, each
 * from its first read to its last write. It is taken before any store lock
 * and around nothing else. Refreshes, quota, identity and routing writes
 * never wait for it; the store's own per-row credential-epoch checks fence
 * them. Its name differs from every lock the store takes, including the
 * inner management lock, so holding it never makes a store call wait on
 * itself. The repository checks the lease before each write and the lease
 * renews itself; a check comes before the act it guards, so a stall longer
 * than the lease's lifetime can still lose it in between. It is a file
 * lease, not a kernel lock.
 */
const TOPOLOGY_LEASE = {
  name: 'antigravity-topology',
  ttlMs: 10_000,
  /** The store's own default bounded wait for a lock. */
  timeoutMs: 15_000,
  renew: true,
} as const

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Thrown by every repository operation that fails. `failure` says how; the
 * message never contains a credential, an email or an identity.
 */
export class AccountRepositoryError extends Error {
  readonly failure: AccountRepositoryFailure

  constructor(
    failure: AccountRepositoryFailure,
    options?: { cause?: unknown },
  ) {
    super(failure.message, options)
    this.name = 'AccountRepositoryError'
    this.failure = failure
  }
}

function refusal(
  operation: AccountRepositoryOperation,
  kind: AccountRepositoryFailureKind,
  message: string,
  details: { rowId?: string; retryable?: boolean; ambiguous?: boolean } = {},
): AccountRepositoryError {
  return new AccountRepositoryError({
    operation,
    kind,
    retryable: details.retryable ?? false,
    ambiguous: details.ambiguous ?? false,
    ...(details.rowId !== undefined ? { rowId: details.rowId } : {}),
    message,
  })
}

// ---------------------------------------------------------------------------
// Provider-metadata rules
// ---------------------------------------------------------------------------

/** The UTC day `at` falls on, as `dailyRequestCounts.date` records it. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Combines two rate-limit maps key by key, keeping the later reset time of
 * each key. A `null` (written by an older build) never replaces a time.
 */
export function mergeRateLimitResets(
  stored: StoredRateLimitResetTimes | null | undefined,
  incoming: Readonly<StoredRateLimitResetTimes> | null,
): StoredRateLimitResetTimes | null {
  if (incoming === null) return stored === undefined ? null : stored
  const out: StoredRateLimitResetTimes = { ...(stored ?? {}) }
  for (const [key, value] of Object.entries(incoming)) {
    const prior = out[key]
    if (value === null) {
      if (prior === undefined) out[key] = null
    } else if (typeof prior !== 'number' || value > prior) {
      out[key] = value
    }
  }
  return out
}

/** The later of two evidence times, ignoring absent and `null` ones. */
function latest(...times: (number | null | undefined)[]): number | undefined {
  let result: number | undefined
  for (const time of times) {
    if (typeof time === 'number' && (result === undefined || time > result)) {
      result = time
    }
  }
  return result
}

/**
 * The latest of `verificationRequiredAt`, `accountIneligibleAt` and
 * `eligibilityStateUpdatedAt`: when the newest access evidence was observed.
 */
export function accessEvidenceAt(
  metadata: ProviderMetadata,
): number | undefined {
  return latest(
    metadata.verificationRequiredAt,
    metadata.accountIneligibleAt,
    metadata.eligibilityStateUpdatedAt,
  )
}

function mergeExtensions(
  a: JsonObject | undefined,
  b: JsonObject | undefined,
): JsonObject | undefined {
  if (a === undefined && b === undefined) return undefined
  return { ...(a ?? {}), ...(b ?? {}) }
}

/**
 * Combines stored metadata with metadata a same-credential write brings (a
 * refresh, or a login of a secret the pool already holds). Every field the
 * incoming value carries replaces the stored one, except the fields other
 * writers accumulate: the user-visible add time stays, `lastUsed` keeps the
 * later time, request counts stay (they change only by increments, so a
 * stale copy must never overwrite them), and rate limits merge key by key.
 */
function mergeSameCredential(
  stored: ProviderMetadata,
  incoming: ProviderMetadata,
): ProviderMetadata {
  const out: ProviderMetadata = {
    ...stored,
    ...incoming,
    addedAt: stored.addedAt,
    lastUsed: Math.max(stored.lastUsed, incoming.lastUsed),
  }
  if (stored.dailyRequestCounts != null) {
    out.dailyRequestCounts = stored.dailyRequestCounts
  }
  if (incoming.rateLimitResetTimes !== undefined) {
    out.rateLimitResetTimes = mergeRateLimitResets(
      stored.rateLimitResetTimes,
      incoming.rateLimitResetTimes,
    )
  }
  const extensions = mergeExtensions(stored.extensions, incoming.extensions)
  if (extensions !== undefined) out.extensions = extensions
  return out
}

/**
 * Fields a replaced row keeps whoever the new credential belongs to. They
 * describe the existing row rather than the signed-in account: when it was
 * added and last used, how its enabled flag was written, its label, its
 * request counts and unknown extensions.
 */
const ROW_RETAINED_FIELDS = [
  'addedAt',
  'lastUsed',
  'enabled',
  'lastSwitchReason',
  'label',
  'dailyRequestCounts',
  'extensions',
] as const satisfies readonly (keyof ProviderMetadata)[]

/**
 * Account-describing fields a replaced row keeps only when the prior
 * identity the store read under its locks equals the identity the replace
 * records. The verification and eligibility fields are credential-bound too
 * but are never kept: they describe the old credential.
 */
const SAME_ACCOUNT_RETAINED_FIELDS = [
  'email',
  'projectId',
  'managedProjectId',
  'fingerprint',
  'fingerprintHistory',
  'capturedTierId',
  'capturedPaidTierId',
  'capturedTierAt',
  'capturedTierSchemaVersion',
] as const satisfies readonly (keyof ProviderMetadata)[]

function copyFields<K extends keyof ProviderMetadata>(
  from: ProviderMetadata,
  to: Partial<ProviderMetadata>,
  keys: readonly K[],
): void {
  for (const key of keys) {
    if (key in from) to[key] = from[key]
  }
}

/**
 * The metadata a row keeps after `replace` gives it a new credential.
 *
 * The old credential's rate-limit resets, cooldown, and verification and
 * eligibility fields are dropped. The row's own fields
 * (`ROW_RETAINED_FIELDS`) are kept. The account-describing fields
 * (`SAME_ACCOUNT_RETAINED_FIELDS`) are kept only when the store's locked
 * `previousIdentity` and the identity the replace records are both known
 * and equal; otherwise nothing proves the new credential is the same
 * account, and only the incoming metadata supplies them. Fields the
 * incoming metadata carries override kept ones, except the accumulated
 * `addedAt`, `lastUsed` and `dailyRequestCounts`.
 */
function replacementMetadata(
  previous: ProviderMetadata | undefined,
  replacement: ProviderStateReplacement,
): ProviderMetadata | undefined {
  const incoming = replacement.incoming?.metadata
  if (previous === undefined) return incoming
  const sameAccount =
    replacement.previousIdentity !== undefined &&
    replacement.identity !== undefined &&
    replacement.previousIdentity === replacement.identity
  const kept: Partial<ProviderMetadata> = {}
  copyFields(previous, kept, ROW_RETAINED_FIELDS)
  if (sameAccount) copyFields(previous, kept, SAME_ACCOUNT_RETAINED_FIELDS)
  const base: ProviderMetadata = {
    ...kept,
    addedAt: previous.addedAt,
    lastUsed: previous.lastUsed,
  }
  if (incoming === undefined) return base
  return mergeSameCredential(base, incoming)
}

/**
 * The repository's rules for combining provider metadata. The public store
 * applies them, under its locks, through the codec `createProviderStateCodec`
 * builds from them: `merge` when a same-credential write brings metadata,
 * `onReplace` when `replace` gives a row a new credential.
 */
export const ACCOUNT_STATE_POLICY: ProviderStatePolicy = {
  merge(onDisk, incoming) {
    const extensions = mergeExtensions(onDisk.extensions, incoming.extensions)
    return {
      schemaVersion: PROVIDER_STATE_SCHEMA_VERSION,
      metadata: mergeSameCredential(onDisk.metadata, incoming.metadata),
      ...(extensions !== undefined ? { extensions } : {}),
    }
  },
  onReplace(previous, replacement) {
    const metadata = replacementMetadata(previous?.metadata, replacement)
    if (metadata === undefined) return undefined
    const extensions = mergeExtensions(
      previous?.extensions,
      replacement.incoming?.extensions,
    )
    return {
      schemaVersion: PROVIDER_STATE_SCHEMA_VERSION,
      metadata,
      ...(extensions !== undefined ? { extensions } : {}),
    }
  },
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export function applyProjectObservation(
  metadata: ProviderMetadata,
  observation: ProjectObservation,
): ProviderMetadata {
  const next = { ...metadata }
  if (observation.projectId !== undefined)
    next.projectId = observation.projectId
  if (observation.managedProjectId !== undefined) {
    next.managedProjectId = observation.managedProjectId
  }
  return next
}

/** History is stored exactly as given: in its order and untruncated. */
export function applyFingerprintObservation(
  metadata: ProviderMetadata,
  observation: FingerprintObservation,
): ProviderMetadata {
  return {
    ...metadata,
    fingerprint: observation.fingerprint,
    fingerprintHistory: [...observation.history],
  }
}

/** A tier reading older than the stored one leaves it as it is. */
export function applyTierObservation(
  metadata: ProviderMetadata,
  observation: TierObservation,
): ProviderMetadata {
  if (
    typeof metadata.capturedTierAt === 'number' &&
    observation.observedAt < metadata.capturedTierAt
  ) {
    return metadata
  }
  return {
    ...metadata,
    capturedTierId: observation.tierId,
    capturedPaidTierId: observation.paidTierId,
    capturedTierAt: observation.observedAt,
    capturedTierSchemaVersion: observation.schemaVersion,
  }
}

/** `null` ends the cooldown: both fields are removed. */
export function applyCooldownObservation(
  metadata: ProviderMetadata,
  observation: CooldownObservation,
): ProviderMetadata {
  const next = { ...metadata }
  if (observation === null) {
    delete next.coolingDownUntil
    delete next.cooldownReason
  } else {
    next.coolingDownUntil = observation.until
    next.cooldownReason = observation.reason
  }
  return next
}

export function applyRateLimitObservation(
  metadata: ProviderMetadata,
  resets: Readonly<StoredRateLimitResetTimes>,
): ProviderMetadata {
  return {
    ...metadata,
    rateLimitResetTimes: mergeRateLimitResets(
      metadata.rateLimitResetTimes,
      resets,
    ),
  }
}

export function applySwitch(
  metadata: ProviderMetadata,
  reason: LastSwitchReason,
): ProviderMetadata {
  return { ...metadata, lastSwitchReason: reason }
}

/**
 * Counts one request for the family on the UTC day of `now`, starting the
 * day from zero when the stored counts belong to another day, and keeps the
 * later `lastUsed`. Unknown keys of the stored counts stay when the day is
 * the same.
 */
export function applyUsage(
  metadata: ProviderMetadata,
  observation: UsageObservation,
  now: number,
): ProviderMetadata {
  const today = utcDay(now)
  const stored = metadata.dailyRequestCounts
  const counts =
    stored != null && stored.date === today
      ? { ...stored }
      : { date: today, claude: 0, gemini: 0 }
  counts[observation.family] += 1
  return {
    ...metadata,
    lastUsed: Math.max(metadata.lastUsed, observation.at),
    dailyRequestCounts: counts,
  }
}

/** What an access verdict does to a row's enabled flag. */
export type AccessTransition = 'disable' | 'enable' | 'keep'

/**
 * Applies access evidence. A verdict observed before the newest stored
 * evidence returns `undefined`: it must not undo what a later observation
 * established.
 */
export function applyAccessVerdict(
  metadata: ProviderMetadata,
  verdict: AccessVerdict,
): { metadata: ProviderMetadata; transition: AccessTransition } | undefined {
  const evidenceAt = accessEvidenceAt(metadata)
  if (evidenceAt !== undefined && verdict.observedAt < evidenceAt) {
    return undefined
  }
  const next = { ...metadata }
  switch (verdict.kind) {
    case 'verification-required': {
      next.verificationRequired = true
      next.verificationRequiredAt = verdict.observedAt
      const reason = verdict.reason?.trim()
      if (reason) next.verificationRequiredReason = reason
      else delete next.verificationRequiredReason
      const url = verdict.verificationUrl?.trim()
      if (url) next.verificationUrl = url
      if (
        next.accountIneligible === true ||
        next.accountIneligibleAt != null ||
        next.accountIneligibleReason != null
      ) {
        next.accountIneligible = false
        delete next.accountIneligibleAt
        delete next.accountIneligibleReason
        next.eligibilityStateUpdatedAt = verdict.observedAt
      }
      return { metadata: next, transition: 'disable' }
    }
    case 'ineligible': {
      next.accountIneligible = true
      next.accountIneligibleAt = verdict.observedAt
      next.accountIneligibleReason =
        verdict.reason.trim() || 'Google marked this account as ineligible.'
      next.eligibilityStateUpdatedAt = verdict.observedAt
      next.verificationRequired = false
      delete next.verificationRequiredAt
      delete next.verificationRequiredReason
      delete next.verificationUrl
      return { metadata: next, transition: 'disable' }
    }
    case 'cleared': {
      const wasBlocked =
        metadata.verificationRequired === true ||
        metadata.accountIneligible === true
      const hadEligibility =
        metadata.accountIneligible === true ||
        metadata.eligibilityStateUpdatedAt != null
      next.verificationRequired = false
      delete next.verificationRequiredAt
      delete next.verificationRequiredReason
      delete next.verificationUrl
      next.accountIneligible = false
      delete next.accountIneligibleAt
      delete next.accountIneligibleReason
      if (hadEligibility) next.eligibilityStateUpdatedAt = verdict.observedAt
      return {
        metadata: next,
        transition: verdict.enable && wasBlocked ? 'enable' : 'keep',
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function envelopeOf(raw: unknown): ProviderStateEnvelope | undefined {
  return raw === undefined || raw === null
    ? undefined
    : decodeProviderState(raw)
}

/**
 * The row's provider state, refusing a row whose stored value is not shown
 * (`providerStateDropped`): a write there would replace data the store kept
 * on disk with a value regenerated from nothing.
 */
function shownEnvelope(
  operation: AccountRepositoryOperation,
  current: unknown,
  row: StorePoolRow,
): ProviderStateEnvelope | undefined {
  if (row.providerStateDropped !== undefined) {
    throw new CallbackRefusal(
      refusal(
        operation,
        'metadata-dropped',
        `row ${row.id} holds metadata the store does not show (${row.providerStateDropped})`,
        { rowId: row.id },
      ),
    )
  }
  return envelopeOf(current)
}

/** Stored metadata, or a starting value for a row that shows none. */
function metadataOrBase(
  envelope: ProviderStateEnvelope | undefined,
  row: StorePoolRow,
  now: number,
): ProviderMetadata {
  return envelope?.metadata ?? { addedAt: row.addedAt ?? now, lastUsed: 0 }
}

function encodeEnvelope(
  prior: ProviderStateEnvelope | undefined,
  metadata: ProviderMetadata,
): JsonObject {
  return encodeProviderState({
    schemaVersion: PROVIDER_STATE_SCHEMA_VERSION,
    metadata,
    ...(prior?.extensions !== undefined
      ? { extensions: prior.extensions }
      : {}),
  })
}

function metadataOfStored(raw: unknown): ProviderMetadata | undefined {
  return envelopeOf(raw)?.metadata
}

function metadataView(row: StorePoolRow): AccountMetadataView {
  if (row.providerStateDropped !== undefined) {
    return { status: 'dropped', reason: row.providerStateDropped }
  }
  if (row.providerState === undefined) return { status: 'absent' }
  return {
    status: 'present',
    metadata: decodeProviderState(row.providerState).metadata,
  }
}

function quotaView(row: StorePoolRow): AccountQuotaView {
  return row.quota === undefined
    ? { status: 'absent' }
    : { status: 'present', quota: decodeQuotaState(row.quota) }
}

export function toAccountRow(row: StorePoolRow, index: number): AccountRow {
  const credential = row.credential
  return {
    ref: rowRefOf(row),
    index,
    enabled: row.enabled,
    ...(row.disabledReason !== undefined
      ? { disabledReason: row.disabledReason }
      : {}),
    ...(row.addedAt !== undefined ? { storeAddedAt: row.addedAt } : {}),
    ...(credential?.type === 'oauth'
      ? {
          credential: {
            refreshToken: credential.refresh,
            ...(credential.access !== undefined
              ? { accessToken: credential.access }
              : {}),
            ...(credential.expires !== undefined
              ? { expiresAt: credential.expires }
              : {}),
          },
        }
      : {}),
    usable: row.candidate,
    stamp: row.stamp ?? (credential === undefined ? 'none' : 'missing'),
    ...(row.torn ? { torn: true as const } : {}),
    ...(row.unbound ? { unbound: true as const } : {}),
    ...(row.invalid !== undefined ? { invalid: row.invalid } : {}),
    metadata: metadataView(row),
    quota: quotaView(row),
  }
}

function isManagementKind(value: unknown): value is ManagementKind {
  return value === 'migration' || value === 'clear' || value === 'replace-pool'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * A management record's id: the lowercase UUID `randomUUID` gives. It also
 * names the record's transfer file, so nothing else may select a path.
 */
const MANAGEMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Reject management steps outside each operation's published schema.
 * Migration owns its phase list; this repository uses it to reject malformed
 * journals and block ordinary work.
 */
const MANAGEMENT_STEPS: Record<ManagementKind, readonly string[]> = {
  clear: ['remove'],
  'replace-pool': ['remove', 'add', 'verified'],
  migration: ACCOUNT_MIGRATION_MANAGEMENT_STEPS,
}

/**
 * JSON with the keys of every object sorted, so two values that differ only
 * in key order serialize the same. Array order is kept.
 */
function canonicalJson(value: JsonValue): string {
  const sorted = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(sorted)
    if (item === null || typeof item !== 'object') return item
    const out: JsonObject = {}
    for (const key of Object.keys(item).sort()) {
      const child = item[key]
      if (child !== undefined) out[key] = sorted(child)
    }
    return out
  }
  return JSON.stringify(sorted(value))
}

/** A SHA-256 digest in lowercase hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * A management record as this repository stores it. A `replace-pool`
 * record also keeps `inputDigest`, the `replacementInputDigest` of the
 * inputs it was started with, so a resume is accepted only for those exact
 * inputs, even once the transfer file is gone. Readers of the pool are
 * shown the record without it (`publicManagementRecord`).
 */
export interface StoredManagementRecord extends ManagementRecord {
  inputDigest?: string
}

/**
 * SHA-256 of the inputs' encoding as key-sorted JSON (`canonicalJson`), in
 * their order: ids, refresh tokens, identities and metadata values all
 * count, as do array order and an explicit `null`, while the order in which
 * an object's keys were built does not. It identifies a replacement without
 * the journal holding any credential.
 */
export function replacementInputDigest(
  inputs: readonly AccountLoginInput[],
): string {
  return createHash('sha256')
    .update(canonicalJson(inputs.map(encodeLoginInput)))
    .digest('hex')
}

/** The record in its frozen public shape; `inputDigest` is omitted. */
function publicManagementRecord(
  record: StoredManagementRecord,
): ManagementRecord {
  return {
    id: record.id,
    kind: record.kind,
    targets: [...record.targets],
    progress: {
      step: record.progress.step,
      completedTargets: [...record.progress.completedTargets],
    },
  }
}

/** A list of non-empty ids with no id twice; throws otherwise. */
function uniqueIds(value: unknown, path: string): string[] {
  if (!isStringList(value)) {
    throw new AccountCodecError(path, 'must be a list of ids')
  }
  const seen = new Set<string>()
  for (const id of value) {
    if (!id) throw new AccountCodecError(path, 'must not hold an empty id')
    if (seen.has(id)) throw new AccountCodecError(path, 'must not repeat an id')
    seen.add(id)
  }
  return [...value]
}

/**
 * Reads the record of a pending multi-row operation (`clear` or
 * `replacePool`) kept under `MANAGEMENT_SETTINGS_KEY` in the store's
 * settings; while it exists, ordinary operations are refused. Throws
 * `AccountCodecError` when the record is malformed: an id that is not a
 * UUID, a step its kind does not have, a repeated or empty id, or, while
 * rows are being removed, a completed id that is not a target, and an
 * `inputDigest` that is missing or malformed on a `replace-pool` record or
 * present on any other. In the `add` and `verified` steps of `replace-pool`
 * the completed ids are replacement input ids, which `replacePool` checks
 * against the ids of the inputs.
 */
export function decodeManagementRecord(raw: unknown): StoredManagementRecord {
  if (!isRecord(raw)) {
    throw new AccountCodecError('$', 'must be an object')
  }
  const record = raw
  const progress = record.progress
  if (typeof record.id !== 'string' || !MANAGEMENT_ID.test(record.id)) {
    throw new AccountCodecError('$.id', 'must be a lowercase UUID')
  }
  if (!isManagementKind(record.kind)) {
    throw new AccountCodecError('$.kind', 'must be a management kind')
  }
  const targets = uniqueIds(record.targets, '$.targets')
  if (!isRecord(progress)) {
    throw new AccountCodecError('$.progress', 'must be an object')
  }
  const { step } = progress
  const steps = MANAGEMENT_STEPS[record.kind]
  if (typeof step !== 'string' || !steps.includes(step)) {
    throw new AccountCodecError(
      '$.progress.step',
      `must be a step of a ${record.kind} record`,
    )
  }
  const completedTargets = uniqueIds(
    progress.completedTargets,
    '$.progress.completedTargets',
  )
  if (
    step === 'remove' &&
    completedTargets.some((id) => !targets.includes(id))
  ) {
    throw new AccountCodecError(
      '$.progress.completedTargets',
      'must name only targets while rows are being removed',
    )
  }
  const inputDigest = record.inputDigest
  if (record.kind === 'replace-pool') {
    if (typeof inputDigest !== 'string' || !SHA256_HEX.test(inputDigest)) {
      throw new AccountCodecError(
        '$.inputDigest',
        'must be the SHA-256 of the replacement inputs',
      )
    }
  } else if (inputDigest !== undefined) {
    throw new AccountCodecError(
      '$.inputDigest',
      'belongs only to a replace-pool record',
    )
  }
  return {
    id: record.id,
    kind: record.kind,
    targets,
    progress: { step, completedTargets },
    ...(typeof inputDigest === 'string' ? { inputDigest } : {}),
  }
}

function encodeManagementRecord(record: StoredManagementRecord): JsonObject {
  return {
    id: record.id,
    kind: record.kind,
    targets: [...record.targets],
    progress: {
      step: record.progress.step,
      completedTargets: [...record.progress.completedTargets],
    },
    ...(record.inputDigest !== undefined
      ? { inputDigest: record.inputDigest }
      : {}),
  }
}

/**
 * The private file `replacePool` writes before it starts: the new logins,
 * kept so a replacement interrupted part-way can be resumed with the same
 * inputs, and deleted once the new pool is verified.
 */
interface TransferFile {
  schemaVersion: 1
  managementId: string
  inputs: JsonObject[]
}

/**
 * Reads a transfer file written for the management record `managementId`.
 * Throws `AccountCodecError` for a file of another record or version, and
 * for inputs `replacePool` would itself refuse: a repeated or empty id, or
 * an empty refresh token.
 */
export function decodeTransferFile(
  raw: unknown,
  managementId: string,
): AccountLoginInput[] {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.managementId !== managementId ||
    !Array.isArray(raw.inputs)
  ) {
    throw new AccountCodecError(
      'transfer',
      'does not belong to this management record',
    )
  }
  const inputs = raw.inputs.map(decodeLoginInput)
  uniqueIds(
    inputs.map((input) => input.id),
    'transfer.inputs[].id',
  )
  if (inputs.some((input) => !input.refreshToken.trim())) {
    throw new AccountCodecError(
      'transfer.inputs[].refreshToken',
      'must not be empty',
    )
  }
  return inputs
}

function encodeLoginInput(input: AccountLoginInput): JsonObject {
  return {
    id: input.id,
    refreshToken: input.refreshToken,
    ...(input.identity !== undefined ? { identity: input.identity } : {}),
    metadata: encodeProviderMetadata(input.metadata),
  }
}

function decodeLoginInput(raw: unknown): AccountLoginInput {
  if (!isRecord(raw)) {
    throw new AccountCodecError('$.inputs[]', 'must be an object')
  }
  const value = raw
  if (typeof value.id !== 'string' || typeof value.refreshToken !== 'string') {
    throw new AccountCodecError(
      '$.inputs[]',
      'must name an id and a refresh token',
    )
  }
  if (value.identity !== undefined && typeof value.identity !== 'string') {
    throw new AccountCodecError('$.inputs[].identity', 'must be a string')
  }
  return {
    id: value.id,
    refreshToken: value.refreshToken,
    ...(typeof value.identity === 'string' ? { identity: value.identity } : {}),
    metadata: decodeProviderMetadata(value.metadata),
  }
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

/** Refuse unpublished, pending, rolled-back or invalid store generations. */
function unbound(
  operation: AccountRepositoryOperation,
  binding: Exclude<AccountStoreBinding, { status: 'bound' }>,
): AccountRepositoryError {
  switch (binding.status) {
    case 'pending':
      return refusal(
        operation,
        'pending-migration',
        'the account store has a migration or rollback in progress',
        { retryable: true },
      )
    case 'initialization-required':
      return refusal(
        operation,
        'pending-migration',
        'the account store has not been initialized',
        { retryable: true },
      )
    case 'inactive':
      return refusal(
        operation,
        'load-error',
        'the account-store generation was rolled back',
      )
    case 'error':
      return refusal(operation, 'load-error', binding.reason)
  }
}

/**
 * Return a reason when settings do not name the expected generation and
 * directory; otherwise return undefined.
 */
function generationMismatch(
  settings: Record<string, unknown>,
  id: string,
  paths: AccountStorePaths,
): string | undefined {
  try {
    const generation = decodeAccountStoreGeneration(
      settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY],
    )
    return generation.id === id && generation.storeDir === paths.storeDir
      ? undefined
      : 'the store now belongs to another account-store generation'
  } catch {
    return 'the store holds no valid account-store generation'
  }
}

/**
 * The lock guarding the management record. Every write of the record, and
 * every row removal a management operation makes, passes it to the store
 * as an extra lock, which the store takes after the row lock and before
 * its own save locks.
 */
function managementLock(paths: AccountStorePaths): AccountLockSpec {
  return { name: MANAGEMENT_LOCK_NAME, path: paths.configPath }
}

/**
 * Raised inside a store callback to refuse the write with a repository
 * failure; the store rethrows it wrapped, and `failureOf` unwraps it.
 */
class CallbackRefusal extends Error {
  readonly error: AccountRepositoryError
  constructor(error: AccountRepositoryError) {
    super(error.message)
    this.name = 'CallbackRefusal'
    this.error = error
  }
}

class StoreAccountRepository implements AccountRepository {
  private readonly store: AccountPoolStore
  private readonly decline: symbol
  private readonly storeFailure: AccountStoreModule['PoolOperationError']
  private readonly locks: AccountLockModule
  private readonly storeModule: AccountStoreModule
  /** Cached promise for the validated generation ID. Failed attempts are discarded. */
  private binding: Promise<string> | undefined
  /** The canonical config path the topology lease is named after. */
  private leaseTarget: Promise<string> | undefined
  private readonly paths: AccountStorePaths
  private readonly now: () => number
  private readonly exchange: AccountTokenExchange

  /** Every started operation; each leaves the set once its promise settles. */
  private readonly inFlight = new Set<Promise<unknown>>()
  /**
   * Failures since the last `flush`, kept so each is reported once: `flush`
   * and `dispose` resolve with them in their report and then forget them.
   */
  private failures: AccountRepositoryFailure[] = []
  private completed = 0
  /**
   * The refresh running for each credential, keyed by `rowRefKey` (row id,
   * epoch and identity), so concurrent refreshes of one credential in this
   * process share a single exchange.
   */
  private readonly refreshes = new Map<string, Promise<AccountRefreshOutcome>>()
  private closing = false

  constructor(
    modules: AccountStoreModules,
    options: AccountRepositoryOptions,
    factoryOptions: AccountRepositoryFactoryOptions,
  ) {
    const module = modules.store
    this.storeModule = module
    this.locks = modules.fs
    this.paths = options.paths
    this.now = options.now
    this.exchange = options.exchange
    this.decline = module.DECLINE_TRANSITION
    this.storeFailure = module.PoolOperationError
    this.store = module.openPoolStore({
      provider: ACCOUNT_STORE_PROVIDER,
      configPath: options.paths.configPath,
      statePath: options.paths.statePath,
      quota: QUOTA_CODEC,
      providerState: createProviderStateCodec(ACCOUNT_STATE_POLICY),
      requireCredentialStamps: true,
      now: options.now,
      ...(factoryOptions.onLockEvent !== undefined
        ? { onLockEvent: factoryOptions.onLockEvent }
        : {}),
    })
  }

  // ---- failure conversion and tracking of started operations -------------

  private failureOf(
    operation: AccountRepositoryOperation,
    rowId: string | undefined,
    error: unknown,
  ): AccountRepositoryError {
    if (error instanceof AccountRepositoryError) return error
    if (error instanceof CallbackRefusal) return error.error
    if (error instanceof this.storeFailure) {
      if (error.cause instanceof CallbackRefusal) return error.cause.error
      if (error.cause instanceof AccountRepositoryError) return error.cause
      const id = error.rowId ?? rowId
      return new AccountRepositoryError(
        {
          operation,
          kind:
            error.cause instanceof AccountCodecError
              ? 'invalid-provider-state'
              : error.kind,
          retryable: error.retryable,
          ambiguous: error.phase === 'after-first-write',
          ...(id !== undefined ? { rowId: id } : {}),
          message: error.message,
        },
        { cause: error },
      )
    }
    if (
      error instanceof this.locks.LockOwnershipError ||
      error instanceof this.locks.LockContentionError
    ) {
      // The topology lease was lost or not taken in time: a retryable lock
      // failure. A multi-row management operation keeps its progress record,
      // so it is pending and resumes; an ordinary operation simply failed
      // before its next write and has no record.
      return new AccountRepositoryError(
        {
          operation,
          kind:
            error instanceof this.locks.LockOwnershipError
              ? 'lock-ownership'
              : 'lock-contention',
          retryable: true,
          ambiguous: false,
          ...(rowId !== undefined ? { rowId } : {}),
          message: error.message,
        },
        { cause: error },
      )
    }
    if (error instanceof AccountCodecError) {
      return new AccountRepositoryError(
        {
          operation,
          kind: 'invalid-input',
          retryable: false,
          ambiguous: false,
          ...(rowId !== undefined ? { rowId } : {}),
          message: error.message,
        },
        { cause: error },
      )
    }
    return new AccountRepositoryError(
      {
        operation,
        kind: 'unexpected',
        retryable: false,
        // Nothing says how far a write got before an unknown error.
        ambiguous: operation !== 'read' && operation !== 'flush',
        ...(rowId !== undefined ? { rowId } : {}),
        message: error instanceof Error ? error.message : 'unexpected failure',
      },
      { cause: error },
    )
  }

  /**
   * Runs one operation as owned work: refused once `dispose` has begun,
   * counted by `flush`, and its failure recorded for the flush report while
   * the caller still receives it.
   */
  private run<T>(
    operation: AccountRepositoryOperation,
    rowId: string | undefined,
    body: () => Promise<T>,
  ): Promise<T> {
    if (this.closing) {
      return Promise.reject(
        refusal(operation, 'disposed', 'the account repository is disposed', {
          ...(rowId !== undefined ? { rowId } : {}),
        }),
      )
    }
    const work = (async () => {
      try {
        const result = await body()
        if (operation !== 'read') this.completed += 1
        return result
      } catch (error) {
        const failure = this.failureOf(operation, rowId, error)
        this.failures.push(failure.failure)
        throw failure
      }
    })()
    this.inFlight.add(work)
    const forget = () => this.inFlight.delete(work)
    work.then(forget, forget)
    return work
  }

  /**
   * Runs `body` holding the topology lease (`TOPOLOGY_LEASE`), named after
   * the config file's canonical path so every repository on the pool, in
   * any process, takes the same lease. `body` checks the lease before each
   * write it makes; a lease found lost stops it there.
   */
  private async withTopology<T>(
    operation: AccountRepositoryOperation,
    body: (lease: AccountLease) => Promise<T>,
  ): Promise<T> {
    // The lease is named after the bound generation's config file, so the
    // generation is bound (and its directory known to exist) first.
    await this.bindGeneration(operation)
    this.leaseTarget ??= realpath(dirname(this.paths.configPath)).then((dir) =>
      join(dir, basename(this.paths.configPath)),
    )
    // A failed resolution is not cached, so a later call can retry it.
    const target = await this.leaseTarget.catch((error: unknown) => {
      this.leaseTarget = undefined
      throw error
    })
    return this.locks.withLock(target, TOPOLOGY_LEASE, async (lease) => {
      await lease.assertOwned()
      return body(lease)
    })
  }

  /**
   * Verify which completed active generation owns these physical paths.
   * Cache only successful binding; separate journal and row checks still
   * decide serving readiness.
   */
  private bindGeneration(
    operation: AccountRepositoryOperation,
  ): Promise<string> {
    if (this.binding === undefined) {
      const binding = this.readBinding().then((result) => {
        if (result.status !== 'bound') throw unbound(operation, result)
        if (!isDeepStrictEqual(result.paths, this.paths)) {
          throw refusal(
            operation,
            'load-error',
            "the published account-store generation is not this repository's",
          )
        }
        return result.receipt.id
      })
      this.binding = binding
      binding.catch(() => {
        if (this.binding === binding) this.binding = undefined
      })
    }
    return this.binding
  }

  /**
   * Read the migration's published-generation binding. When its directory
   * exists, acquire config then state save locks to avoid validating a
   * partial store write.
   */
  private async readBinding(): Promise<AccountStoreBinding> {
    const read = () =>
      readAccountStoreBinding(
        this.paths.legacyPath,
        { store: this.storeModule },
        this.now,
      )
    const directory = await stat(this.paths.storeDir).catch(() => undefined)
    if (directory === undefined || !directory.isDirectory()) return read()
    return this.locks.withLock(this.paths.configPath, STORE_SAVE_LOCK, () =>
      this.locks.withLock(this.paths.statePath, STORE_SAVE_LOCK, read),
    )
  }

  /**
   * Read current settings and refuse if their generation no longer matches
   * this repository's binding.
   */
  private async boundSettings(
    operation: AccountRepositoryOperation,
  ): Promise<Record<string, unknown>> {
    const id = await this.bindGeneration(operation)
    const settings = await this.readSettings(operation)
    const mismatch = generationMismatch(settings, id, this.paths)
    if (mismatch !== undefined) throw refusal(operation, 'load-error', mismatch)
    return settings
  }

  private async admit(
    operation: AccountRepositoryOperation,
    rowId?: string,
  ): Promise<void> {
    const settings = await this.boundSettings(operation)
    const raw = settings[MANAGEMENT_SETTINGS_KEY]
    const pending = raw === undefined ? undefined : decodeManagementRecord(raw)
    if (pending !== undefined) {
      throw refusal(
        operation,
        'management-pending',
        `a ${pending.kind} of the account pool is pending`,
        { retryable: true, ...(rowId !== undefined ? { rowId } : {}) },
      )
    }
  }

  private async readSettings(
    operation: AccountRepositoryOperation,
  ): Promise<Record<string, unknown>> {
    const read = await this.store.readSettings()
    if (read.status === 'error') {
      throw refusal(
        operation,
        'load-error',
        `the ${read.file} file could not be read: ${read.reason}`,
        {
          retryable: true,
        },
      )
    }
    return read.settings
  }

  private async readManagement(
    operation: AccountRepositoryOperation,
  ): Promise<StoredManagementRecord | undefined> {
    const raw = (await this.readSettings(operation))[MANAGEMENT_SETTINGS_KEY]
    return raw === undefined ? undefined : decodeManagementRecord(raw)
  }

  private async readRows(
    operation: AccountRepositoryOperation,
  ): Promise<StorePoolRow[]> {
    const load = await this.store.read()
    if (load.status === 'pending-migration') {
      throw refusal(
        operation,
        'pending-migration',
        'the account pool awaits migration',
        {
          retryable: true,
        },
      )
    }
    if (load.status === 'error') {
      throw refusal(
        operation,
        'load-error',
        `the ${load.file} file could not be read: ${load.reason}`,
        {
          retryable: true,
        },
      )
    }
    return load.rows
  }

  private async accountRowFor(
    operation: AccountRepositoryOperation,
    ref: RowRef,
  ): Promise<{ index: number; row: StorePoolRow }> {
    const rows = await this.readRows(operation)
    const index = rows.findIndex((row) => row.id === ref.id)
    const row = rows[index]
    if (row === undefined) {
      throw refusal(operation, 'unknown-row', `no row ${ref.id} in the pool`, {
        rowId: ref.id,
      })
    }
    return { index, row }
  }

  // ---- reads -------------------------------------------------------------

  read(): Promise<AccountRepositoryRead> {
    return this.run('read', undefined, async () => {
      let generation: string
      try {
        generation = await this.bindGeneration('read')
      } catch (error) {
        if (!(error instanceof AccountRepositoryError)) throw error
        return error.failure.kind === 'pending-migration'
          ? { status: 'pending-migration' }
          : { status: 'error', file: 'config', reason: error.failure.message }
      }
      const load = await this.store.read()
      if (load.status === 'pending-migration')
        return { status: 'pending-migration' }
      if (load.status === 'error') {
        return { status: 'error', file: load.file, reason: load.reason }
      }
      const settingsRead = await this.store.readSettings()
      if (settingsRead.status === 'error') {
        return {
          status: 'error',
          file: settingsRead.file,
          reason: settingsRead.reason,
        }
      }
      const settings = settingsRead.settings
      const mismatch = generationMismatch(settings, generation, this.paths)
      if (mismatch !== undefined) {
        return { status: 'error', file: 'settings', reason: mismatch }
      }
      let routing: RoutingSettings | undefined
      try {
        const management = settings[MANAGEMENT_SETTINGS_KEY]
        if (management !== undefined) {
          return {
            status: 'management-pending',
            management: publicManagementRecord(
              decodeManagementRecord(management),
            ),
          }
        }
        const rawRouting = settings[ROUTING_SETTINGS_KEY]
        routing =
          rawRouting === undefined
            ? undefined
            : decodeRoutingSettings(rawRouting)
      } catch (error) {
        if (error instanceof AccountCodecError) {
          return { status: 'error', file: 'settings', reason: error.message }
        }
        throw error
      }
      return {
        status: 'ready',
        rows: load.rows.map((row, index) => toAccountRow(row, index)),
        ...(routing !== undefined ? { routing } : {}),
      }
    })
  }

  settled(): Promise<void> {
    return this.store.pullsSettled()
  }

  // ---- credentials ------------------------------------------------------

  login(input: AccountLoginInput): Promise<AccountLoginResult> {
    return this.run('login', input.id, () =>
      this.withTopology('login', async (lease) => {
        await this.admit('login', input.id)
        return this.addLogin(input, lease)
      }),
    )
  }

  /**
   * Matches a login to the pool (exact email first, then the secret) and
   * adds it. An email match holding another secret is a re-authentication,
   * which needs the caller's expected ref (`replaceCredential`); a secret
   * held by a row recorded for another email is a contradiction. Both refuse
   * before anything is written.
   */
  private async addLogin(
    input: AccountLoginInput,
    lease: AccountLease,
  ): Promise<AccountLoginResult> {
    if (!input.refreshToken.trim()) {
      throw refusal('login', 'invalid-input', 'a login needs a refresh token', {
        rowId: input.id,
      })
    }
    const rows = await this.readRows('login')
    const secretRow = rows.find(
      (row) =>
        row.credential?.type === 'oauth' &&
        row.credential.refresh === input.refreshToken,
    )
    const email = input.metadata.email
    if (typeof email === 'string') {
      const emailRows = rows.filter(
        (row) => metadataOfStored(row.providerState)?.email === email,
      )
      const other = emailRows.find((row) => row !== secretRow)
      if (other !== undefined) {
        throw refusal(
          'login',
          'duplicate-identity',
          `row ${other.id} already holds this account; re-authenticate it with its ref instead of adding a second row`,
          { rowId: other.id },
        )
      }
      const secretEmail =
        secretRow === undefined
          ? undefined
          : metadataOfStored(secretRow.providerState)?.email
      if (typeof secretEmail === 'string' && secretEmail !== email) {
        throw refusal(
          'login',
          'duplicate-secret',
          `row ${secretRow?.id} holds this credential for another account`,
          { ...(secretRow !== undefined ? { rowId: secretRow.id } : {}) },
        )
      }
    }
    await lease.assertOwned()
    const added = await this.store.add({
      id: input.id,
      credential: { type: 'oauth', refresh: input.refreshToken },
      ...(input.identity !== undefined ? { identity: input.identity } : {}),
      providerState: encodeProviderState({
        schemaVersion: PROVIDER_STATE_SCHEMA_VERSION,
        metadata: input.metadata,
      }),
    })
    const row = (await this.readRows('login')).find((r) => r.id === added.id)
    if (row === undefined) {
      throw refusal(
        'login',
        'unknown-row',
        `row ${added.id} was removed right after the login`,
        {
          rowId: added.id,
          retryable: true,
        },
      )
    }
    return { ref: rowRefOf(row), outcome: added.outcome }
  }

  replaceCredential(
    expected: RowRef,
    input: AccountReplaceInput,
  ): Promise<{ ref: RowRef }> {
    return this.run('replaceCredential', expected.id, () =>
      this.withTopology('replaceCredential', async (lease) => {
        await this.admit('replaceCredential', expected.id)
        if (!input.refreshToken.trim()) {
          throw refusal(
            'replaceCredential',
            'invalid-input',
            'a replacement needs a refresh token',
            {
              rowId: expected.id,
            },
          )
        }
        // `expected` names the row id, epoch and recorded identity (absence
        // included). As its attribution, the store compares it with the row
        // read under its locks before it completes an interrupted replace,
        // writes anything, or calls `onReplace`. The prior identity the store
        // then hands `onReplace` only decides which metadata is retained.
        await lease.assertOwned()
        const replaced = await this.store.replace(
          expected.id,
          { type: 'oauth', refresh: input.refreshToken },
          {
            ...(input.identity !== undefined
              ? { identity: input.identity }
              : {}),
            ...(input.metadata !== undefined
              ? {
                  providerState: encodeProviderState({
                    schemaVersion: PROVIDER_STATE_SCHEMA_VERSION,
                    metadata: input.metadata,
                  }),
                }
              : {}),
          },
          { attribution: credentialFenceOf(expected) },
        )
        const ref: RowRef =
          input.identity === undefined
            ? { id: replaced.id, credentialEpoch: replaced.credentialEpoch }
            : {
                id: replaced.id,
                credentialEpoch: replaced.credentialEpoch,
                identity: input.identity,
              }
        if (input.disabled === 'enable') {
          try {
            await lease.assertOwned()
            await this.store.enable(ref.id, {
              attribution: credentialFenceOf(ref),
              providerState: (current, row) =>
                this.withEnabledEncoding(
                  'replaceCredential',
                  current,
                  row,
                  true,
                ),
            })
          } catch (error) {
            // The new credential is stored either way, so the caller still
            // gets its ref; the failed enable is reported by `flush`.
            this.failures.push(
              this.failureOf('replaceCredential', ref.id, error).failure,
            )
          }
        }
        return { ref }
      }),
    )
  }

  refresh(
    ref: RowRef,
    options?: AccountRefreshOptions,
  ): Promise<AccountRefreshOutcome> {
    // Concurrent refreshes of one credential in this process share one
    // exchange; other processes wait on the per-account provider lock.
    const key = rowRefKey(ref)
    const pending = this.refreshes.get(key)
    if (pending !== undefined) return pending
    const work = this.run('refresh', ref.id, () =>
      this.refreshOnce(ref, options),
    )
    this.refreshes.set(key, work)
    const forget = () => {
      if (this.refreshes.get(key) === work) this.refreshes.delete(key)
    }
    work.then(forget, forget)
    return work
  }

  private async refreshOnce(
    ref: RowRef,
    options: AccountRefreshOptions | undefined,
  ): Promise<AccountRefreshOutcome> {
    await this.admit('refresh', ref.id)
    const { index } = await this.accountRowFor('refresh', ref)
    let stale: string | undefined
    // The store calls this before taking its locks, on the locked re-read
    // and at commit. A row that no longer holds `ref` refuses the refresh
    // there, so no successor token is written to a replaced or re-added row.
    const refuse = async (row: StorePoolRow) => {
      const mismatch = refMismatchReason(row, ref)
      if (mismatch !== undefined) {
        stale = mismatch
        return mismatch
      }
      return options?.refuse?.(toAccountRow(row, index))
    }
    const outcome = await this.store.refresh(
      ref.id,
      async (credential, row) => {
        const result = await this.exchange({
          refreshToken: credential.refresh,
          row: toAccountRow(row, index),
        })
        const providerState =
          result.metadata === undefined
            ? undefined
            : this.refreshedState(row, result.metadata)
        return {
          access: result.accessToken,
          refresh: result.refreshToken,
          expires: result.expiresAt,
          ...(result.identity !== undefined
            ? { identity: result.identity }
            : {}),
          ...(providerState !== undefined ? { providerState } : {}),
        }
      },
      {
        providerLock: refreshProviderLock(this.paths.statePath, ref),
        refuse,
      },
    )
    switch (outcome.status) {
      case 'rotated': {
        const credential = outcome.credential
        if (
          credential.type !== 'oauth' ||
          credential.access === undefined ||
          credential.expires === undefined
        ) {
          throw refusal(
            'refresh',
            'unexpected',
            `row ${ref.id} committed a refresh without an access token`,
            {
              rowId: ref.id,
              ambiguous: true,
            },
          )
        }
        const identity = outcome.identity ?? ref.identity
        return {
          status: 'rotated',
          ref:
            identity === undefined
              ? { id: ref.id, credentialEpoch: ref.credentialEpoch }
              : { id: ref.id, credentialEpoch: ref.credentialEpoch, identity },
          accessToken: credential.access,
          expiresAt: credential.expires,
        }
      }
      case 'identity-contradicted':
        return {
          status: 'identity-contradicted',
          ref,
          expectedIdentity: outcome.expectedIdentity,
          returnedIdentity: outcome.returnedIdentity,
        }
      case 'refused':
        if (stale !== undefined && outcome.reason === stale) {
          throw refusal('refresh', 'attribution', stale, {
            rowId: ref.id,
            retryable: true,
          })
        }
        return { status: 'refused', ref, reason: outcome.reason }
    }
  }

  /**
   * The provider state a refresh brings: the metadata read under the row
   * lock with the fields the exchange reported laid over it. At commit the
   * store merges it with the value on disk (`ACCOUNT_STATE_POLICY.merge`),
   * which keeps the stored `addedAt` and `dailyRequestCounts`, the later
   * `lastUsed` and the later reset time of each rate limit.
   */
  private refreshedState(
    row: StorePoolRow,
    learnt: Partial<ProviderMetadata>,
  ): JsonObject | undefined {
    // `providerStateDropped`: the store keeps metadata this reader is not
    // shown. Leave it intact rather than rebuild it from incomplete fields;
    // the token refresh itself still goes ahead.
    if (row.providerStateDropped !== undefined) return undefined
    const envelope = envelopeOf(row.providerState)
    const metadata: ProviderMetadata = {
      ...metadataOrBase(envelope, row, this.now()),
    }
    for (const [key, value] of Object.entries(learnt)) {
      if (value !== undefined) Object.assign(metadata, { [key]: value })
    }
    return encodeEnvelope(envelope, metadata)
  }

  recordIdentity(ref: RowRef, identity: string): Promise<{ ref: RowRef }> {
    return this.run('recordIdentity', ref.id, async () => {
      await this.admit('recordIdentity', ref.id)
      await this.store.recordIdentity(ref.id, identity, {
        credentialEpoch: ref.credentialEpoch,
      })
      return {
        ref: { id: ref.id, credentialEpoch: ref.credentialEpoch, identity },
      }
    })
  }

  // ---- enabled flag and access -------------------------------------------

  /**
   * The row's metadata with `enabled` recording the flag an enable or
   * disable sets, written with that change; a row with no metadata keeps none.
   */
  private withEnabledEncoding(
    operation: AccountRepositoryOperation,
    current: unknown,
    row: StorePoolRow,
    enabled: boolean,
  ): unknown {
    const envelope = shownEnvelope(operation, current, row)
    if (envelope === undefined) return undefined
    return encodeEnvelope(envelope, { ...envelope.metadata, enabled })
  }

  setEnabled(
    ref: RowRef,
    input: AccountEnableInput,
  ): Promise<AccountTransitionResult> {
    return this.run('setEnabled', ref.id, async () => {
      await this.admit('setEnabled', ref.id)
      const { index, row: seen } = await this.accountRowFor('setEnabled', ref)
      const mutator: StoreStateMutator = async (current, row) => {
        const envelope = shownEnvelope('setEnabled', current, row)
        if (
          input.enabled &&
          input.actor === 'user' &&
          envelope?.metadata.accountIneligible === true
        ) {
          throw new CallbackRefusal(
            refusal(
              'setEnabled',
              'account-ineligible',
              `row ${ref.id} is marked ineligible; a user enable is refused`,
              {
                rowId: ref.id,
              },
            ),
          )
        }
        const transition: MetadataTransition = input.metadata
          ? await input.metadata(envelope?.metadata, toAccountRow(row, index))
          : { kind: 'keep' }
        if (transition.kind === 'decline') return this.decline
        if (transition.kind === 'clear') return undefined
        const metadata =
          transition.kind === 'set' ? transition.metadata : envelope?.metadata
        if (metadata === undefined) return undefined
        return encodeEnvelope(envelope, { ...metadata, enabled: input.enabled })
      }
      // With `providerStateDropped`, only the attributed enabled flag is
      // switched and the hidden metadata is kept as stored. A requested
      // metadata change on such a row is refused under the lock.
      const options =
        seen.providerStateDropped !== undefined && input.metadata === undefined
          ? { attribution: credentialFenceOf(ref) }
          : { attribution: credentialFenceOf(ref), providerState: mutator }
      const result = input.enabled
        ? await this.store.enable(ref.id, options)
        : await this.store.disable(
            ref.id,
            input.reason ??
              (input.actor === 'user' ? 'disabled-by-user' : 'disabled'),
            options,
          )
      return this.transitionResult(ref, result)
    })
  }

  private transitionResult(
    ref: RowRef,
    result: StoreTransitionResult,
  ): AccountTransitionResult {
    if (result.declined) return { ref, declined: true }
    const metadata = metadataOfStored(result.providerState)
    return {
      ref,
      ...(result.providerStateOutcome !== undefined
        ? { metadataOutcome: result.providerStateOutcome }
        : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    }
  }

  recordAccessVerdict(
    ref: RowRef,
    verdict: AccessVerdict,
  ): Promise<AccountTransitionResult> {
    return this.run('recordAccessVerdict', ref.id, async () => {
      await this.admit('recordAccessVerdict', ref.id)
      const fence = credentialFenceOf(ref)
      // The enabled flag and the access metadata land in one attributed
      // transition. The mutator compares the verdict's observation time with
      // the evidence times read under the lock and declines older evidence.
      const plan = (current: unknown, row: StorePoolRow) => {
        const envelope = shownEnvelope('recordAccessVerdict', current, row)
        const applied = applyAccessVerdict(
          metadataOrBase(envelope, row, this.now()),
          verdict,
        )
        return { envelope, applied }
      }
      if (verdict.kind !== 'cleared') {
        const result = await this.store.disable(
          ref.id,
          verdict.kind === 'ineligible'
            ? 'account-ineligible'
            : 'verification-required',
          {
            attribution: fence,
            providerState: (current, row) => {
              const { envelope, applied } = plan(current, row)
              if (applied === undefined) return this.decline
              return encodeEnvelope(envelope, {
                ...applied.metadata,
                enabled: false,
              })
            },
          },
        )
        return this.transitionResult(ref, result)
      }
      if (verdict.enable) {
        const result = await this.store.enable(ref.id, {
          attribution: fence,
          providerState: (current, row) => {
            const { envelope, applied } = plan(current, row)
            if (applied === undefined || applied.transition !== 'enable') {
              return this.decline
            }
            return encodeEnvelope(envelope, {
              ...applied.metadata,
              enabled: true,
            })
          },
        })
        if (!result.declined) return this.transitionResult(ref, result)
      }
      // Clearing verification or ineligibility without re-enabling the
      // account (or when nothing was blocked): only the metadata changes.
      let stale = false
      const result = await this.store.updateProviderState(
        ref.id,
        fence,
        (current, row) => {
          const { envelope, applied } = plan(current, row)
          if (applied === undefined) {
            stale = true
            return current
          }
          return encodeEnvelope(envelope, applied.metadata)
        },
      )
      if (stale) return { ref, declined: true }
      const metadata = metadataOfStored(result.providerState)
      return {
        ref,
        metadataOutcome: result.outcome,
        ...(metadata !== undefined ? { metadata } : {}),
      }
    })
  }

  // ---- metadata ----------------------------------------------------------

  updateMetadata(
    ref: RowRef,
    mutator: MetadataMutator,
  ): Promise<AccountMetadataResult> {
    return this.run('updateMetadata', ref.id, async () => {
      await this.admit('updateMetadata', ref.id)
      const { index } = await this.accountRowFor('updateMetadata', ref)
      const result = await this.store.updateProviderState(
        ref.id,
        credentialFenceOf(ref),
        async (current, row) => {
          const envelope = shownEnvelope('updateMetadata', current, row)
          const update = await mutator(
            envelope?.metadata,
            toAccountRow(row, index),
          )
          if (update.kind === 'keep') return current
          if (update.kind === 'clear') return undefined
          return encodeEnvelope(envelope, update.metadata)
        },
      )
      return this.metadataResult(ref, result)
    })
  }

  private metadataResult(
    ref: RowRef,
    result: {
      providerState?: unknown
      outcome: 'updated' | 'cleared' | 'unchanged'
    },
  ): AccountMetadataResult {
    const metadata = metadataOfStored(result.providerState)
    return {
      ref,
      outcome: result.outcome,
      ...(metadata !== undefined ? { metadata } : {}),
    }
  }

  /**
   * One fenced metadata write: `apply` receives the metadata read under the
   * row lock, or `metadataOrBase`'s starting value for a row with none, and
   * returns the next metadata.
   */
  private applyToMetadata(
    operation: AccountRepositoryOperation,
    ref: RowRef,
    apply: (metadata: ProviderMetadata) => ProviderMetadata,
  ): Promise<AccountMetadataResult> {
    return this.run(operation, ref.id, async () => {
      await this.admit(operation, ref.id)
      const result = await this.store.updateProviderState(
        ref.id,
        credentialFenceOf(ref),
        (current, row) => {
          const envelope = shownEnvelope(operation, current, row)
          const before = metadataOrBase(envelope, row, this.now())
          const after = apply(before)
          return after === before && envelope !== undefined
            ? current
            : encodeEnvelope(envelope, after)
        },
      )
      return this.metadataResult(ref, result)
    })
  }

  recordProject(ref: RowRef, observation: ProjectObservation) {
    return this.applyToMetadata('recordProject', ref, (m) =>
      applyProjectObservation(m, observation),
    )
  }

  recordFingerprint(ref: RowRef, observation: FingerprintObservation) {
    return this.applyToMetadata('recordFingerprint', ref, (m) =>
      applyFingerprintObservation(m, observation),
    )
  }

  recordTier(ref: RowRef, observation: TierObservation) {
    return this.applyToMetadata('recordTier', ref, (m) =>
      applyTierObservation(m, observation),
    )
  }

  recordCooldown(ref: RowRef, observation: CooldownObservation) {
    return this.applyToMetadata('recordCooldown', ref, (m) =>
      applyCooldownObservation(m, observation),
    )
  }

  recordRateLimits(ref: RowRef, resets: Readonly<StoredRateLimitResetTimes>) {
    return this.applyToMetadata('recordRateLimits', ref, (m) =>
      applyRateLimitObservation(m, resets),
    )
  }

  recordSwitch(ref: RowRef, reason: LastSwitchReason) {
    return this.applyToMetadata('recordSwitch', ref, (m) =>
      applySwitch(m, reason),
    )
  }

  recordUsage(
    ref: RowRef,
    observation: UsageObservation,
  ): Promise<AccountUsageResult> {
    return this.run('recordUsage', ref.id, async () => {
      await this.admit('recordUsage', ref.id)
      let result: { providerState?: unknown }
      try {
        // `dailyRequestCounts` and `lastUsed` are computed from the value read
        // under the row lock, so concurrent increments from any process add up.
        result = await this.store.updateProviderState(
          ref.id,
          credentialFenceOf(ref),
          (current, row) => {
            const envelope = shownEnvelope('recordUsage', current, row)
            return encodeEnvelope(
              envelope,
              applyUsage(
                metadataOrBase(envelope, row, this.now()),
                observation,
                this.now(),
              ),
            )
          },
        )
      } catch (error) {
        const failure = this.failureOf('recordUsage', ref.id, error)
        // An increment whose landing is unknown is never retried: a retry
        // could count the request twice.
        throw new AccountRepositoryError(
          {
            ...failure.failure,
            retryable: failure.failure.ambiguous
              ? false
              : failure.failure.retryable,
          },
          { cause: error },
        )
      }
      const metadata = metadataOfStored(result.providerState)
      if (metadata?.dailyRequestCounts == null) {
        throw refusal(
          'recordUsage',
          'unexpected',
          `row ${ref.id} shows no request counts after the increment`,
          {
            rowId: ref.id,
            ambiguous: true,
          },
        )
      }
      return {
        ref,
        lastUsed: metadata.lastUsed,
        dailyRequestCounts: metadata.dailyRequestCounts,
      }
    })
  }

  recordQuota(ref: RowRef, observation: QuotaState): Promise<void> {
    return this.run('recordQuota', ref.id, async () => {
      await this.admit('recordQuota', ref.id)
      let encoded: JsonObject
      try {
        encoded = encodeQuotaState(observation)
      } catch (error) {
        throw refusal(
          'recordQuota',
          'invalid-quota',
          error instanceof Error ? error.message : 'invalid quota',
          {
            rowId: ref.id,
          },
        )
      }
      await this.store.recordQuota(ref.id, credentialFenceOf(ref), encoded)
    })
  }

  // ---- selection and roster ---------------------------------------------

  selectAccount(target: RoutingTarget, row: RowRef | null): Promise<void> {
    return this.run('selectAccount', row?.id, async () => {
      await this.admit('selectAccount', row?.id)
      await this.store.updateSettings((settings) => {
        const raw = settings[ROUTING_SETTINGS_KEY]
        const routing: RoutingSettings =
          raw === undefined
            ? { schemaVersion: ROUTING_SETTINGS_SCHEMA_VERSION }
            : decodeRoutingSettings(raw)
        if (target === 'active') {
          routing.activeRow = row
        } else {
          routing.activeRowByFamily = {
            ...(routing.activeRowByFamily ?? {}),
            [target]: row,
          }
        }
        return {
          ...settings,
          [ROUTING_SETTINGS_KEY]: encodeRoutingSettings(routing),
        }
      }, {})
    })
  }

  reorder(ids: readonly string[]): Promise<void> {
    return this.run('reorder', undefined, async () => {
      await this.admit('reorder')
      await this.store.reorder(ids)
    })
  }

  remove(ref: RowRef): Promise<void> {
    return this.run('remove', ref.id, async () => {
      await this.admit('remove', ref.id)
      await this.store.remove(ref.id, {
        // Runs under every lock before anything is written. A pending
        // management record refuses the removal, since that operation owns
        // the pool's rows until it finishes; a row that no longer holds
        // `ref` refuses it as stale.
        protect: (_id, view) => {
          if (view.config[MANAGEMENT_SETTINGS_KEY] !== undefined) {
            throw new CallbackRefusal(
              refusal(
                'remove',
                'management-pending',
                'a management operation of the pool is pending',
                {
                  rowId: ref.id,
                  retryable: true,
                },
              ),
            )
          }
          // Only a state entry left by an interrupted removal: finishing it
          // writes nothing that could belong to a newer credential.
          if (view.row === undefined) return undefined
          const mismatch = refMismatchReason(view.row, ref)
          if (mismatch !== undefined) {
            throw new CallbackRefusal(
              refusal('remove', 'attribution', mismatch, {
                rowId: ref.id,
                retryable: true,
              }),
            )
          }
          return undefined
        },
      })
    })
  }

  // ---- management --------------------------------------------------------

  clear(): Promise<ManagementReceipt> {
    return this.run('clear', undefined, () =>
      this.withTopology('clear', async (lease) => {
        await this.boundSettings('clear')
        let record = await this.readManagement('clear')
        if (record !== undefined && record.kind !== 'clear') {
          throw refusal(
            'clear',
            'management-pending',
            `a ${record.kind} of the account pool is pending`,
            {
              retryable: true,
            },
          )
        }
        if (record === undefined) {
          const rows = await this.readRows('clear')
          record = await this.startManagement(
            'clear',
            {
              id: randomUUID(),
              kind: 'clear',
              targets: rows.map((row) => row.id),
              progress: { step: 'remove', completedTargets: [] },
            },
            lease,
          )
        }
        return this.continueManagement(
          'clear',
          record,
          async (current) => this.removeTargets('clear', current, lease),
          lease,
        )
      }),
    )
  }

  replacePool(
    inputs: readonly AccountLoginInput[],
  ): Promise<ManagementReceipt> {
    return this.run('replacePool', undefined, () =>
      this.withTopology('replacePool', async (lease) => {
        this.checkPoolInputs(inputs)
        const inputDigest = replacementInputDigest(inputs)
        const inputIds = inputs.map((input) => input.id)
        await this.boundSettings('replacePool')
        let record = await this.readManagement('replacePool')
        if (record !== undefined) {
          if (record.kind !== 'replace-pool') {
            throw refusal(
              'replacePool',
              'management-pending',
              `a ${record.kind} of the account pool is pending`,
              {
                retryable: true,
              },
            )
          }
          // A pending replacement resumes only for the inputs it was started
          // with; anything else would mix two replacements.
          if (record.inputDigest !== inputDigest) {
            throw refusal(
              'replacePool',
              'management-pending',
              'another pool replacement is pending',
              {
                retryable: true,
              },
            )
          }
        } else {
          const rows = await this.readRows('replacePool')
          // A replacement adds new rows. An input naming a row the pool
          // already holds is refused here, before anything is written: the
          // store does not re-add an id removed in this process, so removing
          // that row first would strand the pool without it.
          const held = new Set(rows.map((row) => row.id))
          const reused = inputs.find((input) => held.has(input.id))
          if (reused !== undefined) {
            throw refusal(
              'replacePool',
              'invalid-input',
              `input ${reused.id} names a row the pool already holds; a replacement adds new rows`,
              { rowId: reused.id },
            )
          }
          const id = randomUUID()
          // The inputs reach their private file before the record names it,
          // so a record that still needs its inputs always has them.
          await lease.assertOwned()
          await this.writeTransfer(id, inputs)
          record = await this.startManagement(
            'replacePool',
            {
              id,
              kind: 'replace-pool',
              targets: rows.map((row) => row.id),
              progress: { step: 'remove', completedTargets: [] },
              inputDigest,
            },
            lease,
          )
        }
        return this.continueManagement(
          'replacePool',
          record,
          async (current) => {
            let next = current
            if (next.progress.step !== 'verified') {
              if (next.progress.step === 'remove') {
                next = await this.removeTargets('replacePool', next, lease)
                next = await this.saveProgress(
                  'replacePool',
                  next,
                  'add',
                  [],
                  lease,
                )
              }
              // Before `verified` the transfer file must exist and hold exactly
              // the inputs the record was started with; a missing file fails
              // here and leaves the record pending.
              const pending = await this.readTransfer(next.id)
              if (replacementInputDigest(pending) !== next.inputDigest) {
                throw new AccountCodecError(
                  'transfer',
                  'does not hold the inputs this replacement was started with',
                )
              }
              if (
                next.progress.completedTargets.some(
                  (id) => !inputIds.includes(id),
                )
              ) {
                throw new AccountCodecError(
                  '$.progress.completedTargets',
                  'must name only inputs of the transfer file while they are added',
                )
              }
              for (const input of pending) {
                if (next.progress.completedTargets.includes(input.id)) continue
                // Adding again after a crash is safe: the store returns the row
                // already holding the secret.
                await this.addLogin(input, lease)
                next = await this.saveProgress(
                  'replacePool',
                  next,
                  'add',
                  [...next.progress.completedTargets, input.id],
                  lease,
                )
              }
              await this.verifyPool(pending)
              // `verified` is written before the inputs are deleted, so a resume
              // never needs inputs that are gone.
              next = await this.saveProgress(
                'replacePool',
                next,
                'verified',
                inputIds,
                lease,
              )
            } else {
              // Resuming after `verified`: the inputs matched the record's
              // digest above, and the pool must still hold them.
              if (
                next.progress.completedTargets.length !== inputIds.length ||
                next.progress.completedTargets.some(
                  (id, i) => id !== inputIds[i],
                )
              ) {
                throw new AccountCodecError(
                  '$.progress.completedTargets',
                  'must name the inputs once the replacement is verified',
                )
              }
              await this.verifyPool(inputs)
            }
            // Only a verified replacement deletes its transfer file; one already
            // deleted by an interrupted earlier attempt is not an error here.
            await lease.assertOwned()
            await this.discardTransfer(next.id)
            return next
          },
          lease,
        )
      }),
    )
  }

  private checkPoolInputs(inputs: readonly AccountLoginInput[]): void {
    const ids = new Set<string>()
    const secrets = new Set<string>()
    for (const input of inputs) {
      if (!input.refreshToken.trim() || ids.has(input.id)) {
        throw refusal(
          'replacePool',
          'invalid-input',
          'every input needs a refresh token and its own id',
        )
      }
      if (secrets.has(input.refreshToken)) {
        throw refusal(
          'replacePool',
          'duplicate-secret',
          'two inputs hold the same credential',
        )
      }
      ids.add(input.id)
      secrets.add(input.refreshToken)
    }
  }

  private async startManagement(
    operation: AccountRepositoryOperation,
    record: StoredManagementRecord,
    lease: AccountLease,
  ): Promise<StoredManagementRecord> {
    await lease.assertOwned()
    await this.store.updateSettings(
      (settings) => {
        if (settings[MANAGEMENT_SETTINGS_KEY] !== undefined) {
          throw new CallbackRefusal(
            refusal(
              operation,
              'management-pending',
              'another management operation started first',
              {
                retryable: true,
              },
            ),
          )
        }
        return {
          ...settings,
          [MANAGEMENT_SETTINGS_KEY]: encodeManagementRecord(record),
        }
      },
      { extraLocks: [managementLock(this.paths)] },
    )
    return record
  }

  private ownsManagement(
    settings: Readonly<Record<string, unknown>>,
    record: StoredManagementRecord,
  ): boolean {
    const raw = settings[MANAGEMENT_SETTINGS_KEY]
    if (raw === undefined) return false
    try {
      return decodeManagementRecord(raw).id === record.id
    } catch {
      return false
    }
  }

  private async saveProgress(
    operation: AccountRepositoryOperation,
    record: StoredManagementRecord,
    step: string,
    completedTargets: readonly string[],
    lease: AccountLease,
  ): Promise<StoredManagementRecord> {
    const next: StoredManagementRecord = {
      ...record,
      progress: { step, completedTargets },
    }
    await lease.assertOwned()
    await this.store.updateSettings(
      (settings) => {
        if (!this.ownsManagement(settings, record)) {
          throw new CallbackRefusal(
            refusal(
              operation,
              'management-pending',
              'the management record changed under this operation',
            ),
          )
        }
        return {
          ...settings,
          [MANAGEMENT_SETTINGS_KEY]: encodeManagementRecord(next),
        }
      },
      { extraLocks: [managementLock(this.paths)] },
    )
    return next
  }

  private async removeTargets(
    operation: AccountRepositoryOperation,
    record: StoredManagementRecord,
    lease: AccountLease,
  ): Promise<StoredManagementRecord> {
    let next = record
    for (const target of record.targets) {
      if (next.progress.completedTargets.includes(target)) continue
      await lease.assertOwned()
      try {
        await this.store.remove(target, {
          extraLocks: [managementLock(this.paths)],
          protect: (_id, view) =>
            this.ownsManagement(view.config, record)
              ? undefined
              : 'the management record changed under this removal',
        })
      } catch (error) {
        const failure = this.failureOf(operation, target, error)
        if (failure.failure.kind !== 'unknown-row') throw failure
      }
      next = await this.saveProgress(
        operation,
        next,
        next.progress.step,
        [...next.progress.completedTargets, target],
        lease,
      )
    }
    return next
  }

  /**
   * Runs a management operation's remaining steps, then drops its record.
   * A retryable failure (lock contention, a lost lease) leaves the record
   * pending and reports it instead of looping; the next call resumes.
   */
  private async continueManagement(
    operation: AccountRepositoryOperation,
    record: StoredManagementRecord,
    steps: (record: StoredManagementRecord) => Promise<StoredManagementRecord>,
    lease: AccountLease,
  ): Promise<ManagementReceipt> {
    let finished: StoredManagementRecord
    try {
      finished = await steps(record)
      // The journal clear is the write that makes the operation complete;
      // with the lease lost before it, the operation stays pending. Under
      // the store's locks, a journal that no longer holds this record (it is
      // gone, or names another operation) refuses the clear: nothing is
      // written, and the operation is not reported completed.
      await lease.assertOwned()
      await this.store.updateSettings(
        (settings) => {
          if (!this.ownsManagement(settings, record)) {
            throw new CallbackRefusal(
              refusal(
                operation,
                'management-pending',
                'the management journal no longer holds this operation; it was not cleared',
              ),
            )
          }
          const { [MANAGEMENT_SETTINGS_KEY]: _done, ...rest } = settings
          return rest
        },
        { extraLocks: [managementLock(this.paths)] },
      )
    } catch (error) {
      const failure = this.failureOf(operation, undefined, error)
      if (failure.failure.retryable) {
        const now = (await this.readManagement(operation)) ?? record
        return { management: publicManagementRecord(now), outcome: 'pending' }
      }
      throw failure
    }
    return {
      management: publicManagementRecord(finished),
      outcome: 'completed',
    }
  }

  /**
   * Checks the pool a replacement leaves before the replacement is recorded
   * verified and its transfer file deleted. The pool must hold exactly the
   * inputs' rows, in input order, and each row must be valid and complete
   * (not invalid, not torn) with the input's id, its refresh token under a
   * bound stamp, its identity (absent only when the
   * input gives none), the metadata it requested and no quota reading. A
   * token present under another id, identity or metadata is not the input.
   * Any mismatch refuses, which leaves the journal and the transfer file in
   * place.
   */
  private async verifyPool(
    inputs: readonly AccountLoginInput[],
  ): Promise<void> {
    const rows = await this.readRows('replacePool')
    const mismatch = (input: AccountLoginInput, problem: string) =>
      refusal(
        'replacePool',
        'unexpected',
        `input ${input.id} ${problem} after the replacement`,
        { rowId: input.id },
      )
    for (const input of inputs) {
      const row = rows.find((candidate) => candidate.id === input.id)
      if (
        row === undefined ||
        row.invalid !== undefined ||
        row.torn === true ||
        row.credential?.type !== 'oauth' ||
        row.credential.refresh !== input.refreshToken ||
        row.stamp !== 'bound'
      ) {
        throw mismatch(input, 'is not in the pool')
      }
      if (row.identity !== input.identity) {
        throw mismatch(input, 'is recorded for another identity')
      }
      if (
        row.providerStateDropped !== undefined ||
        row.providerState === undefined ||
        canonicalJson(
          encodeProviderMetadata(
            decodeProviderState(row.providerState).metadata,
          ),
        ) !== canonicalJson(encodeProviderMetadata(input.metadata))
      ) {
        throw mismatch(input, 'does not hold its requested metadata')
      }
      if (row.quota !== undefined) {
        throw mismatch(input, 'holds a quota reading')
      }
    }
    if (
      rows.length !== inputs.length ||
      rows.some((row, index) => row.id !== inputs[index]?.id)
    ) {
      throw refusal(
        'replacePool',
        'unexpected',
        'the pool does not hold exactly the replacement inputs, in their order',
      )
    }
  }

  private transferPath(id: string): string {
    return join(this.paths.transfersDir, `${id}.json`)
  }

  private async writeTransfer(
    id: string,
    inputs: readonly AccountLoginInput[],
  ): Promise<void> {
    await mkdir(this.paths.transfersDir, { recursive: true, mode: 0o700 })
    const body: TransferFile = {
      schemaVersion: 1,
      managementId: id,
      inputs: inputs.map(encodeLoginInput),
    }
    // Exclusive and owner-only: the file holds refresh tokens.
    const handle = await open(this.transferPath(id), 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(body))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async readTransfer(id: string): Promise<AccountLoginInput[]> {
    const raw: unknown = JSON.parse(
      await readFile(this.transferPath(id), 'utf8'),
    )
    return decodeTransferFile(raw, id)
  }

  private async discardTransfer(id: string): Promise<void> {
    try {
      await unlink(this.transferPath(id))
    } catch (error) {
      if (!(isRecord(error) && error.code === 'ENOENT')) throw error
    }
  }

  // ---- draining ----------------------------------------------------------

  flush(): Promise<AccountFlushReport> {
    return this.drain()
  }

  private async drain(): Promise<AccountFlushReport> {
    // Work admitted while draining is drained too.
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
    const report = { completed: this.completed, failures: this.failures }
    this.completed = 0
    this.failures = []
    return report
  }

  async dispose(): Promise<AccountFlushReport> {
    this.closing = true
    return this.drain()
  }
}

/**
 * Binds the repository to the genuine public `./store` and `./fs` modules
 * of one common-auth package. The returned function is the frozen
 * `CreateAccountRepository`.
 */
export function createAccountRepositoryFactory(
  modules: AccountStoreModules,
  factoryOptions: AccountRepositoryFactoryOptions = {},
): CreateAccountRepository {
  return (options) =>
    new StoreAccountRepository(modules, options, factoryOptions)
}
