/**
 * Contract of the Antigravity account repository. The foundation uses the
 * public lease-backed pool store of @cortexkit/common-auth (its `./store`
 * entry). Atomic credential replacement additionally requires a store that
 * exposes the credential-write attribution API described at
 * `AccountRepository.replaceCredential`.
 *
 * The repository replaces whole-file snapshots of `antigravity-accounts.json`
 * with typed operations on individual rows. A row is addressed by a `RowRef`
 * rather than by its position, because positions move under reorder and
 * removal while a ref names one credential of one row: work started for a
 * credential that has since been replaced or removed is refused instead of
 * landing on its successor.
 *
 * Persisted data has four owners:
 * - the store's own roster and credential entries: the bare refresh token,
 *   the effective enabled flag and the row order;
 * - provider metadata (`ProviderStateEnvelope`), kept beside the credential
 *   in the store's state file. The part of it that describes the signed-in
 *   account (see `CREDENTIAL_BOUND_METADATA_FIELDS`) is covered by the
 *   store's credential stamp, so a writer that edits it without knowing the
 *   stamp makes the value disappear from reads instead of attaching it to
 *   the wrong account;
 * - the latest quota reading (`QuotaState`), kept in the row's entry in the
 *   store's config file;
 * - account selection (`RoutingSettings`), kept as a plugin settings key in
 *   the store's config file.
 *
 * Every shape below that carries `extensions` keeps JSON it does not
 * recognise there, so a file written by a newer build survives a read and
 * rewrite by this one. Optional fields distinguish absent (key missing) from
 * `null`; the codecs never collapse one into the other. Readers treat an
 * optional `null` like absent when they project the data for routing.
 *
 * Credential epochs and identities. The store gives every credential a row
 * holds an epoch number (common-auth `dist/store/attribution.d.ts`,
 * `Attribution`): `add` and `replace` start a new epoch, while refresh and
 * `rotate` keep it. An id that is removed and added again starts past every
 * epoch it held before, in any process. A row without a per-row entry counts
 * as epoch 1. The recorded identity is the account id the provider reported
 * for the credential. Within one epoch it can only go from absent to one
 * value: `recordIdentity`, `rotate`, a re-`add` of the same secret and a
 * refresh all refuse a different identity (`identity-mismatch`, or
 * `identity-contradicted` for a refresh) rather than overwrite it
 * (`dist/store/rows.js` `recordRowIdentity`, `rotateRow`, `addRow`;
 * `dist/store/refresh.d.ts`).
 *
 * Locks. The store takes, in this order and releases in reverse: the row
 * lock `row-<encodeURIComponent(identity ?? id)>` at the state path
 * (`dist/store/runtime.js` `rowLockSpec`), the provider lock (by default
 * `provider-antigravity` at the state path, `dist/store/pool.js`), any extra
 * locks the caller passes, then the `save` locks at the config path and then
 * the state path. A refresh holds the store's `save` locks only while it
 * reads and while it commits, never across the token exchange
 * (`dist/store/refresh.d.ts` `refreshRow`).
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

/** Schema version written inside `ProviderStateEnvelope`. */
export const PROVIDER_STATE_SCHEMA_VERSION = 1
/** Schema version written inside `QuotaState`. */
export const QUOTA_STATE_SCHEMA_VERSION = 1
/** Schema version written inside `RoutingSettings`. */
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
 * Prefix of the per-account lock passed as a refresh's `providerLock`, in
 * place of the store-wide `provider-antigravity` lock. It must differ from the
 * store's `row-` prefix: the same refresh already holds the row lock, and a
 * provider lock with the same name and path would wait on itself.
 */
export const REFRESH_PROVIDER_LOCK_PREFIX = 'agy-refresh-'
/** Lock name the pre-store writers hold on `antigravity-accounts.json`. */
export const LEGACY_ACCOUNTS_LOCK_NAME = 'accounts'
/** Lease of that lock while the migration holds it. */
export const LEGACY_ACCOUNTS_LOCK_TTL_MS = 10_000

// ---------------------------------------------------------------------------
// Row addressing
// ---------------------------------------------------------------------------

/**
 * Names one credential of one row: its local id, the credential epoch the
 * store assigned it (1 for a row without a per-row entry) and the identity
 * recorded for it, as explained at the top of this file. Leaving `identity`
 * out means "the row had none recorded", never "any identity". A row's
 * position in the roster is never part of a ref.
 */
