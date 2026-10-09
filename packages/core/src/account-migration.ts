import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  AccountCodecError,
  decodeProviderMetadata,
  decodeProviderState,
  decodeQuotaState,
  decodeRoutingSettings,
  encodeProviderMetadata,
  encodeProviderState,
  encodeQuotaState,
  encodeRoutingSettings,
  isValidProviderState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from './account-repository-codecs.ts'
import type {
  AccountCredentialStamp,
  AccountLockSpec,
  AccountStorePaths,
  ConfiguredProviderStateCodec,
  JsonObject,
  ProviderMetadata,
  QuotaState,
  RoutingSettings,
  RowRef,
} from './account-repository-types.ts'
import {
  ACCOUNT_STORE_PROVIDER,
  legacyAccountsLock,
  MANAGEMENT_LOCK_NAME,
  MANAGEMENT_SETTINGS_KEY,
  ROUTING_SETTINGS_KEY,
} from './account-repository-types.ts'

/** Derives store paths from the caller's absolute legacy file path, not HOME or host preferences. */
export function resolveAccountStorePaths(
  legacyPath: string,
  generationId?: string,
): AccountStorePaths {
  if (generationId !== undefined)
    return generationPaths(legacyPath, generationId)
  if (!isAbsolute(legacyPath) || legacyPath !== resolve(legacyPath)) {
    throw new AccountMigrationError(
      'legacy path must be absolute and normalized',
    )
  }
  const storeDir = join(dirname(legacyPath), `${basename(legacyPath)}.store`)
  return {
    legacyPath,
    storeDir,
    configPath: join(storeDir, 'config.json'),
    statePath: join(storeDir, 'state.json'),
    migrationPath: join(storeDir, 'migration.json'),
    backupsDir: join(storeDir, 'backups'),
    retiredDir: join(storeDir, 'retired'),
    transfersDir: join(storeDir, 'transfers'),
  }
}
export interface AccountStorePointer {
  schemaVersion: 1
  id: string
  directoryBasename: string
}
export function accountStorePointerPath(legacyPath: string): string {
  return `${resolveAccountStorePaths(legacyPath).storeDir}.pointer.json`
}
function generationPaths(legacyPath: string, id: string): AccountStorePaths {
  const logical = resolveAccountStorePaths(legacyPath)
  text(id, UUID, 'generation id')
  const storeDir = join(
    dirname(legacyPath),
    `${basename(legacyPath)}.store.${id}.generation`,
  )
  return {
    ...logical,
    storeDir,
    configPath: join(storeDir, 'config.json'),
    statePath: join(storeDir, 'state.json'),
    migrationPath: join(storeDir, 'migration.json'),
    backupsDir: join(storeDir, 'backups'),
    retiredDir: join(storeDir, 'retired'),
    transfersDir: join(storeDir, 'transfers'),
  }
}
function pathGenerationId(paths: AccountStorePaths): string {
  const id = basename(paths.storeDir).slice(
    `${basename(paths.legacyPath)}.store.`.length,
    -'.generation'.length,
  )
  text(id, UUID, 'physical generation')
  if (!isDeepStrictEqual(generationPaths(paths.legacyPath, id), paths))
    throw new AccountMigrationError(
      'physical paths differ from derived generation',
    )
  return id
}
export function decodeAccountStorePointer(
  value: unknown,
  legacyPath: string,
): AccountStorePointer {
  const raw = exact(
    value,
    ['schemaVersion', 'id', 'directoryBasename'],
    'pointer',
  )
  if (raw.schemaVersion !== 1)
    throw new AccountMigrationError('unsupported pointer schema')
  const id = text(raw.id, UUID, 'pointer generation')
  const paths = generationPaths(legacyPath, id)
  if (raw.directoryBasename !== basename(paths.storeDir))
    throw new AccountMigrationError(
      'pointer directory basename differs from its derived generation',
    )
  return { schemaVersion: 1, id, directoryBasename: basename(paths.storeDir) }
}
async function readPointer(
  legacyPath: string,
): Promise<AccountStorePointer | undefined> {
  const logical = resolveAccountStorePaths(legacyPath)
  if (await exists(logical.storeDir))
    throw new AccountMigrationError(
      'foreign logical store directory is not pointer authority',
    )
  const path = accountStorePointerPath(legacyPath)
  if (!(await exists(path))) return undefined
  return decodeAccountStorePointer(
    jsonBytes(await secureRead(path)),
    legacyPath,
  )
}
export async function resolvePublishedAccountStorePaths(
  legacyPath: string,
): Promise<AccountStorePaths | undefined> {
  const pointer = await readPointer(legacyPath)
  if (!pointer) return undefined
  const paths = generationPaths(legacyPath, pointer.id)
  const journal = await readJournal(paths)
  if (!journal || journal.id !== pointer.id)
    throw new AccountMigrationError(
      'published generation has no matching complete journal',
    )
  return paths
}
export async function assertPublishedAccountStoreGeneration(
  paths: AccountStorePaths,
): Promise<void> {
  const current = await resolvePublishedAccountStorePaths(paths.legacyPath)
  if (!current || !isDeepStrictEqual(current, paths))
    throw new AccountMigrationError(
      'bound store generation is no longer published',
    )
}

/** Errors contain field paths and ordinals, never account values or secrets. */
export class AccountMigrationError extends Error {
  constructor(readonly reason: string) {
    super(`Account-store migration refused: ${reason}`)
    this.name = 'AccountMigrationError'
  }
}

export interface LegacyAccountManifest {
  /** Original source-account array index, retained so the surviving email winner keeps its original position. */
  ordinal: number
  refreshToken: string
  metadata: ProviderMetadata
  quota?: QuotaState
}

/** Stores the time used to discard expired legacy resets; restarts reuse that captured time. */
export interface LegacyMigrationManifest {
  /** sourceVersion is null only when no legacy JSON file existed, not when that file was version 4. */
  sourceVersion: 1 | 2 | 3 | 4 | null
  normalizationClock: number
  accounts: LegacyAccountManifest[]
  routing: RoutingSettings
  effectiveActiveIndex: number
}

const QUOTA_FIELDS = [
  'cachedQuotaAccountId',
  'cachedQuota',
  'cachedPerModelQuota',
  'cachedQuotaUpdatedAt',
] as const

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountMigrationError(`${path} must be an object`)
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new AccountMigrationError(`${path} is not a plain JSON object`)
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.getOwnPropertyNames(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return (
        key === '__proto__' ||
        !descriptor?.enumerable ||
        !('value' in descriptor)
      )
    })
  )
    throw new AccountMigrationError(`${path} has unsafe JSON properties`)
  return value as Record<string, unknown>
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function assertSerializableNumbers(value: unknown, depth = 0): void {
  if (depth > 128)
    throw new AccountMigrationError('source JSON exceeds safe nesting depth')
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || Object.is(value, -0))
  )
    throw new AccountMigrationError(
      'source contains a numeric value the public JSON writer cannot retain losslessly',
    )
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value))
      assertSerializableNumbers(item, depth + 1)
  }
}

function legacyOptional(
  row: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
  path: string,
): void {
  if (Object.hasOwn(row, key) && row[key] !== null && !predicate(row[key])) {
    throw new AccountMigrationError(`${path}.${key} has an invalid type`)
  }
}

function parseAccount(
  value: unknown,
  ordinal: number,
  version: number,
  clock: number,
): LegacyAccountManifest {
  const path = `accounts[${ordinal}]`
  const source = object(value, path)
  if (
    typeof source.refreshToken !== 'string' ||
    !source.refreshToken.trim().length
  ) {
    throw new AccountMigrationError(`${path}.refreshToken must be nonempty`)
  }
  const metadataRaw = { ...source }
  delete metadataRaw.refreshToken
  const quotaRaw: Record<string, unknown> = { schemaVersion: 1 }
  let hasQuota = false
  for (const key of QUOTA_FIELDS) {
    if (!Object.hasOwn(source, key)) continue
    hasQuota = true
    quotaRaw[key] = source[key]
    delete metadataRaw[key]
  }

  if (version === 1) {
    legacyOptional(source, 'isRateLimited', (v) => typeof v === 'boolean', path)
    legacyOptional(source, 'rateLimitResetTime', finite, path)
    delete metadataRaw.isRateLimited
    delete metadataRaw.rateLimitResetTime
  }
  // Validate the complete shape before normalization can discard old fields.
  const originalMetadata = decodeProviderMetadata(metadataRaw)
  const quota = hasQuota ? decodeQuotaState(quotaRaw) : undefined
  const normalized = encodeProviderMetadata(originalMetadata)
  if (version === 1) {
    if (
      source.isRateLimited &&
      finite(source.rateLimitResetTime) &&
      source.rateLimitResetTime > clock
    ) {
      if (originalMetadata.rateLimitResetTimes === null)
        throw new AccountMigrationError(
          `${path} has conflicting rate-limit encodings`,
        )
      const resets: JsonObject = { ...originalMetadata.rateLimitResetTimes }
      for (const key of ['claude', 'gemini-antigravity']) {
        if (
          Object.hasOwn(resets, key) &&
          resets[key] !== source.rateLimitResetTime
        )
          throw new AccountMigrationError(
            `${path} has conflicting rate-limit encodings`,
          )
        resets[key] = source.rateLimitResetTime
      }
      normalized.rateLimitResetTimes = resets
    }
  } else if (
    version === 2 &&
    originalMetadata.rateLimitResetTimes !== null &&
    originalMetadata.rateLimitResetTimes !== undefined
  ) {
    const resets: JsonObject = { ...originalMetadata.rateLimitResetTimes }
    const claude = resets.claude
    const gemini = resets.gemini
    delete resets.claude
    delete resets.gemini
    if (claude === null || (finite(claude) && claude > clock))
      resets.claude = claude
    if (gemini === null || (finite(gemini) && gemini > clock)) {
      if (
        Object.hasOwn(resets, 'gemini-antigravity') &&
        resets['gemini-antigravity'] !== gemini
      )
        throw new AccountMigrationError(
          `${path} has conflicting rate-limit encodings`,
        )
      resets['gemini-antigravity'] = gemini
    }
    normalized.rateLimitResetTimes = resets
  }
  if (version < 4) {
    delete normalized.fingerprint
    delete normalized.fingerprintHistory
  }
  const metadata = decodeProviderMetadata(normalized)
  return {
    ordinal,
    refreshToken: source.refreshToken,
    metadata,
    ...(quota === undefined ? {} : { quota }),
  }
}

function legacyRouting(source: Record<string, unknown>): RoutingSettings {
  const raw: Record<string, unknown> = { schemaVersion: 1 }
  const unknown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'version' || key === 'accounts') continue
    if (key === 'activeIndex' || key === 'activeIndexByFamily') raw[key] = value
    else {
      if (
        [
          'refreshToken',
          'accessToken',
          'access',
          'refresh',
          'expires',
          'apiKey',
        ].includes(key)
      )
        throw new AccountMigrationError(
          'source-level credential field has no legacy account owner',
        )
      unknown[key] = value
    }
  }
  // legacySourceFields preserves unknown keys in legacy account JSON without
  // interpreting them as the migration's schemaVersion or selected-row references.
  if (Object.keys(unknown).length) raw.legacySourceFields = unknown
  return decodeRoutingSettings(raw)
}

/** Imports source JSON directly: a normal legacy save would normalize email/cursors and lose per-model quota, unknown fields and null/absent distinctions. */
export function parseLegacyAccountStorage(
  bytes: string,
  normalizationClock: number,
): LegacyMigrationManifest {
  if (!finite(normalizationClock) || Object.is(normalizationClock, -0)) {
    throw new AccountMigrationError(
      'normalization clock must be finite and JSON-roundtrippable',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    throw new AccountMigrationError('malformed source JSON')
  }
  assertSerializableNumbers(parsed)
  const source = object(parsed, 'source')
  const version = source.version
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    throw new AccountMigrationError('unsupported source version')
  }
  if (!Array.isArray(source.accounts)) {
    throw new AccountMigrationError('source.accounts must be an array')
  }
  const parsedAccounts = source.accounts.map((row, index) => {
    try {
      return parseAccount(row, index, version, normalizationClock)
    } catch (error) {
      if (error instanceof AccountCodecError) {
        throw new AccountMigrationError(`accounts[${index}]: ${error.message}`)
      }
      throw error
    }
  })
  const winners = new Map<string, LegacyAccountManifest>()
  for (const row of parsedAccounts) {
    const email = row.metadata.email
    if (!email) continue
    const prior = winners.get(email)
    if (
      !prior ||
      row.metadata.lastUsed > prior.metadata.lastUsed ||
      (row.metadata.lastUsed === prior.metadata.lastUsed &&
        row.metadata.addedAt > prior.metadata.addedAt)
    ) {
      winners.set(email, row)
    }
  }
  const accounts = parsedAccounts.filter(
    (row) => !row.metadata.email || winners.get(row.metadata.email) === row,
  )
  const secrets = new Map<string, number>()
  for (const row of accounts) {
    const prior = secrets.get(row.refreshToken)
    if (prior !== undefined) {
      throw new AccountMigrationError(
        `duplicate refresh secret at ordinals ${prior}, ${row.ordinal}`,
      )
    }
    secrets.set(row.refreshToken, row.ordinal)
  }
  const routing = legacyRouting(source)
  const active = routing.activeIndex ?? 0
  const effectiveActiveIndex = accounts.length
    ? Math.max(0, Math.min(active, accounts.length - 1))
    : 0
  return {
    sourceVersion: version,
    normalizationClock,
    accounts,
    routing,
    effectiveActiveIndex,
  }
}

/** Builds v4 JSON from stored account fields, preserving unknown fields and distinguishing null from absence. */
export function exportLegacyAccountStorage(
  accounts: readonly LegacyAccountManifest[],
  routing: RoutingSettings,
): JsonObject {
  const out = encodeRoutingSettings(routing)
  delete out.schemaVersion
  delete out.activeRow
  delete out.activeRowByFamily
  const unknown = out.legacySourceFields
  delete out.legacySourceFields
  if (unknown !== undefined) {
    if (
      unknown === null ||
      typeof unknown !== 'object' ||
      Array.isArray(unknown)
    )
      throw new AccountMigrationError(
        'legacy source extension namespace is malformed',
      )
    for (const [key, value] of Object.entries(unknown)) out[key] = value
  }
  out.version = 4
  out.accounts = accounts.map((row) => {
    const result = encodeProviderMetadata(row.metadata)
    result.refreshToken = row.refreshToken
    if (row.quota !== undefined) {
      const quota = encodeQuotaState(row.quota)
      delete quota.schemaVersion
      for (const [key, value] of Object.entries(quota)) result[key] = value
    }
    return result
  })
  return out
}

