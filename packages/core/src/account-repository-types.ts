/**
 * Contract of the Antigravity account repository built on the common-auth
 * lease-backed pool store.
 *
 * The repository replaces whole-file snapshots of `antigravity-accounts.json`
 * with typed, attributed operations on individual rows. A row is addressed by
 * a `RowRef` (local id, credential epoch and recorded identity) rather than by
 * its position, because positions move under reorder/remove while a ref names
 * one credential lineage of one row: work started for a credential that has
 * since been replaced or removed is refused instead of landing on its
 * successor.
 *
 * Persisted data is split by owner:
 * - native roster/credential (N): bare refresh token, enabled flag, order;
 *   owned by the store itself.
 * - provider metadata (P): `ProviderStateEnvelope`, kept beside the
 *   credential in the state file. Its credential-bound part is covered by the
 *   store's credential stamp, so an edit by a writer that does not know the
 *   stamp hides the value instead of attaching it to the wrong account.
 * - quota (Q): `QuotaState`, kept in the config file's per-row entry.
 * - routing settings (G): `RoutingSettings`, a plugin settings key.
 *
 * Every shape below that carries `extensions` keeps JSON it does not
 * recognise there, so a file written by a newer build survives a read and
 * rewrite by this one. Optional fields distinguish absent (key missing) from
 * `null`; the codecs never collapse one into the other. Readers treat an
 * optional `null` like absent when they project the data for routing.
 *
 * Shapes that mirror common-auth 0.10.0 public declarations are structural
 * copies, so the repository can hand them to the embedded store without this
 * module depending on it at runtime.
 */

import type { AccountModelFamily, CooldownReason } from './account-types.ts'

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

// ---------------------------------------------------------------------------
// Store constants
// ---------------------------------------------------------------------------

/** Provider name the pool store is opened with; keys its provider-wide lock. */
export const ACCOUNT_STORE_PROVIDER = 'antigravity'

/** Schema version written inside the provider-state envelope (P). */
export const PROVIDER_STATE_SCHEMA_VERSION = 1
/** Schema version written inside the per-row quota value (Q). */
export const QUOTA_STATE_SCHEMA_VERSION = 1
/** Schema version written inside the routing settings value (G). */
export const ROUTING_SETTINGS_SCHEMA_VERSION = 1

/** Settings key holding `RoutingSettings`. */
export const ROUTING_SETTINGS_KEY = 'antigravityRouting'
/**
 * Settings key holding the `ManagementRecord` of a migration or a multi-row
 * destructive operation. Ordinary row operations never write it.
 */
export const MANAGEMENT_SETTINGS_KEY = 'antigravityManagement'
/** Lock name, at the config path, guarding `MANAGEMENT_SETTINGS_KEY`. */
export const MANAGEMENT_LOCK_NAME = 'antigravity-management'
/**
 * Prefix of the account-keyed provider lock a refresh holds across its token
 * exchange. It differs from the store's own `row-` lease name, so passing it
 * as the refresh `providerLock` can never wait on a lease the same refresh
 * already holds.
 */
export const REFRESH_PROVIDER_LOCK_PREFIX = 'agy-refresh-'
/** Lock name the legacy writers hold on `antigravity-accounts.json`. */
export const LEGACY_ACCOUNTS_LOCK_NAME = 'accounts'
/** Lease of the legacy accounts lock taken while importing from it. */
export const LEGACY_ACCOUNTS_LOCK_TTL_MS = 10_000

// ---------------------------------------------------------------------------
// Row addressing
// ---------------------------------------------------------------------------

/**
 * Names one credential lineage of one row. `credentialEpoch` is assigned by
 * the store: `add` and `replace` start a lineage, refresh and rotate keep it,
 * and an id that is removed and added again starts past every epoch it held,
 * in any process. `identity` is the recorded wire identity; leaving it out
 * means "the row had none", never "any identity".
 *
 * A row's index in the roster is presentation only and is never part of a
 * ref.
 */
export interface RowRef {
  readonly id: string
  readonly credentialEpoch: number
  readonly identity?: string
}