export interface RowRef {
  readonly id: string
  readonly credentialEpoch: number
  readonly identity?: string
}

/**
 * A lock file the store takes: its name and directory path plus optional
 * lease tuning. Same shape as `PoolLockSpec` in common-auth
 * `dist/store/refresh-lock.d.ts`, so it can be passed to the store as is.
 */
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
 * The per-account lock a refresh of `row` passes as its `providerLock` and
 * holds across the token exchange, so refreshes of different accounts run
 * concurrently while two refreshes of one account stay one at a time. It is
 * keyed like the store's row lock (recorded identity, else local id) and
 * URI-encoded so any identity is a safe lock-file name.
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
 * The lock the pre-store writers hold on `antigravity-accounts.json`, taken
 * while the migration reads or retires that file. It is released before any
 * store call, so it never sits inside the store's lock order.
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
// Provider metadata kept beside the credential in the state file
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

/**
 * Requests sent through the account per model family on one day. `date` is
 * the UTC day the counts belong to (`YYYY-MM-DD`, as
 * `new Date(now).toISOString().slice(0, 10)` gives it). Decoding keeps a
 * past day and its counts as stored; only a usage write starts a new day.
 */
export interface StoredDailyRequestCounts {
  date: string
  claude: number
  gemini: number
  extensions?: JsonObject
}

/**
 * When each rate limit on the account ends, in epoch milliseconds, keyed by
 * quota pool (`claude`, `gemini-antigravity`, `gemini-cli`) or by a
 * model-specific key; `null` where an older writer stored one. Every key is
 * kept as stored.
 */
export type StoredRateLimitResetTimes = Record<string, number | null>

/**
 * Antigravity metadata kept beside a row's credential; it never holds a
 * credential. The fields named in `CREDENTIAL_BOUND_METADATA_FIELDS`
 * describe the account the credential signs in to (its email, projects,
 * device fingerprint, access verdicts and plan tier), so the store's
 * credential stamp covers them; the rest track how this plugin uses the
 * account.
 */
export interface ProviderMetadata {
  /** Exactly as received; never case-folded, and never inferred. */
  email?: string | null
  /** Kept bare here; packed with the refresh token only at host boundaries. */
  projectId?: string | null
  managedProjectId?: string | null
  /** Add time shown to the user; the store's own add time is separate. */
  addedAt: number
  lastUsed: number
  /**
   * How the pre-store file encoded the enabled flag (absent, true, false or
   * null). The effective flag is the store's own, `value !== false`.
   */
  enabled?: boolean | null
  lastSwitchReason?: LastSwitchReason | null
  rateLimitResetTimes?: StoredRateLimitResetTimes | null
  coolingDownUntil?: number | null
  cooldownReason?: CooldownReason | null
  /** Display label; may hold personal data and must stay out of telemetry. */
  label?: string | null
  fingerprint?: StoredFingerprint | null
  /** Kept in the stored array order; never re-sorted or truncated. */
  fingerprintHistory?: StoredFingerprintVersion[] | null
  verificationRequired?: boolean | null
  verificationRequiredAt?: number | null
  verificationRequiredReason?: string | null
  /** Checked where it is captured; kept here as stored. */
  verificationUrl?: string | null
  /** `true` excludes the row from routing. */
  accountIneligible?: boolean | null
  accountIneligibleAt?: number | null
  accountIneligibleReason?: string | null
  eligibilityStateUpdatedAt?: number | null
  /** Upstream tier id exactly as reported, never normalised. */
  capturedTierId?: string | null
  /** As reported; its absence does not mean the account is unpaid or paid. */
  capturedPaidTierId?: string | null
  capturedTierAt?: number | null
  capturedTierSchemaVersion?: number | null
  dailyRequestCounts?: StoredDailyRequestCounts | null
  extensions?: JsonObject
}

/**
 * The `ProviderMetadata` fields that describe the signed-in account rather
 * than this plugin's use of it. The credential stamp covers exactly these.
 */
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
 * The value the store keeps for a row under the state file's
 * `commonAuthProviderState` key. A newer `schemaVersion` is refused rather
 * than reinterpreted.
 */
export interface ProviderStateEnvelope {
  schemaVersion: typeof PROVIDER_STATE_SCHEMA_VERSION
  metadata: ProviderMetadata
  extensions?: JsonObject
}

// ---------------------------------------------------------------------------
// Quota reading kept in the row's config entry
// ---------------------------------------------------------------------------