/** Public @cortexkit/common-auth/store row fields used here; this interface implements no storage. */
export interface MigrationPoolRow {
  id: string
  type: 'oauth' | 'api'
  enabled: boolean
  identity?: string
  credentialEpoch?: number
  credential?:
    | {
        type: 'oauth'
        refresh: string
        access?: string
        expires?: number
        lastRefreshedAt?: number
      }
    | { type: 'api'; apiKey: string; baseURL: string }
  providerState?: unknown
  providerStateDropped?: 'uncovered' | 'invalid'
  quota?: unknown
  stamp?: AccountCredentialStamp
  candidate: boolean
  /** Public store rows must report hasEntry=true. Optional typing accepts the repository's smaller row interface, not missing runtime entries. */
  hasEntry?: boolean
  torn?: true
  unbound?: true
  invalid?: 'roster' | 'entry'
}

export interface MigrationPoolStore {
  read(): Promise<
    | { status: 'ready'; rows: MigrationPoolRow[] }
    | { status: 'pending-migration' }
    | { status: 'error'; file: 'config' | 'state'; reason: string }
  >
  readSettings(): Promise<
    | {
        status: 'ready' | 'pending-migration'
        settings: Record<string, unknown>
      }
    | { status: 'error'; file: 'config' | 'state'; reason: string }
  >
  initialize(): Promise<{ status: 'initialized' | 'already-ready' }>
  add(
    input: {
      id: string
      credential: { type: 'oauth'; refresh: string }
      providerState: unknown
    },
    options?: { extraLocks?: readonly AccountLockSpec[] },
  ): Promise<{
    id: string
    outcome: 'added' | 'added-disabled' | 'completed' | 'rotated'
  }>
  disable(
    id: string,
    reason: string,
    options?: {
      attribution?: { credentialEpoch: number; identity?: string }
      extraLocks?: readonly AccountLockSpec[]
    },
  ): Promise<{ id: string }>
  enable(
    id: string,
    options?: {
      attribution?: { credentialEpoch: number; identity?: string }
      extraLocks?: readonly AccountLockSpec[]
    },
  ): Promise<{ id: string }>
  recordQuota(
    id: string,
    fence: { credentialEpoch: number; identity?: string },
    observation: unknown,
  ): Promise<void>
  reorder(ids: readonly string[]): Promise<{ ids: string[] }>
  remove(id: string): Promise<{ id: string; outcome: 'removed' | 'completed' }>
  updateSettings(
    mutator: (
      settings: Record<string, unknown>,
    ) => Record<string, unknown> | undefined,
  ): Promise<{ settings: Record<string, unknown> }>
}

export type MigrationPublicWriteStep =
  | 'before-config-write'
  | 'after-config-write'
  | 'before-state-write'
  | 'after-state-write'
export interface MigrationLease {
  assertOwned(): Promise<void>
}

export interface AccountMigrationModules {
  store: {
    readonly PoolOperationError: abstract new (
      ...args: never[]
    ) => Error & { readonly kind: string; readonly retryable: boolean }
    openPoolStore(options: {
      provider: string
      configPath: string
      statePath: string
      requireCredentialStamps: true
      now: () => number
      lockOptions?: { timeoutMs?: number }
      quota: typeof QUOTA_CODEC
      providerState: ConfiguredProviderStateCodec
      onStep?: (
        step: MigrationPublicWriteStep,
        info: { operation: string; rowId: string | undefined },
      ) => void | Promise<void>
    }): MigrationPoolStore
  }
  fs: {
    withLock<T>(
      target: string,
      options: {
        name: string
        ttlMs: number
        timeoutMs: number
        renew?: boolean
      },
      fn: (lease: MigrationLease) => Promise<T>,
    ): Promise<T>
    lockPathFor(target: string, name: string): string
    writeJsonAtomic(
      path: string,
      value: unknown,
      options?: {
        beforeRename?: () => Promise<void>
        stageName?: () => string
      },
    ): Promise<void>
    LockContentionError: abstract new (...args: never[]) => Error
    LockOwnershipError: abstract new (...args: never[]) => Error
  }
}
/** Generation binding and credential-serving admission use only public read/readSettings, accepting the repository's smaller module interface. */
export interface AccountStoreAdmissionModules {
  store: {
    openPoolStore(
      options: Omit<
        Parameters<AccountMigrationModules['store']['openPoolStore']>[0],
        'onStep'
      >,
    ): Pick<MigrationPoolStore, 'read' | 'readSettings'>
  }
}

export const ACCOUNT_MIGRATION_PHASES = [
  'capture',
  'build',
  'verify',
  'retire',
  'activate',
] as const
export type AccountMigrationPhase = (typeof ACCOUNT_MIGRATION_PHASES)[number]
/** ACCOUNT_MIGRATION_PHASES also supplies the allowed antigravityManagement.progress.step names for migration work. */
export const ACCOUNT_MIGRATION_MANAGEMENT_STEPS = ACCOUNT_MIGRATION_PHASES
export const ACCOUNT_STORE_GENERATION_SETTINGS_KEY = 'antigravityGeneration'
export interface AccountStoreGeneration {
  schemaVersion: 1
  id: string
  legacyPath: string
  storeDir: string
  sourceKind: 'file' | 'absent'
  initialManifestSha256: string
}
/** Identifies the published journal UUID in pool settings; account refresh/add/remove/reorder must preserve this generation identity. */
export function decodeAccountStoreGeneration(
  value: unknown,
): AccountStoreGeneration {
  const raw = exact(
    value,
    [
      'schemaVersion',
      'id',
      'legacyPath',
      'storeDir',
      'sourceKind',
      'initialManifestSha256',
    ],
    'generation',
  )
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.legacyPath !== 'string' ||
    (raw.sourceKind !== 'file' && raw.sourceKind !== 'absent')
  )
    throw new AccountMigrationError('generation schema is invalid')
  const id = text(raw.id, UUID, 'generation id')
  const paths = generationPaths(raw.legacyPath, id)
  if (raw.storeDir !== paths.storeDir)
    throw new AccountMigrationError('generation successor association differs')
  return {
    schemaVersion: 1,
    id,
    legacyPath: paths.legacyPath,
    storeDir: paths.storeDir,
    sourceKind: raw.sourceKind,
    initialManifestSha256: text(
      raw.initialManifestSha256,
      SHA256,
      'generation manifest hash',
    ),
  }
}
function generationJson(
  journal: AccountMigrationJournal,
): AccountStoreGeneration {
  return {
    schemaVersion: 1,
    id: journal.id,
    legacyPath: journal.legacyPath,
    storeDir: journal.storeDir,
    sourceKind: journal.sourceKind,
    initialManifestSha256: digest(canonical(manifestJson(journal.manifest))),
  }
}

export interface MigrationVerification {
  manifestSha256: string
  configSha256: string
  stateSha256?: string
  statePresent: boolean
  durability:
    | 'posix-directory-synced'
    | 'windows-reopened-no-directory-power-loss-guarantee'
}

export interface MigrationRollback {
  id: string
  snapshotSha256: string
  exportSha256: string
  rows: string[]
  successorInactive: boolean
}

export interface AccountMigrationJournal {
  schemaVersion: 1
  id: string
  legacyPath: string
  storeDir: string
  status: 'pending' | 'active' | 'inactive'
  operation: 'migrate' | 'rollback'
  phase: AccountMigrationPhase
  sourceKind: 'file' | 'absent'
  sourceSha256?: string
  captureSha256?: string
  sourceAbsenceVerified?: true
  manifest: LegacyMigrationManifest
  /** Row IDs are saved before calling store.add and are never derived from an email address. */
  mapping: { id: string; ordinal: number }[]
  completedRows: string[]
  ownedTemps?: {
    name: string
    sha256: string
    targetPresent: boolean
    priorSha256?: string
  }[]
  verification?: MigrationVerification
  retiredSha256?: string
  rollback?: MigrationRollback
  cancelled?: true
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

function exact(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const record = object(value, path)
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new AccountMigrationError(`${path} has unknown fields`)
  }
  return record
}
function text(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new AccountMigrationError(`${path} is invalid`)
  return value
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    throw new AccountMigrationError(`${path} must be an array`)
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) =>
      Object.getOwnPropertyDescriptor(value, String(index)),
    ).some((descriptor) => !descriptor?.enumerable || !('value' in descriptor))
  )
    throw new AccountMigrationError(`${path} must be a dense plain JSON array`)
  return value
}
function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0)
    throw new AccountMigrationError(
      `${path} must be a nonnegative safe integer`,
    )
  return value
}
function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined)
    throw new AccountMigrationError('non-JSON journal value')
  return encoded
}
function manifestJson(manifest: LegacyMigrationManifest) {
  return {
    ...manifest,
    accounts: manifest.accounts.map((row) => ({
      ordinal: row.ordinal,
      refreshToken: row.refreshToken,
      metadata: encodeProviderMetadata(row.metadata),
      ...(row.quota === undefined
        ? {}
        : { quota: encodeQuotaState(row.quota) }),
    })),
    routing: encodeRoutingSettings(manifest.routing),
  }
}
function journalJson(journal: AccountMigrationJournal) {
  return { ...journal, manifest: manifestJson(journal.manifest) }
}