/** A lock as the store takes it (mirror of common-auth `PoolLockSpec`). */
export interface AccountLockSpec {
  readonly name: string
  readonly path: string
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly retryMs?: number
  readonly renew?: boolean
  readonly renewIntervalMs?: number
}

/**
 * The account-keyed provider lock a refresh of `row` holds across its token
 * exchange: distinct accounts refresh concurrently while two refreshes of one
 * account stay single-flight. Keyed like the store's row lock (recorded
 * identity, else local id) so it follows the account, and URI-encoded so any
 * identity is a safe lock-file name.
 */
export function refreshProviderLock(
  statePath: string,
  row: Pick<RowRef, 'id' | 'identity'>,
): AccountLockSpec {
  return {
    path: statePath,
    name:
      REFRESH_PROVIDER_LOCK_PREFIX + encodeURIComponent(row.identity ?? row.id),
  }
}

/**
 * The legacy accounts lock taken while capturing from or retiring the legacy
 * file. It is released before any store call so it never nests inside the
 * store's row → provider → extra → save lock order.
 */
export function legacyAccountsLock(legacyPath: string): AccountLockSpec {
  return {
    path: legacyPath,
    name: LEGACY_ACCOUNTS_LOCK_NAME,
    ttlMs: LEGACY_ACCOUNTS_LOCK_TTL_MS,
    renew: true,
  }
}

// ---------------------------------------------------------------------------
// Provider metadata (P)
// ---------------------------------------------------------------------------

export type LastSwitchReason = 'rate-limit' | 'initial' | 'rotation'
export type FingerprintHistoryReason = 'initial' | 'regenerated' | 'restored'

export interface StoredClientMetadata {
  ideType: string
  platform: string
  pluginType: string
  extensions?: JsonObject
}

export interface StoredFingerprint {
  deviceId: string
  sessionToken: string
  userAgent: string
  apiClient: string
  clientMetadata: StoredClientMetadata
  createdAt: number
  extensions?: JsonObject
}

export interface StoredFingerprintVersion {
  fingerprint: StoredFingerprint
  timestamp: number
  reason: FingerprintHistoryReason
  extensions?: JsonObject
}

export interface StoredDailyRequestCounts {
  /** Kept exactly as written; reading never resets an old date. */
  date: string
  claude: number
  gemini: number
  extensions?: JsonObject
}

/**
 * Every rate-limit reset the account carries, keyed by quota pool or model.
 * The well-known keys are `claude`, `gemini-antigravity` and `gemini-cli`;
 * every other key is kept as written.
 */
export type StoredRateLimitResetTimes = Record<string, number | null>

/**
 * Antigravity metadata kept beside a row's credential. It never holds a
 * credential. Fields marked bound are the credential-bound projection: they
 * describe the account the credential signs in to, so the store's stamp
 * covers them.
 */
export interface ProviderMetadata {
  /** Bound. Exact as received; never case-folded or inferred. */
  email?: string | null
  /** Bound. Kept bare here; packed only at host boundaries. */
  projectId?: string | null
  /** Bound. */
  managedProjectId?: string | null
  /** Original add time shown to the user; the store's own add time differs. */
  addedAt: number
  lastUsed: number
  /**
   * How the legacy file encoded the enabled flag (absent, true, false or
   * null). The effective flag is the row's native one, `value !== false`.
   */
  enabled?: boolean | null
  lastSwitchReason?: LastSwitchReason | null
  rateLimitResetTimes?: StoredRateLimitResetTimes | null
  coolingDownUntil?: number | null
  cooldownReason?: CooldownReason | null
  /** Display label; may hold personal data and must stay out of telemetry. */
  label?: string | null
  /** Bound. */
  fingerprint?: StoredFingerprint | null
  /** Bound. Ordered oldest first, kept untruncated. */
  fingerprintHistory?: StoredFingerprintVersion[] | null
  /** Bound. */
  verificationRequired?: boolean | null
  /** Bound. */
  verificationRequiredAt?: number | null
  /** Bound. */
  verificationRequiredReason?: string | null
  /** Bound. Validated where it is captured, kept here as written. */
  verificationUrl?: string | null
  /** Bound. `true` excludes the row from routing. */
  accountIneligible?: boolean | null
  /** Bound. */
  accountIneligibleAt?: number | null
  /** Bound. */
  accountIneligibleReason?: string | null
  /** Bound. */
  eligibilityStateUpdatedAt?: number | null
  /** Bound. Raw upstream tier id, never normalised. */
  capturedTierId?: string | null
  /** Bound. Raw; absence does not mean the account is paid. */
  capturedPaidTierId?: string | null
  /** Bound. */
  capturedTierAt?: number | null
  /** Bound. */
  capturedTierSchemaVersion?: number | null
  dailyRequestCounts?: StoredDailyRequestCounts | null
  extensions?: JsonObject
}