export type QuotaWindowName = 'weekly' | '5h'

export interface StoredQuotaWindow {
  window: QuotaWindowName
  remainingFraction: number
  resetTime: string
  extensions?: JsonObject
}

export interface StoredQuotaGroup {
  /** Exactly as reported; never rounded. */
  remainingFraction?: number | null
  /** Upstream reset timestamp string, kept as reported. */
  resetTime?: string | null
  modelCount: number
  /** Kept in the reported order. */
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
 * The latest quota reading, which the store keeps in the row's config entry.
 * Nothing in it authorises a request: `cachedQuotaAccountId` only records
 * which account produced the reading.
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
// Account selection kept in plugin settings
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
 * Account selection, kept under `ROUTING_SETTINGS_KEY` in the store's config
 * file. The index fields keep the pre-store `activeIndex` and
 * `activeIndexByFamily` values exactly as stored (readers clamp the index to
 * the roster, as the pre-store loader did); the row fields name the selected
 * row for each family independently. A ref that no longer matches a row
 * falls back to the index rules.
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
// Codec hooks the pool store calls
// ---------------------------------------------------------------------------

/**
 * What the store tells the provider-state replacement hook about a
 * `replace`. Same shape as `ProviderStateReplacement` in common-auth
 * `dist/store/schema.d.ts`. `previousIdentity` is optional because stores
 * without the locked prior-identity field (0.10.0 among them) never pass it.
 */
export interface ProviderStateReplacementInfo {
  id: string
  credentialEpoch: number
  previousIdentity?: string
  identity?: string
  incoming?: unknown
}

/**
 * The hooks the store calls for the value it keeps beside each credential:
 * validation on every load and write, the digest input for the credential
 * stamp, combining a stored value with an incoming one, and the value a
 * credential replacement leaves. Same shape as `ProviderStateCodec` in
 * common-auth `dist/store/schema.d.ts`, where every hook but `validate` is
 * optional.
 */
export interface ProviderStateCodecContract {
  validate(value: unknown): boolean
  credentialBound?(value: unknown): unknown
  merge?(onDisk: unknown, incoming: unknown): unknown
  onReplace?(
    previous: unknown | undefined,
    replacement: ProviderStateReplacementInfo,
  ): unknown | undefined
}

/**
 * The provider-state codec this plugin opens the store with: every hook is
 * present. Left out, the store would fall back to its defaults (the incoming
 * value replaces the stored one; a replace keeps only the value handed to
 * it), which would bypass the repository's merge and replacement rules.
 */
export interface ConfiguredProviderStateCodec
  extends ProviderStateCodecContract {
  credentialBound(value: unknown): unknown
  merge(onDisk: unknown, incoming: unknown): unknown
  onReplace(
    previous: unknown | undefined,
    replacement: ProviderStateReplacementInfo,
  ): unknown | undefined
}

/** A credential replacement as the replacement policy sees it. */
export interface ProviderStateReplacement {
  id: string
  /** The epoch the new credential starts. */
  credentialEpoch: number
  /**
   * The known prior identity: what the row had recorded before the replace,
   * read by the store under its locks. Absent when the row recorded none or
   * the store does not supply the field (0.10.0 does not). Without a known
   * prior identity a rule cannot conclude that the new credential belongs
   * to the same account, neither from `identity` alone nor from both being
   * absent, so it must not carry the credential-bound account metadata
   * (`CREDENTIAL_BOUND_METADATA_FIELDS`) across on that basis. This is an
   * input to a retention rule only; it is not the attribution check (see
   * `AccountRepository.replaceCredential`).
   */
  previousIdentity?: string
  /** The identity the replace records for the new credential. */
  identity?: string
  /** The metadata handed to `replace`, already validated. */
  incoming?: ProviderStateEnvelope
}

/**
 * The repository's rules for combining provider metadata, which the codec
 * factory requires. Both run synchronously under the store's locks and must
 * not call back into the store. A rule that throws refuses the whole write
 * before anything is written.
 */
export interface ProviderStatePolicy {
  /**
   * Combines the stored metadata with metadata that arrives with a
   * credential write of the same epoch: a refresh, or an `add` of a secret
   * the pool already holds (the store's own `rotate` also calls it).
   */
  merge(
    onDisk: ProviderStateEnvelope,
    incoming: ProviderStateEnvelope,
  ): ProviderStateEnvelope
  /**
   * The metadata a row keeps once `replace` gives it a new credential;
   * `undefined` clears it. `previous` is the replaced credential's metadata
   * when the row showed any.
   */
  onReplace(
    previous: ProviderStateEnvelope | undefined,
    replacement: ProviderStateReplacement,
  ): ProviderStateEnvelope | undefined
}

/**
 * The hooks the store calls for the quota reading: validation, and folding a
 * new reading into the stored one. Same shape as `QuotaCodec` in common-auth
 * `dist/store/schema.d.ts`.
 */
export interface QuotaCodecContract {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

// ---------------------------------------------------------------------------
// Repository construction
// ---------------------------------------------------------------------------

/**
 * Files the repository owns. The pre-store pool file is read only by the
 * migration, which then retires it; everything else lives in a private
 * directory beside it, so a pre-store writer that still runs can never touch
 * the store's credentials or epochs.
 */
export interface AccountStorePaths {
  /** The pre-store v4 `antigravity-accounts.json`. */
  legacyPath: string
  /** `<dirname(legacyPath)>/<basename(legacyPath)>.store/` */
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

/**
 * What the store proves about a row's credential. Same values as
 * `CredentialStampStatus` in common-auth `dist/store/schema.d.ts`; only
 * `bound` is usable, since the store is opened with credential stamps
 * required.
 */
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
 * value the row does not show (another writer changed its account-describing
 * part, or the codec refuses it); callers treat that as an error to surface,
 * never as an empty value to regenerate.
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
  /** The store's effective enabled flag. */
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
  /** The store's `disabledReason` when disabling. */
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

/**
 * Same failure kinds as `PoolFailureKind` in common-auth
 * `dist/store/errors.d.ts`, followed by the repository's own.
 */
export type AccountRepositoryFailureKind =
  | 'lock-contention'
  | 'lock-ownership'
  | 'pending-migration'
  | 'load-error'
  | 'snapshot-contended'
  | 'publication-sync'
  | 'publication-incomplete'
  | 'publication-mismatch'
  | 'row-staged'
  | 'credential-exists'
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
  | 'replacement-unavailable'
  | 'metadata-dropped'
  | 'account-ineligible'
  | 'duplicate-secret'
  | 'disposed'

export type AccountRepositoryOperation =
  | 'read'
  | 'login'
  | 'replaceCredential'
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
 * Typed operations on the Antigravity account pool.
 *
 * Every operation about an existing credential takes the `RowRef` the
 * caller's evidence was gathered under. The repository refuses it with
 * `attribution` when the row's epoch or recorded identity has changed since
 * then, and with `unknown-row` when the row has been removed. Each method
 * below names the store API that makes this check under the row and save
 * locks before anything is written. Ordinary operations take only the
 * store's locks; only `clear` and `replacePool` write a `ManagementRecord`,
 * the resumable record of a destructive multi-row or migration operation.
 */
export interface AccountRepository {
  /** Reads the pool and settings without writing or firing quota pulls. */
  read(): Promise<AccountRepositoryRead>
  /** Resolves once every quota pull fired so far has settled. */
  settled(): Promise<void>