/** Validates saved journal fields as-is; it never reselects email winners or expires resets using a new time. */
export function decodeAccountMigrationJournal(
  value: unknown,
): AccountMigrationJournal {
  const raw = exact(
    value,
    [
      'schemaVersion',
      'id',
      'legacyPath',
      'storeDir',
      'status',
      'operation',
      'phase',
      'sourceKind',
      'sourceSha256',
      'captureSha256',
      'sourceAbsenceVerified',
      'manifest',
      'mapping',
      'completedRows',
      'ownedTemps',
      'verification',
      'retiredSha256',
      'rollback',
      'cancelled',
    ],
    'journal',
  )
  if (raw.schemaVersion !== 1)
    throw new AccountMigrationError('unsupported journal schema')
  const id = text(raw.id, UUID, 'journal.id')
  if (typeof raw.legacyPath !== 'string')
    throw new AccountMigrationError('journal legacy path is invalid')
  const paths = generationPaths(raw.legacyPath, id)
  if (raw.storeDir !== paths.storeDir)
    throw new AccountMigrationError('journal successor association differs')
  const status = raw.status
  if (status !== 'pending' && status !== 'active' && status !== 'inactive')
    throw new AccountMigrationError('journal status is invalid')
  const operation = raw.operation
  if (operation !== 'migrate' && operation !== 'rollback')
    throw new AccountMigrationError('journal operation is invalid')
  const phase = ACCOUNT_MIGRATION_PHASES.find(
    (candidate) => candidate === raw.phase,
  )
  if (phase === undefined)
    throw new AccountMigrationError('journal phase is invalid')
  const sourceKind = raw.sourceKind
  if (sourceKind !== 'file' && sourceKind !== 'absent')
    throw new AccountMigrationError('journal source kind is invalid')
  const sourceSha256 =
    sourceKind === 'file'
      ? text(raw.sourceSha256, SHA256, 'journal.sourceSha256')
      : undefined
  const captureSha256 =
    sourceKind === 'file'
      ? text(raw.captureSha256, SHA256, 'journal.captureSha256')
      : undefined
  if (sourceKind === 'absent' && Object.hasOwn(raw, 'captureSha256'))
    throw new AccountMigrationError(
      'absent source cannot claim a captured file snapshot',
    )
  if (sourceKind === 'absent' && Object.hasOwn(raw, 'sourceSha256'))
    throw new AccountMigrationError('absent source cannot claim a backup hash')
  if (
    Object.hasOwn(raw, 'sourceAbsenceVerified') &&
    (sourceKind !== 'absent' || raw.sourceAbsenceVerified !== true)
  )
    throw new AccountMigrationError('source absence association is invalid')
  const m = exact(
    raw.manifest,
    [
      'sourceVersion',
      'normalizationClock',
      'accounts',
      'routing',
      'effectiveActiveIndex',
    ],
    'manifest',
  )
  const sourceVersion = m.sourceVersion
  if (
    sourceVersion !== null &&
    sourceVersion !== 1 &&
    sourceVersion !== 2 &&
    sourceVersion !== 3 &&
    sourceVersion !== 4
  )
    throw new AccountMigrationError('manifest source version is invalid')
  if (
    (sourceKind === 'file' && sourceVersion === null) ||
    (sourceKind === 'absent' && sourceVersion !== null)
  )
    throw new AccountMigrationError('manifest version differs from source kind')
  if (!finite(m.normalizationClock) || !finite(m.effectiveActiveIndex))
    throw new AccountMigrationError('manifest clock or cursor is invalid')
  const accounts = list(m.accounts, 'manifest.accounts').map(
    (entry): LegacyAccountManifest => {
      const row = exact(
        entry,
        ['ordinal', 'refreshToken', 'metadata', 'quota'],
        'manifest row',
      )
      if (
        typeof row.refreshToken !== 'string' ||
        !row.refreshToken.trim().length
      )
        throw new AccountMigrationError('manifest refresh secret is empty')
      return {
        ordinal: integer(row.ordinal, 'manifest ordinal'),
        refreshToken: row.refreshToken,
        metadata: decodeProviderMetadata(row.metadata),
        ...(Object.hasOwn(row, 'quota')
          ? { quota: decodeQuotaState(row.quota) }
          : {}),
      }
    },
  )
  const ordinals = accounts.map((row) => row.ordinal)
  if (
    new Set(ordinals).size !== accounts.length ||
    ordinals.some(
      (ordinal, i) => i > 0 && ordinal <= (ordinals[i - 1] ?? -1),
    ) ||
    new Set(accounts.map((row) => row.refreshToken)).size !== accounts.length
  )
    throw new AccountMigrationError('manifest order or secrets are duplicated')
  const manifest: LegacyMigrationManifest = {
    sourceVersion,
    normalizationClock: m.normalizationClock,
    accounts,
    routing: decodeRoutingSettings(m.routing),
    effectiveActiveIndex: m.effectiveActiveIndex,
  }
  assertSerializableNumbers(manifestJson(manifest))
  if (
    sourceKind === 'absent' &&
    (accounts.length ||
      !isDeepStrictEqual(encodeRoutingSettings(manifest.routing), {
        schemaVersion: 1,
      }) ||
      manifest.effectiveActiveIndex !== 0)
  )
    throw new AccountMigrationError(
      'absent-source manifest must be explicitly empty with no invented cursors',
    )
  const effective = accounts.length
    ? Math.max(
        0,
        Math.min(manifest.routing.activeIndex ?? 0, accounts.length - 1),
      )
    : 0
  if (effective !== manifest.effectiveActiveIndex)
    throw new AccountMigrationError('manifest effective cursor differs')
  const mapping = list(raw.mapping, 'mapping').map((entry) => {
    const row = exact(entry, ['id', 'ordinal'], 'mapping row')
    return {
      id: text(row.id, UUID, 'mapping id'),
      ordinal: integer(row.ordinal, 'mapping ordinal'),
    }
  })
  if (
    mapping.length !== accounts.length ||
    new Set(mapping.map((row) => row.id)).size !== mapping.length ||
    mapping.some((row, i) => row.ordinal !== accounts[i]?.ordinal)
  )
    throw new AccountMigrationError('mapping differs from full manifest order')
  const completedRows = list(raw.completedRows, 'completedRows').map((entry) =>
    text(entry, UUID, 'completed row'),
  )
  if (
    new Set(completedRows).size !== completedRows.length ||
    completedRows.some((row) => !mapping.some((mapped) => mapped.id === row))
  )
    throw new AccountMigrationError(
      'completed rows do not belong to this journal',
    )
  if (completedRows.some((id, index) => id !== mapping[index]?.id))
    throw new AccountMigrationError(
      'completed rows are not the captured prefix order',
    )
  let ownedTemps:
    | {
        name: string
        sha256: string
        targetPresent: boolean
        priorSha256?: string
      }[]
    | undefined
  if (Object.hasOwn(raw, 'ownedTemps')) {
    ownedTemps = list(raw.ownedTemps, 'owned temps').map((value) => {
      const temp = exact(
        value,
        ['name', 'sha256', 'targetPresent', 'priorSha256'],
        'owned temp',
      )
      if (
        typeof temp.targetPresent !== 'boolean' ||
        (!temp.targetPresent && Object.hasOwn(temp, 'priorSha256'))
      )
        throw new AccountMigrationError('owned stage prior presence is invalid')
      return {
        name: text(
          temp.name,
          /^(?:config|state)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/,
          'owned temp name',
        ),
        sha256: text(temp.sha256, SHA256, 'owned temp hash'),
        targetPresent: temp.targetPresent,
        ...(temp.targetPresent
          ? { priorSha256: text(temp.priorSha256, SHA256, 'prior target hash') }
          : {}),
      }
    })
    if (
      ownedTemps.length > 2 ||
      new Set(ownedTemps.map((temp) => temp.name)).size !== ownedTemps.length
    )
      throw new AccountMigrationError(
        'owned temp references are duplicated or excessive',
      )
  }
  let verification: MigrationVerification | undefined
  if (Object.hasOwn(raw, 'verification')) {
    const v = exact(
      raw.verification,
      [
        'manifestSha256',
        'configSha256',
        'stateSha256',
        'statePresent',
        'durability',
      ],
      'verification',
    )
    if (typeof v.statePresent !== 'boolean')
      throw new AccountMigrationError('state presence encoding is invalid')
    if (!v.statePresent && Object.hasOwn(v, 'stateSha256'))
      throw new AccountMigrationError(
        'absent successor state cannot claim a file hash',
      )
    if (
      v.durability !== 'posix-directory-synced' &&
      v.durability !== 'windows-reopened-no-directory-power-loss-guarantee'
    )
      throw new AccountMigrationError('verification durability is invalid')
    verification = {
      manifestSha256: text(v.manifestSha256, SHA256, 'manifest hash'),
      configSha256: text(v.configSha256, SHA256, 'config hash'),
      ...(v.statePresent
        ? { stateSha256: text(v.stateSha256, SHA256, 'state hash') }
        : {}),
      statePresent: v.statePresent,
      durability: v.durability,
    }
    if (
      verification.manifestSha256 !== digest(canonical(manifestJson(manifest)))
    )
      throw new AccountMigrationError(
        'verification is not associated with the complete manifest',
      )
  }
  const retiredSha256 = Object.hasOwn(raw, 'retiredSha256')
    ? text(raw.retiredSha256, SHA256, 'retired hash')
    : undefined
  if (sourceKind === 'absent' && retiredSha256 !== undefined)
    throw new AccountMigrationError('absent source cannot claim retired bytes')
  if (retiredSha256 !== undefined && retiredSha256 !== sourceSha256)
    throw new AccountMigrationError(
      'retired bytes are not associated with source',
    )
  let rollback: MigrationRollback | undefined
  if (Object.hasOwn(raw, 'rollback')) {
    const r = exact(
      raw.rollback,
      ['id', 'snapshotSha256', 'exportSha256', 'rows', 'successorInactive'],
      'rollback',
    )
    const rows = list(r.rows, 'rollback rows').map((id) =>
      text(id, UUID, 'rollback row id'),
    )
    if (
      new Set(rows).size !== rows.length ||
      typeof r.successorInactive !== 'boolean'
    )
      throw new AccountMigrationError(
        'rollback rows or inactive flag is invalid',
      )
    rollback = {
      id: text(r.id, UUID, 'rollback id'),
      snapshotSha256: text(r.snapshotSha256, SHA256, 'snapshot hash'),
      exportSha256: text(r.exportSha256, SHA256, 'export hash'),
      rows,
      successorInactive: r.successorInactive,
    }
  }
  if (Object.hasOwn(raw, 'cancelled') && raw.cancelled !== true)
    throw new AccountMigrationError('cancellation flag is invalid')
  const cancelled = raw.cancelled === true
  if (
    cancelled &&
    (status === 'active' ||
      operation !== 'rollback' ||
      (status === 'inactive' && phase !== 'activate') ||
      rollback !== undefined ||
      retiredSha256 !== undefined)
  )
    throw new AccountMigrationError('invalid pre-retirement cancellation')
  if (
    (phase === 'retire' || phase === 'activate' || status === 'active') &&
    !cancelled &&
    verification === undefined
  )
    throw new AccountMigrationError(
      'retirement lacks durable full-row verification',
    )
  if (
    operation === 'migrate' &&
    verification !== undefined &&
    completedRows.length !== mapping.length
  )
    throw new AccountMigrationError(
      'verification acknowledged an incomplete import',
    )
  if (
    operation === 'migrate' &&
    (retiredSha256 !== undefined || raw.sourceAbsenceVerified === true) &&
    (!verification || (phase !== 'retire' && phase !== 'activate'))
  )
    throw new AccountMigrationError(
      'retirement association precedes durable verification',
    )
  if (
    operation === 'migrate' &&
    phase === 'activate' &&
    (sourceKind === 'file'
      ? retiredSha256 === undefined
      : raw.sourceAbsenceVerified !== true)
  )
    throw new AccountMigrationError(
      'activation lacks its actual source retirement association',
    )
  if (
    status === 'active' &&
    (operation !== 'migrate' ||
      phase !== 'activate' ||
      (sourceKind === 'file'
        ? retiredSha256 === undefined
        : raw.sourceAbsenceVerified !== true) ||
      rollback !== undefined ||
      cancelled)
  )
    throw new AccountMigrationError('active receipt is incomplete')
  if (operation === 'rollback' && rollback === undefined && !cancelled)
    throw new AccountMigrationError(
      'rollback lacks its current-credential snapshot',
    )
  if (
    operation === 'rollback' &&
    !cancelled &&
    (verification === undefined ||
      (sourceKind === 'file'
        ? retiredSha256 === undefined
        : raw.sourceAbsenceVerified !== true))
  )
    throw new AccountMigrationError(
      'rollback lacks the original verified retirement',
    )
  if (
    status === 'inactive' &&
    !cancelled &&
    (operation !== 'rollback' || phase !== 'activate' || rollback === undefined)
  )
    throw new AccountMigrationError(
      'inactive receipt lacks a completed rollback',
    )
  if (
    operation === 'rollback' &&
    (phase === 'activate' || status === 'inactive') &&
    !cancelled &&
    !rollback?.successorInactive
  )
    throw new AccountMigrationError(
      'rollback restoration preceded successor inactivity',
    )
  return {
    schemaVersion: 1,
    id,
    legacyPath: paths.legacyPath,
    storeDir: paths.storeDir,
    status,
    operation,
    phase,
    sourceKind,
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    ...(captureSha256 === undefined ? {} : { captureSha256 }),
    ...(raw.sourceAbsenceVerified === true
      ? { sourceAbsenceVerified: true }
      : {}),
    manifest,
    mapping,
    completedRows,
    ...(ownedTemps === undefined ? {} : { ownedTemps }),
    ...(verification === undefined ? {} : { verification }),
    ...(retiredSha256 === undefined ? {} : { retiredSha256 }),
    ...(rollback === undefined ? {} : { rollback }),
    ...(cancelled ? { cancelled: true } : {}),
  }
}

export interface AccountMigrationOptions {
  legacyPath: string
  /** Caller acknowledgment that concurrent Antigravity writers and timers were stopped before migration/rollback; it is not a process-liveness probe. */
  offline: { processesStopped: true }
  now: () => number
  /** Awaited observation of actual durable phase/public-write boundaries for crash tests, never a replacement store or filesystem implementation. */
  onBoundary?: (boundary: string) => void | Promise<void>
}
type MigrationPhaseOptions = Pick<AccountMigrationOptions, 'now' | 'onBoundary'>
export interface AccountMigrationReceipt {
  id: string
  status: 'active' | 'inactive'
  legacyPath: string
  storeDir: string
  sourceKind: 'file' | 'absent'
  durability: MigrationVerification['durability']
  restartRequired: boolean
}
export type AccountMigrationOutcome =
  | { status: 'completed'; receipt: AccountMigrationReceipt }
  | { status: 'pending'; reason: 'lock-contention' | 'ownership-lost' }

function pendingLockFailure(
  modules: AccountMigrationModules,
  error: unknown,
): Extract<AccountMigrationOutcome, { status: 'pending' }> | undefined {
  if (error instanceof modules.fs.LockContentionError)
    return { status: 'pending', reason: 'lock-contention' }
  if (error instanceof modules.fs.LockOwnershipError)
    return { status: 'pending', reason: 'ownership-lost' }
  if (error instanceof modules.store.PoolOperationError && error.retryable) {
    if (error.kind === 'lock-contention')
      return { status: 'pending', reason: 'lock-contention' }
    if (error.kind === 'lock-ownership')
      return { status: 'pending', reason: 'ownership-lost' }
  }
  return undefined
}