/** Names of the `ProviderMetadata` fields covered by the credential stamp. */
export const CREDENTIAL_BOUND_METADATA_FIELDS = [
  'email',
  'projectId',
  'managedProjectId',
  'fingerprint',
  'fingerprintHistory',
  'verificationRequired',
  'verificationRequiredAt',
  'verificationRequiredReason',
  'verificationUrl',
  'accountIneligible',
  'accountIneligibleAt',
  'accountIneligibleReason',
  'eligibilityStateUpdatedAt',
  'capturedTierId',
  'capturedPaidTierId',
  'capturedTierAt',
  'capturedTierSchemaVersion',
] as const satisfies readonly (keyof ProviderMetadata)[]

export type CredentialBoundMetadataField =
  (typeof CREDENTIAL_BOUND_METADATA_FIELDS)[number]

/**
 * The value stored under the state file's `commonAuthProviderState` for a
 * row. A newer `schemaVersion` is refused rather than reinterpreted.
 */
export interface ProviderStateEnvelope {
  schemaVersion: typeof PROVIDER_STATE_SCHEMA_VERSION
  metadata: ProviderMetadata
  extensions?: JsonObject
}

// ---------------------------------------------------------------------------
// Quota (Q)
// ---------------------------------------------------------------------------

export type QuotaWindowName = 'weekly' | '5h'

export interface StoredQuotaWindow {
  window: QuotaWindowName
  remainingFraction: number
  resetTime: string
  extensions?: JsonObject
}

export interface StoredQuotaGroup {
  /** Kept exactly as reported; never rounded. */
  remainingFraction?: number | null
  /** Raw upstream timestamp string. */
  resetTime?: string | null
  modelCount: number
  /** Ordered as reported. */
  windows?: StoredQuotaWindow[] | null
  extensions?: JsonObject
}

export interface StoredModelQuota {
  modelId: string
  displayName?: string | null
  /** Required key; `null` means the model belongs to no group. */
  group: string | null
  remainingFraction: number
  resetTime?: string | null
  extensions?: JsonObject
}

/**
 * The quota value stored in a row's config entry. Nothing in it authorises a
 * request: `cachedQuotaAccountId` only records which account produced the
 * reading.
 */
export interface QuotaState {
  schemaVersion: typeof QUOTA_STATE_SCHEMA_VERSION
  cachedQuotaAccountId?: string | null
  cachedQuota?: Record<string, StoredQuotaGroup> | null
  cachedPerModelQuota?: StoredModelQuota[] | null
  cachedQuotaUpdatedAt?: number | null
  extensions?: JsonObject
}

// ---------------------------------------------------------------------------
// Routing settings (G)
// ---------------------------------------------------------------------------

export interface StoredFamilyIndices {
  claude?: number | null
  gemini?: number | null
  extensions?: JsonObject
}

export interface StoredFamilyRows {
  claude?: RowRef | null
  gemini?: RowRef | null
  extensions?: JsonObject
}

/**
 * Account selection kept in the plugin settings. The index fields keep the
 * legacy encoding exactly (the effective index is clamped when read, as the
 * legacy loader did); the row fields name the selected rows independently per
 * family. A ref that no longer matches a row falls back to the legacy index
 * rules.
 */
export interface RoutingSettings {
  schemaVersion: typeof ROUTING_SETTINGS_SCHEMA_VERSION
  activeIndex?: number | null
  activeIndexByFamily?: StoredFamilyIndices | null
  activeRow?: RowRef | null
  activeRowByFamily?: StoredFamilyRows | null
  extensions?: JsonObject
}