  /**
   * Admits a login: matches an existing row by exact email, then by secret;
   * contradictory matches refuse. It names no existing credential, so it
   * takes no ref; the returned ref is authoritative.
   */
  login(input: AccountLoginInput): Promise<AccountLoginResult>
  /**
   * Gives the row in `expected` a new credential and a new epoch
   * (re-authentication). Quota, rate limits, cooldown and access blocks of
   * the old credential are cleared; same-account display fields are kept.
   *
   * The repository must refuse it (`attribution`, nothing written) unless,
   * under the row and save locks and before anything is written, the row
   * still holds exactly `expected`: the same epoch and the same recorded
   * identity, an absent identity matching only an absent one.
   *
   * Requires a store exposing atomic credential-write attribution:
   * `RowWriteOptions.attribution` on `replace` (`dist/store/rows.d.ts`),
   * which common-auth 0.10.0 lacks. The repository passes `expected`'s
   * epoch and identity exactly as that attribution; the store compares them
   * under the row and store locks before completing an interrupted replace,
   * before any write and before the replacement hook, and refuses with
   * `attribution` (retryable, nothing written). Without that API this
   * method has no conforming implementation. The hook's `previousIdentity`
   * is only an input to the retention rule, never this check.
   */
  replaceCredential(
    expected: RowRef,
    input: AccountReplaceInput,
  ): Promise<{ ref: RowRef }>
  /**
   * Exchanges the row's refresh token for a new access token (and possibly
   * a new refresh token). The epoch names the login or replacement that put
   * the credential there, not each refresh, so a refresh keeps it; metadata
   * the exchange leaves out (projects included) is kept. This is the only
   * path by which a successor of an existing credential reaches the store.
   *
   * The row lock and the per-account lock from `refreshProviderLock` are
   * held across the exchange; the save locks are held only while the store
   * reads the row and while it commits the files. The store calls
   * `refuse(row)` before locking, on the locked re-read and at commit
   * (`dist/store/refresh.d.ts`); the repository refuses there when the
   * row's epoch or identity differs from `ref`, and the store then drops the
   * refreshed token instead of committing it to a changed or replaced row.
   */
  refresh(
    ref: RowRef,
    options?: AccountRefreshOptions,
  ): Promise<AccountRefreshOutcome>
  /**
   * Records an authenticated identity lookup for the credential in `ref`.
   * Fence: the store's `recordIdentity` attribution checks the epoch; a
   * different identity already recorded refuses with `identity-mismatch`.
   */
  recordIdentity(ref: RowRef, identity: string): Promise<{ ref: RowRef }>