function errno(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}
function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errno(error) === 'ENOENT') return false
    throw error
  }
}
function privateMode(mode: number, expected: number): void {
  // Windows may ignore mode bits. They are attempted on creation but do not
  // prove DACL privacy; operators must secure their custom directory's ACLs.
  if (process.platform !== 'win32' && (mode & 0o777) !== expected)
    throw new AccountMigrationError(
      'insecure POSIX file or directory permissions',
    )
}
async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AccountMigrationError(
      'successor directory is not a regular directory',
    )
  privateMode(stat.mode, 0o700)
  if (!sameFilesystemPath(await realpath(path), path))
    throw new AccountMigrationError(
      'successor directory traverses a symbolic link',
    )
}
async function prepareDirectories(paths: AccountStorePaths): Promise<void> {
  if (
    !sameFilesystemPath(
      await realpath(dirname(paths.legacyPath)),
      dirname(paths.legacyPath),
    )
  )
    throw new AccountMigrationError('legacy parent traverses a symbolic link')
  for (const path of [
    paths.storeDir,
    paths.backupsDir,
    paths.retiredDir,
    paths.transfersDir,
  ])
    await privateDirectory(path)
}
async function secureRead(path: string): Promise<Buffer> {
  if (!sameFilesystemPath(await realpath(dirname(path)), dirname(path)))
    throw new AccountMigrationError('file path traverses a symbolic link')
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink())
    throw new AccountMigrationError(
      'credential-bearing path is not a regular file',
    )
  privateMode(before.mode, 0o600)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    )
      throw new AccountMigrationError('file identity changed while opening')
    const bytes = await handle.readFile()
    const after = await lstat(path)
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.isSymbolicLink()
    )
      throw new AccountMigrationError('file identity changed while reading')
    return bytes
  } finally {
    await handle.close()
  }
}
function jsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new AccountMigrationError('malformed or non-UTF8 durable JSON')
  }
}
async function syncFile(path: string): Promise<void> {
  await secureRead(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await secureRead(path)
}
export function accountMigrationDurability(
  platform: NodeJS.Platform = process.platform,
): MigrationVerification['durability'] {
  return platform === 'win32'
    ? 'windows-reopened-no-directory-power-loss-guarantee'
    : 'posix-directory-synced'
}
async function syncDirectory(
  path: string,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<void> {
  if (process.platform === 'win32') return
  await boundary?.('before-directory-sync')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await boundary?.('after-directory-sync')
}
async function exclusiveBytes(
  path: string,
  bytes: Buffer,
  expectedHash: string,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error
  }
  if (handle !== undefined) {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  // Reuse a backup, retired copy or export stage only after comparing reopened
  // bytes, expected SHA256 and restrictive mode; a matching filename is insufficient.
  const reopened = await secureRead(path)
  if (digest(reopened) !== expectedHash || !reopened.equals(bytes))
    throw new AccountMigrationError('exclusive backup or recovery copy differs')
  await syncFile(path)
  await syncDirectory(dirname(path), boundary)
}
async function readJournal(
  paths: AccountStorePaths,
): Promise<AccountMigrationJournal | undefined> {
  if (!(await exists(paths.storeDir))) return undefined
  const directory = await lstat(paths.storeDir)
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !sameFilesystemPath(await realpath(paths.storeDir), paths.storeDir)
  )
    throw new AccountMigrationError(
      'journal directory is an alias or non-directory',
    )
  privateMode(directory.mode, 0o700)
  if (!(await exists(paths.migrationPath))) return undefined
  const journal = decodeAccountMigrationJournal(
    jsonBytes(await secureRead(paths.migrationPath)),
  )
  if (
    journal.legacyPath !== paths.legacyPath ||
    journal.storeDir !== paths.storeDir
  )
    throw new AccountMigrationError('journal belongs to another source')
  return journal
}
async function saveJournal(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  journal: AccountMigrationJournal,
  initial: boolean | string = false,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<void> {
  decodeAccountMigrationJournal(journalJson(journal))
  const stage = journal.id
  const journalTemp = `${paths.migrationPath}.${stage}.tmp`
  if (await exists(journalTemp)) {
    const current = await readJournal(paths)
    if (current?.id !== journal.id)
      throw new AccountMigrationError(
        'journal staging file has no durable generation owner',
      )
    await secureRead(journalTemp)
    await lease.assertOwned()
    await unlink(journalTemp)
  }
  await lease.assertOwned()
  await modules.fs.writeJsonAtomic(paths.migrationPath, journalJson(journal), {
    stageName: () => stage,
    beforeRename: async () => {
      await lease.assertOwned()
      const current = await readJournal(paths)
      const owned =
        typeof initial === 'string'
          ? current?.id === initial && current.status === 'inactive'
          : initial
            ? current === undefined
            : current?.id === journal.id
      if (!owned)
        throw new AccountMigrationError(
          'journal ownership changed before write',
        )
      await syncFile(`${paths.migrationPath}.${stage}.tmp`)
      await lease.assertOwned()
    },
  })
  await syncFile(paths.migrationPath)
  await syncDirectory(paths.storeDir, boundary)
  const reopened = await readJournal(paths)
  if (
    !reopened ||
    !isDeepStrictEqual(journalJson(reopened), journalJson(journal))
  )
    throw new AccountMigrationError('journal readback differs')
  await lease.assertOwned()
}
function openMigrationStore(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  now: () => number,
  onStep?: (
    step: MigrationPublicWriteStep,
    info: { operation: string; rowId: string | undefined },
  ) => void | Promise<void>,
): MigrationPoolStore {
  return modules.store.openPoolStore({
    provider: ACCOUNT_STORE_PROVIDER,
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: QUOTA_CODEC,
    providerState: {
      validate: isValidProviderState,
      credentialBound: providerStateCredentialBound,
      merge(previous, incoming) {
        // A retry may finish a credential written before its roster row. Recorded
        // and incoming provider state must be identical; differences do not authorize
        // combining metadata or overwriting another credential context.
        if (!isDeepStrictEqual(previous, incoming))
          throw new AccountMigrationError(
            'retry provider state differs from captured manifest',
          )
        return incoming
      },
      onReplace() {
        throw new AccountMigrationError(
          'offline migration never replaces a credential',
        )
      },
    },
    requireCredentialStamps: true,
    now,
    lockOptions: { timeoutMs: 2_000 },
    ...(onStep === undefined ? {} : { onStep }),
  })
}
async function rowsOf(
  store: Pick<MigrationPoolStore, 'read'>,
): Promise<MigrationPoolRow[]> {
  const read = await store.read()
  if (read.status !== 'ready')
    throw new AccountMigrationError('successor is not a ready public store')
  return read.rows
}
async function settingsOf(
  store: Pick<MigrationPoolStore, 'readSettings'>,
): Promise<Record<string, unknown>> {
  const read = await store.readSettings()
  if (read.status !== 'ready')
    throw new AccountMigrationError('successor settings are not ready')
  return read.settings
}
function rowRef(row: MigrationPoolRow): RowRef {
  const epoch = row.credentialEpoch ?? 1
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new AccountMigrationError('invalid credential epoch')
  return {
    id: row.id,
    credentialEpoch: epoch,
    ...(row.identity === undefined ? {} : { identity: row.identity }),
  }
}
function healthyRow(row: MigrationPoolRow, allowTorn = false): void {
  if (
    row.type !== 'oauth' ||
    row.credential?.type !== 'oauth' ||
    !row.credential.refresh.length ||
    row.hasEntry !== true ||
    row.stamp !== 'bound' ||
    (row.torn && !allowTorn) ||
    row.unbound ||
    row.invalid ||
    row.providerStateDropped ||
    row.providerState === undefined ||
    (row.enabled && !row.candidate && !(allowTorn && row.torn))
  )
    throw new AccountMigrationError(
      'successor row is missing, unbound, invalid, torn or dropped',
    )
  rowRef(row)
  decodeProviderState(row.providerState)
  if (row.quota !== undefined) decodeQuotaState(row.quota)
}
function expectedRouting(
  journal: AccountMigrationJournal,
  rows: readonly MigrationPoolRow[],
): RoutingSettings {
  const routing = { ...journal.manifest.routing }
  const active = rows[journal.manifest.effectiveActiveIndex]
  if (active !== undefined) routing.activeRow = rowRef(active)
  const family = journal.manifest.routing.activeIndexByFamily
  const refs: NonNullable<RoutingSettings['activeRowByFamily']> = {}
  for (const name of ['claude', 'gemini'] as const) {
    const cursor = family?.[name] ?? journal.manifest.effectiveActiveIndex
    const row = rows.length ? rows[cursor % rows.length] : undefined
    if (row !== undefined) refs[name] = rowRef(row)
  }
  if (Object.keys(refs).length) routing.activeRowByFamily = refs
  return routing
}
function assertImportedRow(
  row: MigrationPoolRow,
  manifest: LegacyAccountManifest,
  id: string,
): void {
  healthyRow(row)
  if (
    row.id !== id ||
    row.identity !== undefined ||
    rowRef(row).credentialEpoch !== 1 ||
    row.credential?.type !== 'oauth' ||
    row.credential.refresh !== manifest.refreshToken ||
    row.credential.access !== undefined ||
    row.credential.expires !== undefined ||
    row.enabled !== (manifest.metadata.enabled !== false)
  )
    throw new AccountMigrationError(
      'successor credential, lineage, identity or enabled flag differs from manifest',
    )
  const metadata = decodeProviderState(row.providerState)
  if (
    !isDeepStrictEqual(
      encodeProviderState(metadata),
      encodeProviderState({ schemaVersion: 1, metadata: manifest.metadata }),
    ) ||
    !isDeepStrictEqual(
      row.quota,
      manifest.quota === undefined
        ? undefined
        : encodeQuotaState(manifest.quota),
    )
  )
    throw new AccountMigrationError(
      'successor full metadata, quota or presence differs from manifest',
    )
}
async function verifyImported(
  store: MigrationPoolStore,
  journal: AccountMigrationJournal,
): Promise<void> {
  await assertStateOwnership(
    generationPaths(journal.legacyPath, journal.id),
    journal,
    true,
  )
  const rows = await rowsOf(store)
  if (rows.length !== journal.mapping.length)
    throw new AccountMigrationError(
      'successor roster length differs from manifest',
    )
  rows.forEach((row, index) => {
    const mapped = journal.mapping[index]
    const manifest = journal.manifest.accounts[index]
    if (!mapped || !manifest)
      throw new AccountMigrationError(
        'successor manifest mapping is incomplete',
      )
    assertImportedRow(row, manifest, mapped.id)
  })
  const settings = await settingsOf(store)
  if (
    !isDeepStrictEqual(
      decodeAccountStoreGeneration(
        settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY],
      ),
      generationJson(journal),
    )
  )
    throw new AccountMigrationError('successor generation differs from journal')
  if (
    !isDeepStrictEqual(
      settings[ROUTING_SETTINGS_KEY],
      encodeRoutingSettings(expectedRouting(journal, rows)),
    )
  )
    throw new AccountMigrationError(
      'successor order or cursor presence differs from manifest',
    )
}
async function verifyCopies(
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
  retired: boolean,
): Promise<void> {
  if (journal.sourceKind === 'absent') {
    for (const directory of [paths.backupsDir, paths.retiredDir])
      if ((await readdir(directory)).length)
        throw new AccountMigrationError(
          'absent source has unrelated backup or retired artifacts',
        )
    return
  }
  const backup = await secureRead(
    join(paths.backupsDir, `${journal.sourceSha256}.json`),
  )
  if (digest(backup) !== journal.sourceSha256)
    throw new AccountMigrationError('backup independent digest differs')
  const capture = await secureRead(
    join(paths.transfersDir, `${journal.id}.capture.json`),
  )
  if (
    digest(capture) !== journal.captureSha256 ||
    !isDeepStrictEqual(jsonBytes(capture), captureJson(journal))
  )
    throw new AccountMigrationError(
      'journal differs from its exclusive capture snapshot',
    )
  // Original backup JSON and the captured time reproduce the expected import.
  // Compare that value with the journal without changing its selected rows, clock,
  // source positions or UUID mapping.
  const expected = parseLegacyAccountStorage(
    new TextDecoder('utf-8', { fatal: true }).decode(backup),
    journal.manifest.normalizationClock,
  )
  if (
    !isDeepStrictEqual(manifestJson(expected), manifestJson(journal.manifest))
  )
    throw new AccountMigrationError(
      'captured manifest differs from its verified original source',
    )
  if (retired) {
    const bytes = await secureRead(join(paths.retiredDir, `${journal.id}.json`))
    if (!bytes.equals(backup) || digest(bytes) !== journal.retiredSha256)
      throw new AccountMigrationError(
        'retired copy and backup association differs',
      )
  }
}
function captureJson(journal: AccountMigrationJournal) {
  return {
    schemaVersion: 1,
    id: journal.id,
    legacyPath: journal.legacyPath,
    storeDir: journal.storeDir,
    sourceKind: journal.sourceKind,
    sourceSha256: journal.sourceSha256,
    manifest: manifestJson(journal.manifest),
    mapping: journal.mapping,
  }
}
async function synchronizedSnapshot(
  paths: AccountStorePaths,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<{ config: Buffer; state?: Buffer }> {
  await syncFile(paths.configPath)
  const statePresent = await exists(paths.statePath)
  if (statePresent) await syncFile(paths.statePath)
  await syncDirectory(paths.storeDir, boundary)
  return {
    config: await secureRead(paths.configPath),
    ...(statePresent ? { state: await secureRead(paths.statePath) } : {}),
  }
}

async function assertStateOwnership(
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
  complete: boolean,
): Promise<void> {
  if (complete) {
    const config = object(
      jsonBytes(await secureRead(paths.configPath)),
      'successor config',
    )
    const pool = object(config.commonAuthPool, 'successor pool')
    const entries = object(pool.rows, 'successor entries')
    if (
      Object.keys(entries).length !== journal.mapping.length ||
      Object.keys(entries).some(
        (id) => !journal.mapping.some((row) => row.id === id),
      )
    )
      throw new AccountMigrationError(
        'native entry presence differs from manifest',
      )
    const retired =
      pool.retiredEpochs === undefined
        ? {}
        : object(pool.retiredEpochs, 'retired epochs')
    journal.mapping.forEach((mapped, index) => {
      const entry = object(entries[mapped.id], 'successor entry')
      const quota = journal.manifest.accounts[index]?.quota
      if (
        entry.credentialEpoch !== 1 ||
        Object.hasOwn(retired, mapped.id) ||
        Object.hasOwn(entry, 'quota') !== (quota !== undefined) ||
        (quota !== undefined &&
          !isDeepStrictEqual(entry.quota, encodeQuotaState(quota)))
      )
        throw new AccountMigrationError(
          'native epoch or full quota presence differs from manifest',
        )
    })
  }
  if (!(await exists(paths.statePath))) {
    if (complete && journal.mapping.length)
      throw new AccountMigrationError('successor state is missing')
    return
  }
  const state = object(
    jsonBytes(await secureRead(paths.statePath)),
    'successor state',
  )
  const accounts =
    state.accounts === undefined
      ? {}
      : object(state.accounts, 'successor state accounts')
  const ids = Object.keys(accounts)
  if (
    ids.some((id) => !journal.mapping.some((row) => row.id === id)) ||
    (complete && ids.length !== journal.mapping.length)
  )
    throw new AccountMigrationError(
      'successor state contains unrelated or missing credentials',
    )
}
async function management(
  store: MigrationPoolStore,
  journal: AccountMigrationJournal,
  clear = false,
): Promise<void> {
  const targets = journal.rollback?.rows ?? journal.mapping.map((row) => row.id)
  await store.updateSettings((settings) => {
    const prior = settings[MANAGEMENT_SETTINGS_KEY]
    if (prior !== undefined) {
      const p = object(prior, 'management')
      if (
        p.id !== journal.id ||
        p.kind !== 'migration' ||
        !isDeepStrictEqual(p.targets, targets)
      )
        throw new AccountMigrationError(
          'management settings belong to another operation',
        )
    }
    if (clear) delete settings[MANAGEMENT_SETTINGS_KEY]
    else
      settings[MANAGEMENT_SETTINGS_KEY] = {
        id: journal.id,
        kind: 'migration',
        targets,
        progress: {
          step: journal.phase,
          completedTargets:
            journal.operation === 'rollback' ? [] : journal.completedRows,
        },
      }
    return settings
  })
}
function receipt(journal: AccountMigrationJournal): AccountMigrationReceipt {
  if (journal.status === 'pending')
    throw new AccountMigrationError('pending journal has no serving receipt')
  return {
    id: journal.id,
    status: journal.status,
    legacyPath: journal.legacyPath,
    storeDir: journal.storeDir,
    sourceKind: journal.sourceKind,
    durability:
      journal.verification?.durability ?? accountMigrationDurability(),
    restartRequired:
      journal.sourceKind === 'file' || journal.operation === 'rollback',
  }
}
async function currentSuccessor(
  store: Pick<MigrationPoolStore, 'read' | 'readSettings'>,
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
): Promise<void> {
  const config = object(
    jsonBytes(await secureRead(paths.configPath)),
    'active config',
  )
  if (config.version !== 1 || !Array.isArray(config.accounts))
    throw new AccountMigrationError('active config lacks its native roster')
  const pool = object(config.commonAuthPool, 'active native pool')
  if (pool.schemaVersion !== 1)
    throw new AccountMigrationError('active native pool schema differs')
  const entries = object(pool.rows, 'active entries')
  if (pool.retiredEpochs !== undefined) {
    for (const [id, epoch] of Object.entries(
      object(pool.retiredEpochs, 'retained epochs'),
    )) {
      if (
        !UUID.test(id) ||
        !Number.isSafeInteger(epoch) ||
        typeof epoch !== 'number' ||
        epoch < 1
      )
        throw new AccountMigrationError('retained epoch record is invalid')
    }
  }
  const nativeIds = config.accounts.map((item) =>
    text(object(item, 'active roster row').id, UUID, 'active row id'),
  )
  if (
    new Set(nativeIds).size !== nativeIds.length ||
    Object.keys(entries).length !== nativeIds.length ||
    Object.keys(entries).some((id) => !nativeIds.includes(id))
  )
    throw new AccountMigrationError(
      'active native entry/roster presence differs',
    )
  let stateAccounts: Record<string, unknown> = {}
  if (await exists(paths.statePath)) {
    const state = object(
      jsonBytes(await secureRead(paths.statePath)),
      'active state',
    )
    if (state.version !== 1)
      throw new AccountMigrationError('active native state schema differs')
    stateAccounts = object(state.accounts, 'active state accounts')
  }
  if (
    Object.keys(stateAccounts).length !== nativeIds.length ||
    Object.keys(stateAccounts).some((id) => !nativeIds.includes(id))
  )
    throw new AccountMigrationError(
      'active state contains orphan or missing credentials',
    )
  const rows = await rowsOf(store)
  if (
    !isDeepStrictEqual(
      rows.map((row) => row.id),
      nativeIds,
    )
  )
    throw new AccountMigrationError(
      'public and native active roster order differs',
    )
  rows.forEach((row) => {
    healthyRow(row)
    const entry = object(entries[row.id], 'active native entry')
    if (
      entry.credentialEpoch !== rowRef(row).credentialEpoch ||
      Object.hasOwn(entry, 'quota') !== (row.quota !== undefined) ||
      (row.quota !== undefined && !isDeepStrictEqual(entry.quota, row.quota))
    )
      throw new AccountMigrationError(
        'active native epoch or quota presence differs from public row',
      )
  })
  const settings = await settingsOf(store)
  if (
    !isDeepStrictEqual(
      decodeAccountStoreGeneration(
        settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY],
      ),
      generationJson(journal),
    )
  )
    throw new AccountMigrationError(
      'active generation setting differs from journal',
    )
  decodeRoutingSettings(settings[ROUTING_SETTINGS_KEY])
}

export type AccountStoreAdmission =
  | {
      status: 'active'
      receipt: AccountMigrationReceipt
      paths: AccountStorePaths
    }
  | {
      status: 'pending'
      phase?: AccountMigrationPhase
      operation?: 'migrate' | 'rollback'
    }
  | { status: 'inactive'; id: string }
  | { status: 'initialization-required' }
  | { status: 'error'; reason: string }

export type AccountStoreBinding =
  | Exclude<AccountStoreAdmission, { status: 'active' }>
  | {
      status: 'bound'
      receipt: AccountMigrationReceipt
      paths: AccountStorePaths
    }
function openAdmissionStore(
  modules: AccountStoreAdmissionModules,
  paths: AccountStorePaths,
  now: () => number,
) {
  return modules.store.openPoolStore({
    provider: ACCOUNT_STORE_PROVIDER,
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: QUOTA_CODEC,
    providerState: {
      validate: isValidProviderState,
      credentialBound: providerStateCredentialBound,
      merge() {
        throw new AccountMigrationError(
          'binding/admission performs no provider-state writes',
        )
      },
      onReplace() {
        throw new AccountMigrationError(
          'binding/admission performs no credential replacements',
        )
      },
    },
    requireCredentialStamps: true,
    now,
  })
}
async function trustedCurrentGeneration(
  store: Pick<MigrationPoolStore, 'read' | 'readSettings'>,
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
): Promise<Record<string, unknown>> {
  const config = object(
    jsonBytes(await secureRead(paths.configPath)),
    'bound config',
  )
  if (config.version !== 1 || !Array.isArray(config.accounts))
    throw new AccountMigrationError('bound config lacks its native roster')
  const pool = object(config.commonAuthPool, 'bound native pool')
  if (pool.schemaVersion !== 1)
    throw new AccountMigrationError('bound native pool schema differs')
  object(pool.rows, 'bound native entries')
  if (await exists(paths.statePath)) {
    const state = object(
      jsonBytes(await secureRead(paths.statePath)),
      'bound native state',
    )
    if (state.version !== 1)
      throw new AccountMigrationError('bound native state schema differs')
    object(state.accounts, 'bound state accounts')
  }
  const settings = await settingsOf(store)
  if (
    !isDeepStrictEqual(
      decodeAccountStoreGeneration(
        settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY],
      ),
      generationJson(journal),
    )
  )
    throw new AccountMigrationError(
      'bound generation setting differs from completed journal',
    )
  return settings
}
/** A bound result establishes completed-generation ownership for repository recovery, not readiness to select or route credentials. */
export async function readAccountStoreBinding(
  legacyPath: string,
  modules: AccountStoreAdmissionModules,
  now: () => number,
  expectedGeneration?: string,
): Promise<AccountStoreBinding> {
  try {
    const paths = await resolvePublishedAccountStorePaths(legacyPath)
    if (!paths)
      return (await exists(legacyPath))
        ? { status: 'pending' }
        : { status: 'initialization-required' }
    const journal = await readJournal(paths)
    if (!journal)
      throw new AccountMigrationError('published binding journal missing')
    if (expectedGeneration !== undefined && journal.id !== expectedGeneration)
      throw new AccountMigrationError(
        'bound repository generation differs from pointer',
      )
    if (journal.status === 'pending' || journal.ownedTemps?.length)
      return {
        status: 'pending',
        phase: journal.phase,
        operation: journal.operation,
      }
    if (journal.status === 'inactive')
      return { status: 'inactive', id: journal.id }
    if (await exists(legacyPath))
      throw new AccountMigrationError(
        'legacy source was recreated after activation',
      )
    await verifyCopies(paths, journal, true)
    const settings = await trustedCurrentGeneration(
      openAdmissionStore(modules, paths, now),
      paths,
      journal,
    )
    const pending = settings[MANAGEMENT_SETTINGS_KEY]
    if (pending !== undefined) {
      const record = object(pending, 'repository management')
      if (record.kind === 'migration')
        return { status: 'pending', phase: 'activate', operation: 'migrate' }
      if (record.kind !== 'clear' && record.kind !== 'replace-pool')
        throw new AccountMigrationError(
          'unknown management owner prevents binding',
        )
      // Ownership permits opening these physical paths. The repository must then
      // validate and resume its own strict clear/replace journal; this binding
      // neither validates that operation nor grants credential-serving readiness.
    }
    return { status: 'bound', receipt: receipt(journal), paths }
  } catch (error) {
    return {
      status: 'error',
      reason:
        error instanceof AccountMigrationError
          ? error.reason
          : 'journal, backup or generation binding validation failed',
    }
  }
}
/** Serving requires healthy current rows and no repository management work. Binding alone is insufficient. */
export async function readAccountStoreAdmission(
  legacyPath: string,
  modules: AccountStoreAdmissionModules,
  now: () => number,
  expectedGeneration?: string,
): Promise<AccountStoreAdmission> {
  const binding = await readAccountStoreBinding(
    legacyPath,
    modules,
    now,
    expectedGeneration,
  )
  if (binding.status !== 'bound') return binding
  try {
    const journal = await readJournal(binding.paths)
    if (!journal)
      throw new AccountMigrationError('active serving journal missing')
    const store = openAdmissionStore(modules, binding.paths, now)
    await currentSuccessor(store, binding.paths, journal)
    if ((await settingsOf(store))[MANAGEMENT_SETTINGS_KEY] !== undefined)
      return { status: 'pending' }
    return { status: 'active', receipt: binding.receipt, paths: binding.paths }
  } catch (error) {
    return {
      status: 'error',
      reason:
        error instanceof AccountMigrationError
          ? error.reason
          : 'current credential serving validation failed',
    }
  }
}