// ---------------------------------------------------------------------------
// Codec contracts (structural mirrors of common-auth 0.10.0)
// ---------------------------------------------------------------------------

/** Mirror of common-auth `ProviderStateReplacement`. */
export interface ProviderStateReplacementInfo {
  id: string
  credentialEpoch: number
  identity?: string
  incoming?: unknown
}

/** Mirror of common-auth `ProviderStateCodec`. */
export interface ProviderStateCodecContract {
  validate(value: unknown): boolean
  credentialBound?(value: unknown): unknown
  merge?(onDisk: unknown, incoming: unknown): unknown
  onReplace?(
    previous: unknown | undefined,
    replacement: ProviderStateReplacementInfo,
  ): unknown | undefined
}

/** Mirror of common-auth `QuotaCodec`. */
export interface QuotaCodecContract {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

// ---------------------------------------------------------------------------
// Repository construction
// ---------------------------------------------------------------------------

/**
 * Files the repository owns. The legacy pool path (L) is read only by the
 * migration and retired by it; everything else lives in a private directory
 * beside it, so a legacy writer that still runs can never touch the
 * successor's credentials or epochs.
 */
export interface AccountStorePaths {
  /** The legacy v4 `antigravity-accounts.json`. */
  legacyPath: string
  /** `dirname(L)/<basename(L)>.store/` */
  storeDir: string
  configPath: string
  statePath: string
  migrationPath: string
  backupsDir: string
  retiredDir: string
  transfersDir: string
}

/** What the token exchange is handed: the bare refresh token and the row. */
export interface AccountTokenExchangeInput {
  refreshToken: string
  row: AccountRow
}

export interface AccountTokenExchangeResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** Wire identity the provider reported, when it reported one. */
  identity?: string
  /**
   * Metadata learnt with the new token. Present fields replace the stored
   * ones; omitted fields (projects included) are kept.
   */
  metadata?: Partial<ProviderMetadata>
}

/** Performs one OAuth refresh against the provider. */
export type AccountTokenExchange = (
  input: AccountTokenExchangeInput,
) => Promise<AccountTokenExchangeResult>

export interface AccountRepositoryOptions {
  paths: AccountStorePaths
  /** Clock for evidence times, usage dates and store leases. */
  now: () => number
  /** Token exchange used by `refresh`. */
  exchange: AccountTokenExchange
}

export type CreateAccountRepository = (
  options: AccountRepositoryOptions,
) => AccountRepository

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Mirror of common-auth `CredentialStampStatus`. */
export type AccountCredentialStamp =
  | 'none'
  | 'bound'
  | 'missing'
  | 'malformed'
  | 'mismatched'
  | 'legacy'

export interface AccountCredentialView {
  /** Bare refresh token; never packed with project ids here. */
  refreshToken: string
  accessToken?: string
  expiresAt?: number
}

/**
 * The provider metadata a row shows. `dropped` means the state file holds a
 * value the row does not show (another writer changed its bound part, or the
 * codec refuses it); callers treat that as an error to surface, never as an
 * empty value to regenerate.
 */
export type AccountMetadataView =
  | { status: 'present'; metadata: ProviderMetadata }
  | { status: 'absent' }
  | { status: 'dropped'; reason: 'uncovered' | 'invalid' }

export type AccountQuotaView =
  | { status: 'present'; quota: QuotaState }
  | { status: 'absent' }

export interface AccountRow {
  ref: RowRef
  /** Position in the roster; presentation only. */
  index: number
  /** Effective native flag. */
  enabled: boolean
  disabledReason?: string
  /** When the store admitted the row; not the user-visible add time. */
  storeAddedAt?: number
  credential?: AccountCredentialView
  /** May be refreshed, pulled for, or routed to. */
  usable: boolean
  stamp: AccountCredentialStamp
  torn?: true
  unbound?: true
  invalid?: 'roster' | 'entry'
  metadata: AccountMetadataView
  quota: AccountQuotaView
}

export type ManagementKind = 'migration' | 'clear' | 'replace-pool'