  /**
   * Enables or disables a row, optionally changing its metadata in the same
   * crash-consistent write. Fence: the store's `enable`/`disable`
   * `attribution` option (epoch and identity).
   */
  setEnabled(
    ref: RowRef,
    input: AccountEnableInput,
  ): Promise<AccountTransitionResult>
  /**
   * Applies access evidence (verification, eligibility) together with the
   * enabled flag. Fence: as `setEnabled`.
   */
  recordAccessVerdict(
    ref: RowRef,
    verdict: AccessVerdict,
  ): Promise<AccountTransitionResult>

  /**
   * Changes metadata only; the credential and its stamp status stay. Fence
   * for this and every metadata `record*` method below: the store's
   * `updateProviderState` fence (epoch and identity).
   */
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
  /**
   * Merges reset times key by key, keeping the later time for each key.
   */
  recordRateLimits(
    ref: RowRef,
    resets: Readonly<StoredRateLimitResetTimes>,
  ): Promise<AccountMetadataResult>
  recordSwitch(
    ref: RowRef,
    reason: LastSwitchReason,
  ): Promise<AccountMetadataResult>
  /**
   * Adds one request for the family to the account's count for the current
   * UTC day (from the injected clock), starting from zero when the stored
   * `date` is another day, and keeps the later of the stored and given
   * `lastUsed`. It runs under the row lock. A failure that leaves unknown
   * whether the increment landed is reported as `ambiguous` and is never
   * retried, so a request is never counted twice.
   */
  recordUsage(
    ref: RowRef,
    observation: UsageObservation,
  ): Promise<AccountUsageResult>
  /**
   * Records a quota reading for the credential in `ref`, separately from
   * `recordTier`: the two are independent writes. Fence: the store's
   * `recordQuota` attribution (epoch and identity).
   */
  recordQuota(ref: RowRef, observation: QuotaState): Promise<void>

  /** Points a selection at a row (`null` clears it) in the routing settings. */
  selectAccount(target: RoutingTarget, row: RowRef | null): Promise<void>
  /** Sets the roster order; `ids` names every row exactly once. */
  reorder(ids: readonly string[]): Promise<void>
  /**
   * Removes one row; the store keeps its epochs retired, so a later add of
   * the same id starts past them. Fence: the store's `remove` `protect`
   * callback, which sees the row under every lock before anything is
   * written.
   */
  remove(ref: RowRef): Promise<void>
  /** Removes every row as one journaled operation. */
  clear(): Promise<ManagementReceipt>
  /**
   * Replaces the account list through the store's single configuration write.
   * Prepared accounts remain disabled until that write commits. Refresh tokens
   * stay in an owner-only transfer file until verification; interrupted calls
   * replay the recorded write plan. If the store cannot publish the entire list
   * at once, replacement of a non-empty pool refuses without changing it.
   */
  replacePool(inputs: readonly AccountLoginInput[]): Promise<ManagementReceipt>

  /** Waits for queued writes and reports every failure among them. */
  flush(): Promise<AccountFlushReport>
  /** Flushes, then refuses further writes (`disposed`). */
  dispose(): Promise<AccountFlushReport>
}