/** Legacy-write guard: canonical pointer/journal errors and pending or active generation receipts refuse old-format writes under the accounts lease. */
export async function assertLegacyAccountStorageWritable(
  legacyPath: string,
): Promise<void> {
  const paths = await resolvePublishedAccountStorePaths(resolve(legacyPath))
  if (paths === undefined) return
  const journal = await readJournal(paths)
  if (
    journal === undefined &&
    ((await exists(paths.configPath)) || (await exists(paths.statePath)))
  )
    throw new AccountMigrationError(
      'unowned successor files refuse legacy writes',
    )
  if (journal !== undefined && journal.status !== 'inactive')
    throw new AccountMigrationError(
      'legacy storage is owned by the account store; use offline rollback before old-build writes',
    )
}

async function capture(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  options: MigrationPhaseOptions,
  previous?: AccountMigrationJournal,
): Promise<AccountMigrationJournal> {
  await options.onBoundary?.('before-capture')
  const captured = await modules.fs.withLock(
    paths.legacyPath,
    { name: 'accounts', ttlMs: 10_000, timeoutMs: 2_000, renew: true },
    async (accountsLease) => {
      await accountsLease.assertOwned()
      await lease.assertOwned()
      const bytes = await secureRead(paths.legacyPath)
      const manifest = parseLegacyAccountStorage(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        options.now(),
      )
      const sourceSha256 = digest(bytes)
      await options.onBoundary?.('capture:before-backup')
      await exclusiveBytes(
        join(paths.backupsDir, `${sourceSha256}.json`),
        bytes,
        sourceSha256,
        options.onBoundary,
      )
      const journal: AccountMigrationJournal = {
        schemaVersion: 1,
        id: pathGenerationId(paths),
        legacyPath: paths.legacyPath,
        storeDir: paths.storeDir,
        status: 'pending',
        operation: 'migrate',
        phase: 'capture',
        sourceKind: 'file',
        sourceSha256,
        manifest,
        mapping: manifest.accounts.map((row) => ({
          id: randomUUID(),
          ordinal: row.ordinal,
        })),
        completedRows: [],
      }
      const captureBytes = Buffer.from(
        `${JSON.stringify(captureJson(journal), null, 2)}\n`,
      )
      journal.captureSha256 = digest(captureBytes)
      await exclusiveBytes(
        join(paths.transfersDir, `${journal.id}.capture.json`),
        captureBytes,
        journal.captureSha256,
        options.onBoundary,
      )
      await accountsLease.assertOwned()
      await lease.assertOwned()
      if (previous !== undefined) {
        // Retain the previous journal UUID and full durable record before a new
        // generation captures the restored legacy file.
        const archived = Buffer.from(
          `${JSON.stringify(journalJson(previous), null, 2)}\n`,
        )
        await exclusiveBytes(
          join(paths.transfersDir, `${previous.id}.journal.json`),
          archived,
          digest(archived),
          options.onBoundary,
        )
      }
      await saveJournal(
        modules,
        paths,
        lease,
        journal,
        true,
        options.onBoundary,
      )
      return journal
    },
  )
  return captured
}
async function build(
  store: MigrationPoolStore,
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  journal: AccountMigrationJournal,
  options: MigrationPhaseOptions,
): Promise<void> {
  await options.onBoundary?.('before-build')
  await assertStateOwnership(paths, journal, false)
  if (!journal.mapping.length && !(await exists(paths.configPath))) {
    // Public initialize leaves a missing config alone. An empty import first
    // exclusively creates the native {version:1,accounts:[]} config it requires.
    const bootstrap = Buffer.from('{"version":1,"accounts":[]}\n')
    await exclusiveBytes(
      paths.configPath,
      bootstrap,
      digest(bootstrap),
      options.onBoundary,
    )
  }
  await store.initialize()
  const known = await rowsOf(store)
  if (
    known.some((row) => !journal.mapping.some((mapped) => mapped.id === row.id))
  )
    throw new AccountMigrationError('build found unrelated successor rows')
  for (let index = 0; index < journal.mapping.length; index++) {
    const mapped = journal.mapping[index]
    const source = journal.manifest.accounts[index]
    if (!mapped || !source)
      throw new AccountMigrationError('captured row mapping is incomplete')
    await lease.assertOwned()
    const before = (await rowsOf(store)).find((row) => row.id === mapped.id)
    if (journal.completedRows.includes(mapped.id)) {
      if (!before)
        throw new AccountMigrationError(
          'acknowledged successor row disappeared',
        )
      assertImportedRow(before, source, mapped.id)
      continue
    }
    if (before === undefined) {
      const result = await store.add(
        {
          id: mapped.id,
          credential: { type: 'oauth', refresh: source.refreshToken },
          providerState: encodeProviderState({
            schemaVersion: 1,
            metadata: source.metadata,
          }),
        },
        { extraLocks: [legacyAccountsLock(paths.legacyPath)] },
      )
      if (result.id !== mapped.id)
        throw new AccountMigrationError(
          'public add deduplicated onto an unrelated UUID',
        )
    } else {
      // Validate the recorded credential epoch/identity and let public enable/disable
      // finish an interrupted state/config transition without starting a new epoch.
      healthyRow(before, true)
      if (
        before.credential?.type !== 'oauth' ||
        before.credential.refresh !== source.refreshToken
      )
        throw new AccountMigrationError(
          'unacknowledged row differs from captured credential',
        )
    }
    const row = (await rowsOf(store)).find(
      (candidate) => candidate.id === mapped.id,
    )
    if (!row) throw new AccountMigrationError('public add has no successor row')
    const fence = rowRef(row)
    if (source.metadata.enabled === false)
      await store.disable(mapped.id, 'legacy-disabled', {
        attribution: fence,
        extraLocks: [legacyAccountsLock(paths.legacyPath)],
      })
    else if (row.torn || !row.enabled)
      await store.enable(mapped.id, {
        attribution: fence,
        extraLocks: [legacyAccountsLock(paths.legacyPath)],
      })
    if (source.quota !== undefined) {
      const fresh = (await rowsOf(store)).find(
        (candidate) => candidate.id === mapped.id,
      )
      if (!fresh)
        throw new AccountMigrationError('quota successor row disappeared')
      await store.recordQuota(
        mapped.id,
        rowRef(fresh),
        encodeQuotaState(source.quota),
      )
    }
    const actual = (await rowsOf(store)).find(
      (candidate) => candidate.id === mapped.id,
    )
    if (!actual) throw new AccountMigrationError('imported row disappeared')
    assertImportedRow(actual, source, mapped.id)
    journal.completedRows.push(mapped.id)
    await saveJournal(modules, paths, lease, journal, false, options.onBoundary)
    await management(store, journal)
  }
  await store.reorder(journal.mapping.map((row) => row.id))
  const routing = expectedRouting(journal, await rowsOf(store))
  await store.updateSettings((settings) => {
    settings[ROUTING_SETTINGS_KEY] = encodeRoutingSettings(routing)
    return settings
  })
  await store.updateSettings((settings) => {
    const prior = settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY]
    if (
      prior !== undefined &&
      !isDeepStrictEqual(
        decodeAccountStoreGeneration(prior),
        generationJson(journal),
      )
    )
      throw new AccountMigrationError(
        'build cannot overwrite another generation',
      )
    settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY] = generationJson(journal)
    return settings
  })
  await management(store, journal)
  await options.onBoundary?.('after-build')
}
async function verify(
  store: MigrationPoolStore,
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
  options: MigrationPhaseOptions,
): Promise<void> {
  await options.onBoundary?.('before-verify')
  await verifyCopies(paths, journal, false)
  await assertStateOwnership(paths, journal, true)
  await verifyImported(store, journal)
  const snapshot = await synchronizedSnapshot(paths, options.onBoundary)
  await verifyImported(store, journal)
  journal.verification = {
    manifestSha256: digest(canonical(manifestJson(journal.manifest))),
    configSha256: digest(snapshot.config),
    ...(snapshot.state === undefined
      ? {}
      : { stateSha256: digest(snapshot.state) }),
    statePresent: snapshot.state !== undefined,
    durability: accountMigrationDurability(),
  }
  await options.onBoundary?.('after-verify')
}
async function retire(
  store: MigrationPoolStore,
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  journal: AccountMigrationJournal,
  options: MigrationPhaseOptions,
): Promise<void> {
  await options.onBoundary?.('before-retire')
  // Verify imported store fields before taking the legacy accounts lock: public
  // row operations acquire row/provider/extra locks before their save locks, so
  // capture/retirement must not enclose those operations in an accounts lease.
  await verifyImported(store, journal)
  await assertStateOwnership(paths, journal, true)
  await synchronizedSnapshot(paths, options.onBoundary)
  await verifyImported(store, journal)
  await verifyCopies(paths, journal, false)
  const sourceSha256 = journal.sourceSha256
  if (journal.sourceKind !== 'file' || sourceSha256 === undefined)
    throw new AccountMigrationError(
      'file retirement requires a captured source hash',
    )
  await modules.fs.withLock(
    paths.legacyPath,
    { name: 'accounts', ttlMs: 10_000, timeoutMs: 2_000, renew: true },
    async (accountsLease) => {
      await lease.assertOwned()
      await accountsLease.assertOwned()
      const retiredPath = join(paths.retiredDir, `${journal.id}.json`)
      if (await exists(paths.legacyPath)) {
        const source = await secureRead(paths.legacyPath)
        if (digest(source) !== sourceSha256)
          throw new AccountMigrationError('legacy source changed since capture')
        await exclusiveBytes(
          retiredPath,
          source,
          sourceSha256,
          options.onBoundary,
        )
        await lease.assertOwned()
        await accountsLease.assertOwned()
        if (digest(await secureRead(paths.legacyPath)) !== journal.sourceSha256)
          throw new AccountMigrationError('legacy source changed before unlink')
        await syncDirectory(dirname(paths.legacyPath), options.onBoundary)
        await lease.assertOwned()
        await accountsLease.assertOwned()
        await unlink(paths.legacyPath)
      } else {
        // If the original legacy file is absent, require this journal UUID's retired
        // legacy copy to independently match the captured source SHA256 before resuming.
        if (
          !journal.verification ||
          digest(await secureRead(retiredPath)) !== journal.sourceSha256
        )
          throw new AccountMigrationError(
            'missing source has no verified retirement association',
          )
      }
      try {
        await syncDirectory(dirname(paths.legacyPath), options.onBoundary)
      } catch (error) {
        await lease.assertOwned()
        await accountsLease.assertOwned()
        if (!(await exists(paths.legacyPath))) {
          // A directory-sync failure after unlink cannot acknowledge retirement.
          // Restore the verified bytes only if the legacy path is still absent;
          // never overwrite a file another writer recreated at that path.
          try {
            const recovery = await secureRead(retiredPath)
            await exclusiveBytes(paths.legacyPath, recovery, sourceSha256)
          } catch {
            throw new AccountMigrationError(
              'retirement directory sync failed; verified recovery copies retained and exclusive source restoration could not be acknowledged',
            )
          }
        }
        throw error
      }
      journal.retiredSha256 = journal.sourceSha256
      await verifyCopies(paths, journal, true)
    },
  )
  await options.onBoundary?.('after-retire')
}
async function discardInactive(
  store: MigrationPoolStore,
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
): Promise<void> {
  await makeCancelledSeedReady(store, paths, journal)
  const targets = journal.rollback?.rows ?? journal.mapping.map((row) => row.id)
  const owned = {
    ...journal,
    mapping: targets.map((id, ordinal) => ({ id, ordinal })),
  }
  await assertStateOwnership(paths, owned, false)
  for (const id of targets) {
    const rows = await rowsOf(store)
    const state = (await exists(paths.statePath))
      ? object(jsonBytes(await secureRead(paths.statePath)), 'inactive state')
      : {}
    const accounts =
      state.accounts === undefined
        ? {}
        : object(state.accounts, 'inactive state accounts')
    if (rows.some((row) => row.id === id) || Object.hasOwn(accounts, id))
      await store.remove(id)
  }
  if ((await rowsOf(store)).length)
    throw new AccountMigrationError(
      'inactive successor contains unrelated rows',
    )
  await management(store, journal, true)
  await store.updateSettings((settings) => {
    const prior = settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY]
    if (
      prior !== undefined &&
      !isDeepStrictEqual(
        decodeAccountStoreGeneration(prior),
        generationJson(journal),
      )
    )
      throw new AccountMigrationError(
        'inactive generation setting belongs to another journal',
      )
    delete settings[ACCOUNT_STORE_GENERATION_SETTINGS_KEY]
    return settings
  })
}