/**
 * A multi-row operation in progress. Admission refuses new work while one is
 * pending; work already admitted finishes. `targets` are row ids, and
 * `progress` names the last durable step, so a restarted process resumes
 * instead of repeating it.
 */
export interface ManagementRecord {
  id: string
  kind: ManagementKind
  targets: readonly string[]
  progress: {
    step: string
    completedTargets: readonly string[]
  }
}

export type AccountRepositoryRead =
  | {
      status: 'ready'
      rows: readonly AccountRow[]
      routing?: RoutingSettings
    }
  | { status: 'pending-migration' }
  | { status: 'management-pending'; management: ManagementRecord }
  | { status: 'error'; file: 'config' | 'state' | 'settings'; reason: string }

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * What a metadata mutator asks for. Clearing is explicit, so a mutator that
 * forgets to return a value never deletes the row's metadata.
 */
export type MetadataUpdate =
  | { kind: 'set'; metadata: ProviderMetadata }
  | { kind: 'keep' }
  | { kind: 'clear' }

/**
 * A transition mutator may also decline, for example when the metadata it is
 * shown records evidence newer than the evidence the caller acts on; nothing
 * is written, the enabled flag included.
 */
export type MetadataTransition = MetadataUpdate | { kind: 'decline' }

/**
 * Runs under the row and store locks with a private copy of the current
 * metadata (undefined when the row shows none). It must not call back into
 * the repository.
 */
export type MetadataMutator = (
  current: ProviderMetadata | undefined,
  row: AccountRow,
) => MetadataUpdate | Promise<MetadataUpdate>

export type MetadataTransitionMutator = (
  current: ProviderMetadata | undefined,
  row: AccountRow,
) => MetadataTransition | Promise<MetadataTransition>

export interface AccountLoginInput {
  /** A fresh UUID for a new row; the result names the row actually used. */
  id: string
  /** Bare refresh token. */
  refreshToken: string
  /** Authenticated wire identity, when the login established one. */
  identity?: string
  metadata: ProviderMetadata
}

export interface AccountLoginResult {
  /** Authoritative: an existing row's ref when the secret was already held. */
  ref: RowRef
  /**
   * `rotated` when the pool already held this secret: the retry keeps that
   * row's credential epoch.
   */
  outcome: 'added' | 'added-disabled' | 'completed' | 'rotated'
}

export interface AccountReplaceInput {
  refreshToken: string
  identity?: string
  metadata?: ProviderMetadata
  /**
   * Whether a disabled row stays disabled after the new credential lands.
   * OpenCode 1 keeps the user's choice; other hosts decide their own policy.
   */
  disabled: 'keep' | 'enable'
}

export interface AccountRotateInput {
  refreshToken: string
  accessToken?: string
  expiresAt?: number
  /** Present fields replace stored ones; omitted fields are kept. */
  metadata?: Partial<ProviderMetadata>
}

export type AccountRefreshOutcome =
  | {
      status: 'rotated'
      ref: RowRef
      accessToken: string
      expiresAt: number
    }
  | {
      /**
       * The provider answered for another account. The successor is kept,
       * disabled and bound to the expected identity, and no bearer is handed
       * out until a validated `replaceCredential`.
       */
      status: 'identity-contradicted'
      ref: RowRef
      expectedIdentity: string
      returnedIdentity: string
    }
  | { status: 'refused'; ref: RowRef; reason: string }

export interface AccountRefreshOptions {
  /** Checked before locking, after the locked re-read and at commit. */
  refuse?: (row: AccountRow) => string | undefined | Promise<string | undefined>
}

export interface AccountEnableInput {
  enabled: boolean
  /** Native disabled reason when disabling. */
  reason?: string
  /** A user enable refuses an ineligible account; a system one may not. */
  actor: 'user' | 'system'
  metadata?: MetadataTransitionMutator
}

/**
 * Evidence about account access, timestamped by when it was observed so a
 * late verdict cannot undo a newer one.
 */
export type AccessVerdict =
  | {
      kind: 'verification-required'
      observedAt: number
      reason?: string
      verificationUrl?: string
    }
  | { kind: 'ineligible'; observedAt: number; reason: string }
  | { kind: 'cleared'; observedAt: number; enable: boolean }

export interface AccountTransitionResult {
  ref: RowRef
  declined?: true
  metadataOutcome?: 'updated' | 'cleared' | 'unchanged'
  metadata?: ProviderMetadata
}

export interface AccountMetadataResult {
  ref: RowRef
  outcome: 'updated' | 'cleared' | 'unchanged'
  metadata?: ProviderMetadata
}

export interface ProjectObservation {
  projectId?: string | null
  managedProjectId?: string | null
}

export interface FingerprintObservation {
  fingerprint: StoredFingerprint
  history: readonly StoredFingerprintVersion[]
}

export interface TierObservation {
  observedAt: number
  tierId: string | null
  paidTierId: string | null
  schemaVersion: number
}

export type CooldownObservation = {
  until: number
  reason: CooldownReason
} | null

export interface UsageObservation {
  family: AccountModelFamily
  at: number
}

export interface AccountUsageResult {
  ref: RowRef
  lastUsed: number
  dailyRequestCounts: StoredDailyRequestCounts
}

/** Which selection `selectAccount` changes. */
export type RoutingTarget = 'active' | AccountModelFamily

export interface ManagementReceipt {
  management: ManagementRecord
  outcome: 'completed' | 'pending'
}

/** Mirror of common-auth `PoolFailureKind`, plus repository-level kinds. */
export type AccountRepositoryFailureKind =
  | 'lock-contention'
  | 'lock-ownership'
  | 'pending-migration'
  | 'load-error'
  | 'unknown-row'
  | 'invalid-row'
  | 'invalid-input'
  | 'id-exists'
  | 'id-removed'
  | 'type-mismatch'
  | 'no-credential'
  | 'row-disabled'
  | 'row-protected'
  | 'duplicate-identity'
  | 'identity-mismatch'
  | 'identity-contradicted'
  | 'endpoint-mismatch'
  | 'row-key-changed'
  | 'invalid-order'
  | 'refresh-stamp-ahead'
  | 'unbound-credential'
  | 'attribution'
  | 'provider'
  | 'pull'
  | 'invalid-quota'
  | 'invalid-provider-state'
  | 'after-persist-hook'
  | 'unexpected'
  | 'management-pending'
  | 'metadata-dropped'
  | 'account-ineligible'
  | 'duplicate-secret'
  | 'disposed'

export type AccountRepositoryOperation =
  | 'read'
  | 'login'
  | 'replaceCredential'
  | 'rotateCredential'
  | 'refresh'
  | 'recordIdentity'
  | 'setEnabled'
  | 'recordAccessVerdict'
  | 'updateMetadata'
  | 'recordProject'
  | 'recordFingerprint'
  | 'recordTier'
  | 'recordCooldown'
  | 'recordRateLimits'
  | 'recordSwitch'
  | 'recordUsage'
  | 'recordQuota'
  | 'selectAccount'
  | 'reorder'
  | 'remove'
  | 'clear'
  | 'replacePool'
  | 'flush'

/**
 * How an operation failed. Messages never contain credentials. `ambiguous`
 * marks a write that may or may not have landed (the usage increment
 * included): callers reload and report instead of replaying it.
 */
export interface AccountRepositoryFailure {
  operation: AccountRepositoryOperation
  kind: AccountRepositoryFailureKind
  retryable: boolean
  ambiguous: boolean
  rowId?: string
  message: string
}

export interface AccountFlushReport {
  /** Writes that completed while draining. */
  completed: number
  failures: readonly AccountRepositoryFailure[]
}

/**
 * Typed operations on the Antigravity account pool. Every write that is
 * about a credential takes the `RowRef` the caller's evidence was gathered
 * under and is refused (`attribution`) once the row holds another epoch or
 * identity, and (`unknown-row`) once it is removed. Ordinary operations use
 * the store's row/provider/save locks; only `clear` and `replacePool` write a
 * `ManagementRecord`.
 */
export interface AccountRepository {
  /** Reads the pool and settings without writing or firing quota pulls. */
  read(): Promise<AccountRepositoryRead>
  /** Resolves once every quota pull fired so far has settled. */
  settled(): Promise<void>