async function makeCancelledSeedReady(
  store: MigrationPoolStore,
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
): Promise<void> {
  const read = await store.read()
  if (read.status === 'pending-migration') {
    const config = jsonBytes(await secureRead(paths.configPath))
    if (
      !journal.cancelled ||
      journal.mapping.length ||
      !isDeepStrictEqual(config, { version: 1, accounts: [] })
    )
      throw new AccountMigrationError(
        'cancellation cannot adopt an unrelated pending config',
      )
    await store.initialize()
  } else if (read.status === 'error')
    throw new AccountMigrationError('cancellation successor could not be read')
}
async function finishCancellation(
  store: MigrationPoolStore,
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  journal: AccountMigrationJournal,
  options: AccountMigrationOptions,
): Promise<AccountMigrationOutcome> {
  if (
    !journal.cancelled ||
    journal.sourceKind !== 'file' ||
    digest(await secureRead(paths.legacyPath)) !== journal.sourceSha256
  )
    throw new AccountMigrationError(
      'cancellation requires its unchanged unserved source',
    )
  await verifyCopies(paths, journal, false)
  await makeCancelledSeedReady(store, paths, journal)
  await management(store, journal, true)
  await modules.fs.withLock(
    paths.legacyPath,
    { name: 'accounts', ttlMs: 10_000, timeoutMs: 2_000, renew: true },
    async (accountsLease) => {
      await accountsLease.assertOwned()
      await lease.assertOwned()
      if (digest(await secureRead(paths.legacyPath)) !== journal.sourceSha256)
        throw new AccountMigrationError(
          'cancellation source changed before acknowledgment',
        )
      journal.status = 'inactive'
      journal.phase = 'activate'
      await saveJournal(
        modules,
        paths,
        lease,
        journal,
        false,
        options.onBoundary,
      )
    },
  )
  return { status: 'completed', receipt: receipt(journal) }
}

/** Capture/build/verify/retire/activate use the genuine public store and filesystem exports from the same checksum-verified common-auth package. */
export function createAccountMigrationFactory(
  modules: AccountMigrationModules,
) {
  return async (
    options: AccountMigrationOptions,
  ): Promise<AccountMigrationOutcome> => {
    if (options.offline?.processesStopped !== true)
      throw new AccountMigrationError(
        'stopped processes and timers must be explicitly confirmed',
      )
    resolveAccountStorePaths(options.legacyPath)
    try {
      return await withParentTopology(
        modules,
        options.legacyPath,
        async (parentLease) => {
          const prior = await readPointer(options.legacyPath)
          if (prior)
            await finishPointerPublication(
              options.legacyPath,
              prior,
              parentLease,
            )
          let paths = prior
            ? generationPaths(options.legacyPath, prior.id)
            : undefined
          let previous: AccountMigrationJournal | undefined
          if (paths) {
            const existing = await readJournal(paths)
            if (!existing)
              throw new AccountMigrationError(
                'published generation journal missing',
              )
            if (existing.status === 'inactive') {
              previous = existing
              await modules.fs.withLock(
                paths.configPath,
                {
                  name: MANAGEMENT_LOCK_NAME,
                  ttlMs: 10_000,
                  timeoutMs: 2_000,
                  renew: true,
                },
                async (oldLease) => {
                  if (!paths)
                    throw new AccountMigrationError(
                      'inactive physical paths missing',
                    )
                  await recoverStoreTemps(
                    modules,
                    paths,
                    oldLease,
                    existing,
                    options.onBoundary,
                  )
                  const oldStore = openMigrationStore(
                    modules,
                    paths,
                    options.now,
                    writeObserver(modules, paths, oldLease, options.onBoundary),
                  )
                  await discardInactive(oldStore, paths, existing)
                },
              )
              paths = undefined
            }
          }
          if (paths === undefined) {
            if (!(await exists(options.legacyPath)))
              throw new AccountMigrationError(
                'absent source requires explicit fresh initialization',
              )
            paths = await allocateGeneration(options.legacyPath)
          }
          const physical = paths
          return modules.fs.withLock(
            physical.configPath,
            {
              name: MANAGEMENT_LOCK_NAME,
              ttlMs: 10_000,
              timeoutMs: 2_000,
              renew: true,
            },
            async (lease) => {
              let journal = await readJournal(physical)
              if (journal === undefined) {
                journal = await capture(
                  modules,
                  physical,
                  lease,
                  options,
                  previous,
                )
                await modules.fs.withLock(
                  physical.legacyPath,
                  {
                    name: 'accounts',
                    ttlMs: 10_000,
                    timeoutMs: 2_000,
                    renew: true,
                  },
                  async (accountsLease) => {
                    await accountsLease.assertOwned()
                    if (
                      digest(await secureRead(physical.legacyPath)) !==
                      journal?.sourceSha256
                    )
                      throw new AccountMigrationError(
                        'source changed before pointer publication',
                      )
                    if (!journal)
                      throw new AccountMigrationError('capture journal missing')
                    await publishGenerationPointer(
                      modules,
                      physical,
                      journal,
                      parentLease,
                      prior,
                      options.onBoundary,
                    )
                  },
                )
                await options.onBoundary?.('after-capture')
              }
              await assertPublishedAccountStoreGeneration(physical)
              await recoverStoreTemps(
                modules,
                physical,
                lease,
                journal,
                options.onBoundary,
              )
              const store = openMigrationStore(
                modules,
                physical,
                options.now,
                writeObserver(modules, physical, lease, options.onBoundary),
              )
              if (journal.status === 'active') {
                if (await exists(physical.legacyPath))
                  throw new AccountMigrationError(
                    'legacy source was recreated after activation',
                  )
                await verifyCopies(physical, journal, true)
                await currentSuccessor(store, physical, journal)
                await management(store, journal, true)
                return { status: 'completed', receipt: receipt(journal) }
              }
              if (journal.operation === 'rollback')
                throw new AccountMigrationError(
                  'resume offline rollback before re-migration',
                )
              if (journal.sourceKind === 'absent')
                throw new AccountMigrationError(
                  'resume explicit fresh initialization; never adopt an appearing source',
                )
              await verifyCopies(physical, journal, false)
              if (journal.phase === 'capture' || journal.phase === 'build') {
                journal.phase = 'build'
                await saveJournal(
                  modules,
                  physical,
                  lease,
                  journal,
                  false,
                  options.onBoundary,
                )
                await build(store, modules, physical, lease, journal, options)
                journal.phase = 'verify'
                await saveJournal(
                  modules,
                  physical,
                  lease,
                  journal,
                  false,
                  options.onBoundary,
                )
              }
              if (journal.phase === 'verify') {
                await verify(store, physical, journal, options)
                journal.phase = 'retire'
                await saveJournal(
                  modules,
                  physical,
                  lease,
                  journal,
                  false,
                  options.onBoundary,
                )
                await management(store, journal)
              }
              if (journal.phase === 'retire') {
                await retire(store, modules, physical, lease, journal, options)
                journal.phase = 'activate'
                await saveJournal(
                  modules,
                  physical,
                  lease,
                  journal,
                  false,
                  options.onBoundary,
                )
              }
              await options.onBoundary?.('before-activate')
              await verifyImported(store, journal)
              await verifyCopies(physical, journal, true)
              if (await exists(physical.legacyPath))
                throw new AccountMigrationError(
                  'legacy source reappeared before activation',
                )
              journal.status = 'active'
              await saveJournal(
                modules,
                physical,
                lease,
                journal,
                false,
                options.onBoundary,
              )
              await management(store, journal, true)
              await options.onBoundary?.('after-activate')
              return { status: 'completed', receipt: receipt(journal) }
            },
          )
        },
      )
    } catch (error) {
      const pending = pendingLockFailure(modules, error)
      if (pending) return pending
      throw error
    }
  }
}

function refMatches(
  ref: RowRef | null | undefined,
  row: MigrationPoolRow,
): boolean {
  return (
    ref !== null && ref !== undefined && isDeepStrictEqual(ref, rowRef(row))
  )
}
function exportRouting(
  routing: RoutingSettings,
  rows: MigrationPoolRow[],
): RoutingSettings {
  const result = { ...routing }
  const global = rows.findIndex((row) => refMatches(routing.activeRow, row))
  const effective = rows.length
    ? Math.max(0, Math.min(routing.activeIndex ?? 0, rows.length - 1))
    : 0
  if (global >= 0 && global !== effective) result.activeIndex = global
  const fallback = rows.length
    ? Math.max(0, Math.min(result.activeIndex ?? 0, rows.length - 1))
    : 0
  for (const family of ['claude', 'gemini'] as const) {
    const index = rows.findIndex((row) =>
      refMatches(routing.activeRowByFamily?.[family], row),
    )
    const cursor = rows.length
      ? (routing.activeIndexByFamily?.[family] ?? fallback) % rows.length
      : 0
    if (index >= 0 && index !== cursor)
      result.activeIndexByFamily = {
        ...result.activeIndexByFamily,
        [family]: index,
      }
  }
  return result
}
async function exportCurrent(
  store: MigrationPoolStore,
): Promise<{ rows: string[]; exported: JsonObject }> {
  const rows = await rowsOf(store)
  const settings = await settingsOf(store)
  const routing = decodeRoutingSettings(settings[ROUTING_SETTINGS_KEY])
  const accounts = rows.map((row, ordinal): LegacyAccountManifest => {
    healthyRow(row)
    if (row.credential?.type !== 'oauth')
      throw new AccountMigrationError('rollback cannot export a non-OAuth row')
    const metadata = decodeProviderState(row.providerState).metadata
    if ((metadata.enabled !== false) !== row.enabled)
      throw new AccountMigrationError(
        'current enabled encoding differs from native row',
      )
    return {
      ordinal,
      refreshToken: row.credential.refresh,
      metadata,
      ...(row.quota === undefined
        ? {}
        : { quota: decodeQuotaState(row.quota) }),
    }
  })
  return {
    rows: rows.map((row) => row.id),
    exported: exportLegacyAccountStorage(
      accounts,
      exportRouting(routing, rows),
    ),
  }
}
interface RollbackSnapshot {
  config: string
  state?: string
  exported: JsonObject
}
async function rollbackSnapshot(
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
): Promise<RollbackSnapshot> {
  const rollback = journal.rollback
  if (!rollback)
    throw new AccountMigrationError('rollback snapshot association is absent')
  const bytes = await secureRead(
    join(paths.transfersDir, `${rollback.id}.json`),
  )
  if (digest(bytes) !== rollback.snapshotSha256)
    throw new AccountMigrationError(
      'current-credential snapshot digest differs',
    )
  const snapshot = exact(
    jsonBytes(bytes),
    ['config', 'state', 'exported'],
    'rollback snapshot',
  )
  if (
    typeof snapshot.config !== 'string' ||
    (snapshot.state !== undefined && typeof snapshot.state !== 'string')
  )
    throw new AccountMigrationError(
      'rollback snapshot file encoding is invalid',
    )
  const exported = object(snapshot.exported, 'rollback export')
  if (
    digest(`${JSON.stringify(exported, null, 2)}\n`) !== rollback.exportSha256
  )
    throw new AccountMigrationError('rollback export association differs')
  if (exported.version !== 4)
    throw new AccountMigrationError('rollback export is not v4')
  const accounts = list(exported.accounts, 'rollback export accounts').map(
    (row, ordinal) =>
      parseAccount(row, ordinal, 4, journal.manifest.normalizationClock),
  )
  // Rollback validates current exported v4 rows without repeating import-time
  // email winner selection or clock-dependent reset/quota normalization. Serialization
  // must preserve every current credential and metadata field.
  const copied = exportLegacyAccountStorage(accounts, legacyRouting(exported))
  if (!isDeepStrictEqual(copied, exported))
    throw new AccountMigrationError(
      'rollback export does not roundtrip losslessly',
    )
  return {
    config: snapshot.config,
    ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
    exported: copied,
  }
}

/** Retains current credential epochs and exports current refresh tokens to legacy JSON, never reviving tokens from the original source backup. */
export function createAccountRollbackFactory(modules: AccountMigrationModules) {
  return async (
    options: AccountMigrationOptions,
  ): Promise<AccountMigrationOutcome> => {
    if (options.offline?.processesStopped !== true)
      throw new AccountMigrationError(
        'stopped processes and timers must be explicitly confirmed',
      )
    try {
      return await withParentTopology(modules, options.legacyPath, async () => {
        const paths = await resolvePublishedAccountStorePaths(
          options.legacyPath,
        )
        if (!paths)
          throw new AccountMigrationError(
            'rollback requires a published generation',
          )
        return modules.fs.withLock(
          paths.configPath,
          {
            name: MANAGEMENT_LOCK_NAME,
            ttlMs: 10_000,
            timeoutMs: 2_000,
            renew: true,
          },
          async (lease) => {
            const initialJournal = await readJournal(paths)
            if (!initialJournal)
              throw new AccountMigrationError(
                'rollback requires an owned migration generation',
              )
            let journal = initialJournal
            await recoverStoreTemps(
              modules,
              paths,
              lease,
              journal,
              options.onBoundary,
            )
            const store = openMigrationStore(
              modules,
              paths,
              options.now,
              writeObserver(modules, paths, lease, options.onBoundary),
            )
            if (journal.status === 'inactive') {
              if (journal.cancelled) {
                return finishCancellation(
                  store,
                  modules,
                  paths,
                  lease,
                  journal,
                  options,
                )
              } else {
                await rollbackSnapshot(paths, journal)
                if (
                  digest(await secureRead(paths.legacyPath)) !==
                  journal.rollback?.exportSha256
                )
                  throw new AccountMigrationError(
                    'restored legacy bytes changed after rollback',
                  )
              }
              return { status: 'completed', receipt: receipt(journal) }
            }
            if (journal.status === 'pending' && journal.cancelled)
              return finishCancellation(
                store,
                modules,
                paths,
                lease,
                journal,
                options,
              )
            if (
              journal.status === 'pending' &&
              journal.operation === 'migrate'
            ) {
              if (journal.sourceKind === 'absent')
                throw new AccountMigrationError(
                  'unserved fresh initialization resumes explicitly; no legacy file can be restored',
                )
              // Pre-retirement cancellation preserves the untouched original legacy file;
              // this pending generation has never been admitted for credential serving.
              if (
                !['capture', 'build', 'verify'].includes(journal.phase) ||
                digest(await secureRead(paths.legacyPath)) !==
                  journal.sourceSha256
              )
                throw new AccountMigrationError(
                  'pre-retirement cancellation requires unchanged, unserved legacy source',
                )
              await verifyCopies(paths, journal, false)
              journal = {
                ...journal,
                status: 'pending',
                operation: 'rollback',
                phase: 'capture',
                cancelled: true,
              }
              await saveJournal(
                modules,
                paths,
                lease,
                journal,
                false,
                options.onBoundary,
              )
              return finishCancellation(
                store,
                modules,
                paths,
                lease,
                journal,
                options,
              )
            }
            if (journal.status === 'active') {
              const active = journal
              await currentSuccessor(store, paths, journal)
              if (await exists(paths.legacyPath))
                throw new AccountMigrationError(
                  'rollback refuses an existing or recreated legacy source',
                )
              await verifyCopies(paths, journal, true)
              await options.onBoundary?.('rollback:before-capture')
              // Public config.json/state.json save leases protect the complete current
              // credentials, metadata and epoch snapshot used for rollback export.
              await modules.fs.withLock(
                paths.configPath,
                { name: 'save', ttlMs: 10_000, timeoutMs: 2_000, renew: true },
                async (configLease) => {
                  await modules.fs.withLock(
                    paths.statePath,
                    {
                      name: 'save',
                      ttlMs: 10_000,
                      timeoutMs: 2_000,
                      renew: true,
                    },
                    async (stateLease) => {
                      const current = await exportCurrent(store)
                      const files = await synchronizedSnapshot(
                        paths,
                        options.onBoundary,
                      )
                      const snapshot = Buffer.from(
                        `${JSON.stringify({ config: files.config.toString('base64'), ...(files.state === undefined ? {} : { state: files.state.toString('base64') }), exported: current.exported }, null, 2)}\n`,
                      )
                      const rollback: MigrationRollback = {
                        id: randomUUID(),
                        snapshotSha256: digest(snapshot),
                        exportSha256: digest(
                          `${JSON.stringify(current.exported, null, 2)}\n`,
                        ),
                        rows: current.rows,
                        successorInactive: false,
                      }
                      await exclusiveBytes(
                        join(paths.transfersDir, `${rollback.id}.json`),
                        snapshot,
                        rollback.snapshotSha256,
                        options.onBoundary,
                      )
                      await configLease.assertOwned()
                      await stateLease.assertOwned()
                      journal = {
                        ...active,
                        status: 'pending',
                        operation: 'rollback',
                        phase: 'capture',
                        rollback,
                      }
                      await saveJournal(
                        modules,
                        paths,
                        lease,
                        journal,
                        false,
                        options.onBoundary,
                      )
                    },
                  )
                },
              )
              await options.onBoundary?.('rollback:after-capture')
            }
            const rollback = journal.rollback
            if (!rollback)
              throw new AccountMigrationError('rollback snapshot is incomplete')
            const snapshot = await rollbackSnapshot(paths, journal)
            if (journal.phase === 'capture' || journal.phase === 'build') {
              journal.phase = 'build'
              await saveJournal(
                modules,
                paths,
                lease,
                journal,
                false,
                options.onBoundary,
              )
              await options.onBoundary?.('rollback:before-build')
              await management(store, journal)
              await options.onBoundary?.('rollback:after-build')
              journal.phase = 'verify'
              await saveJournal(
                modules,
                paths,
                lease,
                journal,
                false,
                options.onBoundary,
              )
            }
            if (journal.phase === 'verify') {
              await options.onBoundary?.('rollback:before-verify')
              await currentSuccessor(store, paths, journal)
              const current = await exportCurrent(store)
              if (
                !isDeepStrictEqual(current.rows, rollback.rows) ||
                !isDeepStrictEqual(current.exported, snapshot.exported)
              )
                throw new AccountMigrationError(
                  'current credentials or full metadata changed during rollback',
                )
              await synchronizedSnapshot(paths, options.onBoundary)
              await verifyCopies(paths, journal, true)
              await options.onBoundary?.('rollback:after-verify')
              journal.phase = 'retire'
              await saveJournal(
                modules,
                paths,
                lease,
                journal,
                false,
                options.onBoundary,
              )
            }
            if (journal.phase === 'retire') {
              await options.onBoundary?.('rollback:before-retire')
              rollback.successorInactive = true
              await saveJournal(
                modules,
                paths,
                lease,
                journal,
                false,
                options.onBoundary,
              )
              await management(store, journal)
              await options.onBoundary?.('rollback:after-retire')
              journal.phase = 'activate'
              await saveJournal(
                modules,
                paths,
                lease,
                journal,
                false,
                options.onBoundary,
              )
            }
            await options.onBoundary?.('rollback:before-activate')
            await currentSuccessor(store, paths, journal)
            const current = await exportCurrent(store)
            if (
              !isDeepStrictEqual(current.rows, rollback.rows) ||
              !isDeepStrictEqual(current.exported, snapshot.exported)
            )
              throw new AccountMigrationError(
                'current successor changed before exclusive legacy restoration',
              )
            await synchronizedSnapshot(paths, options.onBoundary)
            const exportSha256 = rollback.exportSha256
            await modules.fs.withLock(
              paths.legacyPath,
              {
                name: 'accounts',
                ttlMs: 10_000,
                timeoutMs: 2_000,
                renew: true,
              },
              async (accountsLease) => {
                await lease.assertOwned()
                await accountsLease.assertOwned()
                // Reuse the restored legacy file only when its exact bytes match this
                // generation's recorded durable current-credential rollback restore intent.
                const bytes = Buffer.from(
                  `${JSON.stringify(snapshot.exported, null, 2)}\n`,
                )
                await exclusiveBytes(
                  paths.legacyPath,
                  bytes,
                  exportSha256,
                  options.onBoundary,
                )
                await accountsLease.assertOwned()
                journal.status = 'inactive'
                await saveJournal(
                  modules,
                  paths,
                  lease,
                  journal,
                  false,
                  options.onBoundary,
                )
              },
            )
            await management(store, journal, true)
            await options.onBoundary?.('rollback:after-activate')
            return { status: 'completed', receipt: receipt(journal) }
          },
        )
      })
    } catch (error) {
      const pending = pendingLockFailure(modules, error)
      if (pending !== undefined) return pending
      throw error
    }
  }
}

export interface FreshAccountStoreOptions {
  /** initializeFreshAccountStore requires this absolute normalized legacy-file location to remain absent. */
  legacyPath: string
  now: () => number
  onBoundary?: AccountMigrationOptions['onBoundary']
}
async function assertSourceAbsent(paths: AccountStorePaths): Promise<void> {
  if (await exists(paths.legacyPath))
    throw new AccountMigrationError(
      'fresh initialization refuses an existing or appearing legacy source',
    )
}
async function expectedFreshArtifacts(
  paths: AccountStorePaths,
  modules: AccountMigrationModules,
  journal: AccountMigrationJournal,
): Promise<void> {
  if (
    journal.sourceKind !== 'absent' ||
    journal.operation !== 'migrate' ||
    journal.mapping.length
  )
    throw new AccountMigrationError(
      'journal is not an owned fresh initialization',
    )
  await assertSourceAbsent(paths)
  await verifyCopies(paths, journal, false)
  if (
    (await readdir(paths.transfersDir)).length ||
    (await exists(paths.statePath))
  )
    throw new AccountMigrationError(
      'fresh initialization found unrelated credential or transfer artifacts',
    )
  const allowed = [
    'backups',
    'retired',
    'transfers',
    'migration.json',
    'config.json',
    basename(modules.fs.lockPathFor(paths.configPath, MANAGEMENT_LOCK_NAME)),
    basename(modules.fs.lockPathFor(paths.configPath, 'save')),
    basename(modules.fs.lockPathFor(paths.statePath, 'save')),
  ]
  if ((await readdir(paths.storeDir)).some((entry) => !allowed.includes(entry)))
    throw new AccountMigrationError(
      'fresh initialization found unrelated successor artifacts',
    )
  if (!(await exists(paths.configPath))) return
  if (journal.phase === 'capture')
    throw new AccountMigrationError(
      'fresh capture has an unexpected config artifact',
    )
  const config = exact(
    jsonBytes(await secureRead(paths.configPath)),
    [
      'version',
      'accounts',
      'commonAuthPool',
      MANAGEMENT_SETTINGS_KEY,
      ROUTING_SETTINGS_KEY,
      ACCOUNT_STORE_GENERATION_SETTINGS_KEY,
    ],
    'fresh config',
  )
  if (config.version !== 1 || list(config.accounts, 'fresh roster').length)
    throw new AccountMigrationError(
      'fresh successor is not the expected empty roster',
    )
  if (config.commonAuthPool === undefined) {
    if (
      journal.phase !== 'build' ||
      !isDeepStrictEqual(config, { version: 1, accounts: [] })
    )
      throw new AccountMigrationError('fresh seed has an unrelated association')
    return
  }
  const pool = exact(
    config.commonAuthPool,
    ['schemaVersion', 'rows', 'retiredEpochs'],
    'fresh pool',
  )
  if (
    pool.schemaVersion !== 1 ||
    Object.keys(object(pool.rows, 'fresh entries')).length ||
    (pool.retiredEpochs !== undefined &&
      Object.keys(object(pool.retiredEpochs, 'fresh retired epochs')).length)
  )
    throw new AccountMigrationError(
      'fresh pool contains credential or epoch artifacts',
    )
  const managementRecord = config[MANAGEMENT_SETTINGS_KEY]
  if (managementRecord !== undefined) {
    const m = exact(
      managementRecord,
      ['id', 'kind', 'targets', 'progress'],
      'fresh management',
    )
    const p = exact(m.progress, ['step', 'completedTargets'], 'fresh progress')
    if (
      m.id !== journal.id ||
      m.kind !== 'migration' ||
      list(m.targets, 'fresh targets').length ||
      list(p.completedTargets, 'fresh completions').length ||
      !ACCOUNT_MIGRATION_PHASES.some((phase) => phase === p.step)
    )
      throw new AccountMigrationError('fresh management ownership differs')
  }
  if (
    config[ROUTING_SETTINGS_KEY] !== undefined &&
    !isDeepStrictEqual(config[ROUTING_SETTINGS_KEY], { schemaVersion: 1 })
  )
    throw new AccountMigrationError(
      'fresh cursor encoding has an unrelated association',
    )
  if (
    config[ACCOUNT_STORE_GENERATION_SETTINGS_KEY] !== undefined &&
    !isDeepStrictEqual(
      decodeAccountStoreGeneration(
        config[ACCOUNT_STORE_GENERATION_SETTINGS_KEY],
      ),
      generationJson(journal),
    )
  )
    throw new AccountMigrationError('fresh generation setting differs')
}