  /**
   * Admits a login: matches an existing row by exact email, then by secret;
   * contradictory matches refuse. The returned ref is authoritative.
   */
  login(input: AccountLoginInput): Promise<AccountLoginResult>
  /**
   * Gives a row a new credential and a new epoch (re-authentication). Quota,
   * rate limits, cooldown and access blocks of the old credential are
   * cleared; same-account display fields are kept.
   */
  replaceCredential(
    id: string,
    input: AccountReplaceInput,
  ): Promise<{ ref: RowRef }>
  /** Stores an authoritative successor of the same lineage; keeps the epoch. */
  rotateCredential(
    ref: RowRef,
    input: AccountRotateInput,
  ): Promise<{ ref: RowRef }>
  /**
   * Refreshes under the row lease and the account-keyed provider lock, held
   * across the token exchange; only the save locks are released around it.
   */
  refresh(
    ref: RowRef,
    options?: AccountRefreshOptions,
  ): Promise<AccountRefreshOutcome>
  /** Records an authenticated identity lookup for the credential in `ref`. */
  recordIdentity(ref: RowRef, identity: string): Promise<{ ref: RowRef }>

  /**
   * Enables or disables a row, optionally changing its metadata in the same
   * crash-consistent write.
   */
  setEnabled(
    ref: RowRef,
    input: AccountEnableInput,
  ): Promise<AccountTransitionResult>
  /** Applies access evidence (verification, eligibility) with its flag. */
  recordAccessVerdict(
    ref: RowRef,
    verdict: AccessVerdict,
  ): Promise<AccountTransitionResult>

  /** Changes metadata only; the credential and its stamp status stay. */
  updateMetadata(
    ref: RowRef,
    mutator: MetadataMutator,
  ): Promise<AccountMetadataResult>
  recordProject(
    ref: RowRef,
    observation: ProjectObservation,
  ): Promise<AccountMetadataResult>
  recordFingerprint(
    ref: RowRef,
    observation: FingerprintObservation,
  ): Promise<AccountMetadataResult>
  recordTier(
    ref: RowRef,
    observation: TierObservation,
  ): Promise<AccountMetadataResult>
  recordCooldown(
    ref: RowRef,
    observation: CooldownObservation,
  ): Promise<AccountMetadataResult>
  /** Merges resets key by key, keeping the later reset of each key. */
  recordRateLimits(
    ref: RowRef,
    resets: Readonly<StoredRateLimitResetTimes>,
  ): Promise<AccountMetadataResult>
  recordSwitch(
    ref: RowRef,
    reason: LastSwitchReason,
  ): Promise<AccountMetadataResult>
  /**
   * Increments today's (UTC, from the injected clock) count for the family
   * under the row lock and keeps the later `lastUsed`. An ambiguous failure
   * is reported, never replayed.
   */
  recordUsage(
    ref: RowRef,
    observation: UsageObservation,
  ): Promise<AccountUsageResult>
  /**
   * Records a quota reading for the credential in `ref`. Separate from
   * `recordTier`: the two land as independent attributed writes.
   */
  recordQuota(ref: RowRef, observation: QuotaState): Promise<void>

  /** Points a selection at a row (`null` clears it) in the routing settings. */
  selectAccount(target: RoutingTarget, row: RowRef | null): Promise<void>
  /** Sets the roster order; `ids` names every row exactly once. */
  reorder(ids: readonly string[]): Promise<void>
  /** Removes one row; its epochs stay retired so the id is never reused. */
  remove(ref: RowRef): Promise<void>
  /** Removes every row as one journaled operation. */
  clear(): Promise<ManagementReceipt>
  /**
   * Replaces the pool with new logins as one journaled operation; inputs
   * stay in a private transfer file until verified.
   */
  replacePool(inputs: readonly AccountLoginInput[]): Promise<ManagementReceipt>

  /** Waits for queued writes and reports every failure among them. */
  flush(): Promise<AccountFlushReport>
  /** Flushes, then refuses further writes (`disposed`). */
  dispose(): Promise<AccountFlushReport>
}