/** Explicit fresh initialization publishes an owned pointer/journal before first login; pointer absence alone never authorizes credential service. */
export async function initializeFreshAccountStore(
  modules: AccountMigrationModules,
  options: FreshAccountStoreOptions,
): Promise<AccountMigrationOutcome> {
  resolveAccountStorePaths(options.legacyPath)
  try {
    return await withParentTopology(
      modules,
      options.legacyPath,
      async (parentLease) => {
        await assertSourceAbsent(resolveAccountStorePaths(options.legacyPath))
        const pointer = await readPointer(options.legacyPath)
        if (pointer)
          await finishPointerPublication(
            options.legacyPath,
            pointer,
            parentLease,
          )
        const physical = pointer
          ? generationPaths(options.legacyPath, pointer.id)
          : await allocateGeneration(options.legacyPath)
        return modules.fs.withLock(
          physical.configPath,
          {
            name: MANAGEMENT_LOCK_NAME,
            ttlMs: 10_000,
            timeoutMs: 2_000,
            renew: true,
          },
          async (lease) => {
            let journal = await readJournal(physical)
            if (pointer === undefined) {
              await options.onBoundary?.('before-capture')
              await assertSourceAbsent(physical)
              await modules.fs.withLock(
                physical.legacyPath,
                {
                  name: 'accounts',
                  ttlMs: 10_000,
                  timeoutMs: 2_000,
                  renew: true,
                },
                async (accountsLease) => {
                  await assertSourceAbsent(physical)
                  await accountsLease.assertOwned()
                  await lease.assertOwned()
                  if (
                    journal !== undefined ||
                    (await exists(physical.configPath)) ||
                    (await exists(physical.statePath))
                  )
                    throw new AccountMigrationError(
                      'fresh stage has unrelated artifacts',
                    )
                  journal = {
                    schemaVersion: 1,
                    id: pathGenerationId(physical),
                    legacyPath: physical.legacyPath,
                    storeDir: physical.storeDir,
                    sourceKind: 'absent',
                    status: 'pending',
                    operation: 'migrate',
                    phase: 'capture',
                    manifest: {
                      sourceVersion: null,
                      normalizationClock: options.now(),
                      accounts: [],
                      routing: { schemaVersion: 1 },
                      effectiveActiveIndex: 0,
                    },
                    mapping: [],
                    completedRows: [],
                  }
                  await saveJournal(
                    modules,
                    physical,
                    lease,
                    journal,
                    true,
                    options.onBoundary,
                  )
                  await options.onBoundary?.('pointer:before-publication')
                  await assertSourceAbsent(physical)
                  await publishGenerationPointer(
                    modules,
                    physical,
                    journal,
                    parentLease,
                    undefined,
                    options.onBoundary,
                  )
                  await options.onBoundary?.('pointer:after-publication')
                },
              )
            }
            if (
              journal?.sourceKind !== 'absent' ||
              journal.operation !== 'migrate' ||
              journal.status === 'inactive'
            )
              throw new AccountMigrationError(
                'fresh resume has no compatible pointed generation',
              )
            await assertPublishedAccountStoreGeneration(physical)
            await recoverStoreTemps(
              modules,
              physical,
              lease,
              journal,
              options.onBoundary,
            )
            const guardBoundary = async (name: string) => {
              await assertSourceAbsent(physical)
              await options.onBoundary?.(name)
              await assertSourceAbsent(physical)
              await lease.assertOwned()
            }
            const store = openMigrationStore(
              modules,
              physical,
              options.now,
              writeObserver(modules, physical, lease, guardBoundary),
            )
            if (journal.status === 'active') {
              await verifyCopies(physical, journal, false)
              await currentSuccessor(store, physical, journal)
              await management(store, journal, true)
              return { status: 'completed', receipt: receipt(journal) }
            }
            await expectedFreshArtifacts(physical, modules, journal)
            if (journal.phase === 'capture') {
              await guardBoundary('after-capture')
              journal.phase = 'build'
              await saveJournal(
                modules,
                physical,
                lease,
                journal,
                false,
                options.onBoundary,
              )
            }
            const phaseOptions: MigrationPhaseOptions = {
              now: options.now,
              onBoundary: guardBoundary,
            }
            if (journal.phase === 'build') {
              await build(
                store,
                modules,
                physical,
                lease,
                journal,
                phaseOptions,
              )
              await expectedFreshArtifacts(physical, modules, journal)
              journal.phase = 'verify'
              await saveJournal(
                modules,
                physical,
                lease,
                journal,
                false,
                options.onBoundary,
              )
            }
            if (journal.phase === 'verify') {
              await verify(store, physical, journal, phaseOptions)
              journal.phase = 'retire'
              await saveJournal(
                modules,
                physical,
                lease,
                journal,
                false,
                options.onBoundary,
              )
              await management(store, journal)
            }
            if (journal.phase === 'retire') {
              await guardBoundary('before-retire')
              await expectedFreshArtifacts(physical, modules, journal)
              await verifyImported(store, journal)
              const retiring = journal
              await modules.fs.withLock(
                physical.legacyPath,
                {
                  name: 'accounts',
                  ttlMs: 10_000,
                  timeoutMs: 2_000,
                  renew: true,
                },
                async (accountsLease) => {
                  await assertSourceAbsent(physical)
                  await accountsLease.assertOwned()
                  retiring.sourceAbsenceVerified = true
                  await saveJournal(
                    modules,
                    physical,
                    lease,
                    retiring,
                    false,
                    options.onBoundary,
                  )
                },
              )
              await guardBoundary('after-retire')
              journal.phase = 'activate'
              await saveJournal(
                modules,
                physical,
                lease,
                journal,
                false,
                options.onBoundary,
              )
            }
            await guardBoundary('before-activate')
            await expectedFreshArtifacts(physical, modules, journal)
            await verifyImported(store, journal)
            journal.status = 'active'
            await saveJournal(
              modules,
              physical,
              lease,
              journal,
              false,
              options.onBoundary,
            )
            await management(store, journal, true)
            await guardBoundary('after-activate')
            return { status: 'completed', receipt: receipt(journal) }
          },
        )
      },
    )
  } catch (error) {
    const pending = pendingLockFailure(modules, error)
    if (pending) return pending
    throw error
  }
}

/** Deletes only byte-identical stages explicitly recorded before a public write. */
async function recoverStoreTemps(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  journal: AccountMigrationJournal,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<void> {
  const recorded = journal.ownedTemps ?? []
  for (const temp of recorded) {
    const path = join(paths.storeDir, temp.name)
    const target = temp.name.startsWith('config.json.')
      ? paths.configPath
      : paths.statePath
    if (await exists(path)) {
      if (digest(await secureRead(path)) !== temp.sha256)
        throw new AccountMigrationError('owned store staging bytes changed')
      await lease.assertOwned()
      await unlink(path)
      await syncDirectory(paths.storeDir, boundary)
    } else {
      const present = await exists(target)
      const hash = present ? digest(await secureRead(target)) : undefined
      if (
        !(present && hash === temp.sha256) &&
        !(present === temp.targetPresent && hash === temp.priorSha256)
      )
        throw new AccountMigrationError(
          'missing recorded stage matches neither its prior nor completed public write',
        )
    }
  }
  if (recorded.length) {
    delete journal.ownedTemps
    await saveJournal(modules, paths, lease, journal, false, boundary)
  }
}
async function checkpointStoreStage(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  step: MigrationPublicWriteStep,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<void> {
  const journal = await readJournal(paths)
  if (!journal)
    throw new AccountMigrationError(
      'public write has no durable migration journal',
    )
  const file = step.includes('config') ? 'config.json' : 'state.json'
  const pattern = new RegExp(
    `^${file.replace('.', '\\.')}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
  )
  if (step.startsWith('before-')) {
    const names = (await readdir(paths.storeDir)).filter((name) =>
      pattern.test(name),
    )
    if (names.length !== 1)
      throw new AccountMigrationError(
        'public staging interval has unrelated or missing files',
      )
    const name = names[0]
    if (!name) throw new AccountMigrationError('public staging name absent')
    const sha256 = digest(await secureRead(join(paths.storeDir, name)))
    await syncFile(join(paths.storeDir, name))
    const target = file === 'config.json' ? paths.configPath : paths.statePath
    const targetPresent = await exists(target)
    journal.ownedTemps = [
      ...(journal.ownedTemps ?? []).filter((temp) => !pattern.test(temp.name)),
      {
        name,
        sha256,
        targetPresent,
        ...(targetPresent
          ? { priorSha256: digest(await secureRead(target)) }
          : {}),
      },
    ]
    await saveJournal(modules, paths, lease, journal, false, boundary)
  } else {
    const completed = (journal.ownedTemps ?? []).filter((temp) =>
      pattern.test(temp.name),
    )
    const target = file === 'config.json' ? paths.configPath : paths.statePath
    await syncFile(target)
    await syncDirectory(paths.storeDir, boundary)
    for (const temp of completed) {
      if (
        (await exists(join(paths.storeDir, temp.name))) ||
        digest(await secureRead(target)) !== temp.sha256
      )
        throw new AccountMigrationError(
          'public write does not match its recorded stage',
        )
    }
    journal.ownedTemps = (journal.ownedTemps ?? []).filter(
      (temp) => !pattern.test(temp.name),
    )
    if (!journal.ownedTemps.length) delete journal.ownedTemps
    // The next pending phase/row acknowledgment persists the journal after a
    // public operation, so keep its before-write stage reference until then.
    // Final active/inactive settings cleanup has no later acknowledgment and
    // must persist removal of that reference here.
    if (completed.length && journal.status !== 'pending')
      await saveJournal(modules, paths, lease, journal, false, boundary)
  }
}

async function allocateGeneration(
  legacyPath: string,
): Promise<AccountStorePaths> {
  if (await exists(resolveAccountStorePaths(legacyPath).storeDir))
    throw new AccountMigrationError(
      'foreign logical directory refuses generation allocation',
    )
  const paths = generationPaths(legacyPath, randomUUID())
  await mkdir(paths.storeDir, { mode: 0o700 })
  await prepareDirectories(paths)
  return paths
}
async function publishGenerationPointer(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  journal: AccountMigrationJournal,
  parentLease: MigrationLease,
  prior?: AccountStorePointer,
  boundary?: AccountMigrationOptions['onBoundary'],
): Promise<void> {
  await parentLease.assertOwned()
  const currentJournal = await readJournal(paths)
  if (
    !currentJournal ||
    currentJournal.id !== journal.id ||
    !isDeepStrictEqual(journalJson(currentJournal), journalJson(journal))
  )
    throw new AccountMigrationError(
      'publication requires its complete synced canonical journal',
    )
  await syncFile(paths.migrationPath)
  await syncDirectory(paths.storeDir)
  const pointer: AccountStorePointer = {
    schemaVersion: 1,
    id: journal.id,
    directoryBasename: basename(paths.storeDir),
  }
  const path = accountStorePointerPath(paths.legacyPath)
  if (prior === undefined) {
    const stage = `${path}.${journal.id}.tmp`
    const bytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`)
    await exclusiveBytes(stage, bytes, digest(bytes))
    await parentLease.assertOwned()
    await boundary?.('pointer:before-link')
    if (await exists(resolveAccountStorePaths(paths.legacyPath).storeDir))
      throw new AccountMigrationError(
        'foreign logical store directory appeared before publication',
      )
    if (journal.sourceKind === 'absent') await assertSourceAbsent(paths)
    else if (
      digest(await secureRead(paths.legacyPath)) !== journal.sourceSha256
    )
      throw new AccountMigrationError(
        'captured source changed immediately before pointer link',
      )
    try {
      await link(stage, path)
    } catch (error) {
      if (errno(error) === 'EEXIST')
        throw new AccountMigrationError(
          'foreign or competing pointer publication refuses overwrite',
        )
      throw new AccountMigrationError(
        'exclusive pointer hard-link publication failed',
      )
    }
    await boundary?.('pointer:after-link-before-parent-sync')
    await syncDirectory(dirname(path))
    if (!isDeepStrictEqual(await readPointer(paths.legacyPath), pointer))
      throw new AccountMigrationError('pointer publication readback differs')
    await boundary?.('pointer:after-sync-before-stage-cleanup')
    await unlink(stage)
  } else {
    const oldPaths = generationPaths(paths.legacyPath, prior.id)
    const oldJournal = await readJournal(oldPaths)
    if (oldJournal?.status !== 'inactive')
      throw new AccountMigrationError(
        'pointer transition requires an owned inactive prior generation',
      )
    await verifyCopies(oldPaths, oldJournal, !oldJournal.cancelled)
    const stageName = journal.id
    await modules.fs.writeJsonAtomic(path, pointer, {
      stageName: () => stageName,
      beforeRename: async () => {
        await parentLease.assertOwned()
        if (
          !isDeepStrictEqual(await readPointer(paths.legacyPath), prior) ||
          (await readJournal(oldPaths))?.status !== 'inactive'
        )
          throw new AccountMigrationError(
            'inactive pointer changed before transition',
          )
        await syncFile(`${path}.${stageName}.tmp`)
      },
    })
    await syncFile(path)
    await syncDirectory(dirname(path))
  }
  await parentLease.assertOwned()
}
function withParentTopology<T>(
  modules: AccountMigrationModules,
  legacyPath: string,
  body: (lease: MigrationLease) => Promise<T>,
): Promise<T> {
  return modules.fs.withLock(
    legacyPath,
    {
      name: MANAGEMENT_LOCK_NAME,
      ttlMs: 10_000,
      timeoutMs: 2_000,
      renew: true,
    },
    body,
  )
}

function writeObserver(
  modules: AccountMigrationModules,
  paths: AccountStorePaths,
  lease: MigrationLease,
  boundary?: AccountMigrationOptions['onBoundary'],
) {
  return async (
    step: MigrationPublicWriteStep,
    info: { operation: string; rowId: string | undefined },
  ) => {
    await lease.assertOwned()
    await assertPublishedAccountStoreGeneration(paths)
    await checkpointStoreStage(modules, paths, lease, step, boundary)
    await boundary?.(`public:${info.operation}:${step}`)
    // checkpointStoreStage already synchronizes the completed real public file
    // before the crash observation hook; repeating those barriers adds no proof.
    await lease.assertOwned()
    await assertPublishedAccountStoreGeneration(paths)
  }
}

async function finishPointerPublication(
  legacyPath: string,
  pointer: AccountStorePointer,
  lease: MigrationLease,
): Promise<void> {
  const path = accountStorePointerPath(legacyPath)
  await syncFile(path)
  await syncDirectory(dirname(path))
  const stage = `${path}.${pointer.id}.tmp`
  if (!(await exists(stage))) return
  const bytes = await secureRead(stage)
  if (
    !isDeepStrictEqual(
      decodeAccountStorePointer(jsonBytes(bytes), legacyPath),
      pointer,
    )
  )
    throw new AccountMigrationError(
      'pointer stage differs from publication authority',
    )
  const [published, temporary] = await Promise.all([lstat(path), lstat(stage)])
  if (published.dev !== temporary.dev || published.ino !== temporary.ino)
    throw new AccountMigrationError(
      'pointer stage is not the published hard link',
    )
  await lease.assertOwned()
  await unlink(stage)
  await syncDirectory(dirname(path))
}
