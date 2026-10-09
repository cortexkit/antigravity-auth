/**
 * Provider-state file ("sidecar") for vault accounts: non-credential
 * Antigravity metadata (label, usage, cooldowns, verification, tier,
 * fingerprint, quota) keyed by the account identity the vault asserted, with
 * the route, credential and record version that last wrote it.
 *
 * The roster (the Claustrum library's non-secret list of vault accounts this
 * host may route to) keeps only the fields the library defines and drops any
 * other field when it rewrites the file, so Antigravity's own state lives in
 * this separate file. Keying by asserted account means a different account
 * inherits nothing, while the same account keeps its state across token
 * refreshes. The file never holds a bearer, refresh or enrollment secret, a
 * receipt or a project (a vault send's project comes from the receipt
 * Claustrum serves for that send attempt); such input is refused, not
 * stripped. The fingerprint `sessionToken` is locally generated tracking
 * metadata, not a credential, and is kept.
 *
 * A write holds the roster lock as an ownership guard (the roster is not
 * rewritten), then this file's lock, re-checks the roster binding and asks the
 * vault for a fresh receipt for the same version, and re-asserts both locks
 * just before the atomic rename.
 *
 * A write must carry the record version its observation was served under.
 * Once the vault serves a newer record version, even for the same account,
 * that write is refused and the observation (usage, quota) is dropped; it is
 * never re-attributed to the newer version.
 */

import { readFile } from 'node:fs/promises'

import {
  AccountCodecError,
  decodeProviderMetadata,
  decodeQuotaState,
  encodeProviderMetadata,
  encodeQuotaState,
} from './account-repository-codecs.ts'
import type {
  JsonObject,
  JsonValue,
  ProviderMetadata,
  QuotaState,
} from './account-repository-types.ts'
import type { CommonAuthFsModule } from './common-auth-runtime.ts'
import type { VaultClaustrumPort, VaultRoster } from './vault-account-source.ts'

export const VAULT_PROVIDER_STATE_SCHEMA_VERSION = 1

/**
 * File lock (`./fs` `withLock`) a commit holds on the state file, so two
 * writers cannot interleave their read and rename.
 */
export const VAULT_PROVIDER_STATE_LOCK = Object.freeze({
  name: 'antigravity-vault-state',
  ttlMs: 10_000,
  timeoutMs: 10_000,
  renew: true,
})

/**
 * The `./fs` lock and atomic-write functions `commitVaultProviderState`
 * uses.
 */
export type AntigravityVaultStateFs = Pick<
  CommonAuthFsModule,
  'withLock' | 'writeJsonAtomic'
>

/**
 * The `./claustrum` functions `commitVaultProviderState` uses: the roster write
 * lock as an ownership guard and the decline check.
 */
export type VaultRosterGuardModule = Pick<
  VaultClaustrumPort,
  'mutateVaultRoster' | 'isDeclined'
>

/**
 * Non-secret facts tying an observation (usage, quota) to the send attempt
 * that produced it: the selected route, the credential id and asserted
 * account, and the record version Claustrum served. Carries no token and no
 * project.
 */
export interface VaultStateAttribution {
  readonly routeId: string
  readonly credentialId: string
  readonly accountIdentity: string
  readonly recordVersion: number
}

/**
 * Provider metadata a vault account may keep. The project fields are left
 * out because a send's project comes only from the receipt Claustrum serves
 * for that attempt, and
 * `enabled` because the roster owns whether an account routes.
 */
export type VaultProviderMetadata = Omit<
  ProviderMetadata,
  'projectId' | 'managedProjectId' | 'enabled'
>

/**
 * The route, credential and served record version of the send whose
 * observation last wrote this state. Kept as a record only; never counted or
 * compared as a local version number.
 */
export interface VaultStateProvenance {
  readonly routeId: string
  readonly credentialId: string
  readonly recordVersion: number
}

export interface VaultAccountState {
  readonly observed: VaultStateProvenance
  readonly metadata?: VaultProviderMetadata
  readonly quota?: QuotaState
  readonly extensions?: JsonObject
}

export interface VaultProviderStateFile {
  readonly schemaVersion: typeof VAULT_PROVIDER_STATE_SCHEMA_VERSION
  readonly accounts: Readonly<Record<string, VaultAccountState>>
  readonly extensions?: JsonObject
}

/**
 * What an update asks to store for the account. `observed` is not part of it:
 * `commitVaultProviderState` sets it from the attribution.
 */
export interface VaultAccountStateValue {
  metadata?: VaultProviderMetadata
  quota?: QuotaState
  extensions?: JsonObject
}

/**
 * Computes the account's next state from its current one. The function must
 * be synchronous and must not start another commit. Return `undefined` to
 * leave the state as it is and `null` to remove the account's entry.
 */
export type AntigravityVaultStateUpdate = (
  current: VaultAccountState | undefined,
) => VaultAccountStateValue | null | undefined

export type VaultProviderStateCommitResult =
  | { status: 'written'; state: VaultAccountState }
  | { status: 'cleared' }
  | { status: 'unchanged'; state?: VaultAccountState }
  /**
   * The write failed part-way; the file may or may not hold the new state.
   * The write is not retried. `state` is what a reload of the file found,
   * when the reload could read it.
   */
  | { status: 'uncertain'; error: unknown; state?: VaultAccountState }

export type VaultProviderStateFailureKind =
  | 'invalid-attribution'
  | 'binding-stale'
  | 'malformed'
  | 'newer-schema'
  | 'credential-material'
  | 'project-field'
  | 'invalid-update'

/**
 * A refused read or commit. Messages name the field path or step that was
 * refused, never the stored value.
 */
export class VaultProviderStateError extends Error {
  readonly kind: VaultProviderStateFailureKind

  constructor(kind: VaultProviderStateFailureKind, message: string) {
    super(message)
    this.name = 'VaultProviderStateError'
    this.kind = kind
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Key names refused anywhere in the file because they hold credentials. Keys
 * are compared lower-case with punctuation removed, so `access_token`,
 * `accessToken` and `access-token` all match `accesstoken`.
 */
const CREDENTIAL_KEYS = new Set([
  'access',
  'accesstoken',
  'refresh',
  'refreshtoken',
  'idtoken',
  'token',
  'bearer',
  'authorization',
  'apikey',
  'key',
  'secret',
  'clientsecret',
  'password',
  'enrollmenttoken',
  'cookie',
  'receipt',
])

/**
 * String values refused anywhere in the file: those starting like a Google
 * access token (`ya29.`), a Google refresh token (`1//`) or an Authorization
 * header (`Bearer `).
 */
const CREDENTIAL_VALUE = /^(?:ya29\.|1\/\/|bearer\s)/i

const PROJECT_KEYS = new Set(['projectid', 'managedprojectid', 'project'])

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * True for `metadata.fingerprint.sessionToken` and for the same field in each
 * `metadata.fingerprintHistory` entry: the one token-named field the file may
 * keep, because it is local tracking metadata.
 */
function isFingerprintSessionToken(path: readonly string[]): boolean {
  const n = path.length
  if (path[n - 1] !== 'sessionToken' || path[n - 2] !== 'fingerprint')
    return false
  if (n === 3 && path[0] === 'metadata') return true
  return n === 5 && path[0] === 'metadata' && path[1] === 'fingerprintHistory'
}

function scanForSecrets(value: unknown, path: string[]): void {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value.trim()) && !isFingerprintSessionToken(path))
      throw new VaultProviderStateError(
        'credential-material',
        `${path.join('.')} holds credential material`,
      )
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      scanForSecrets(item, [...path, `${index}`])
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    const next = [...path, key]
    const name = normalizedKey(key)
    if (CREDENTIAL_KEYS.has(name) && !isFingerprintSessionToken(next))
      throw new VaultProviderStateError(
        'credential-material',
        `${next.join('.')} is a credential field`,
      )
    if (name === 'sessiontoken' && !isFingerprintSessionToken(next))
      throw new VaultProviderStateError(
        'credential-material',
        `${next.join('.')} is a credential field`,
      )
    if (PROJECT_KEYS.has(name))
      throw new VaultProviderStateError(
        'project-field',
        `${next.join('.')} would persist an Antigravity project`,
      )
    scanForSecrets(item, next)
  }
}

function decodeProvenance(raw: unknown, path: string): VaultStateProvenance {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some(
      (key) => !['routeId', 'credentialId', 'recordVersion'].includes(key),
    ) ||
    !isNonEmpty(raw.routeId) ||
    !isNonEmpty(raw.credentialId) ||
    typeof raw.recordVersion !== 'number' ||
    !Number.isSafeInteger(raw.recordVersion) ||
    raw.recordVersion < 0
  )
    throw new VaultProviderStateError(
      'malformed',
      `${path} is not a valid provenance`,
    )
  return Object.freeze({
    routeId: raw.routeId,
    credentialId: raw.credentialId,
    recordVersion: raw.recordVersion,
  })
}

function codecRefusal(error: unknown, path: string): never {
  if (error instanceof AccountCodecError)
    throw new VaultProviderStateError(
      'malformed',
      `${path}: ${error.problem} at ${error.path}`,
    )
  throw error
}

function decodeExtensions(raw: unknown, path: string): JsonObject | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw))
    throw new VaultProviderStateError('malformed', `${path} must be an object`)
  return JSON.parse(JSON.stringify(raw)) as JsonObject
}

/**
 * Decodes the parts of an account entry an update may set: `metadata`,
 * `quota` and `extensions` (never `observed`). `stored` is the JSON form read
 * from the file; `typed` is the in-memory form an update returns, which is
 * encoded first so both pass the same codec checks.
 */
function decodeValue(
  raw: unknown,
  path: string,
  form: 'stored' | 'typed',
): VaultAccountStateValue {
  if (!isRecord(raw))
    throw new VaultProviderStateError('malformed', `${path} must be an object`)
  for (const key of Object.keys(raw))
    if (!['metadata', 'quota', 'extensions'].includes(key))
      throw new VaultProviderStateError(
        'malformed',
        `${path} has an unknown field`,
      )
  scanForSecrets(raw, [])
  const value: VaultAccountStateValue = {}
  if (raw.metadata !== undefined) {
    try {
      value.metadata = decodeProviderMetadata(
        form === 'typed'
          ? encodeProviderMetadata(raw.metadata as ProviderMetadata)
          : raw.metadata,
      )
    } catch (error) {
      codecRefusal(error, `${path}.metadata`)
    }
  }
  if (raw.quota !== undefined) {
    try {
      value.quota = decodeQuotaState(
        form === 'typed'
          ? encodeQuotaState(raw.quota as QuotaState)
          : raw.quota,
      )
    } catch (error) {
      codecRefusal(error, `${path}.quota`)
    }
  }
  const extensions = decodeExtensions(raw.extensions, `${path}.extensions`)
  if (extensions) value.extensions = extensions
  return value
}

function decodeAccount(raw: unknown, path: string): VaultAccountState {
  if (!isRecord(raw))
    throw new VaultProviderStateError('malformed', `${path} must be an object`)
  const { observed, ...rest } = raw
  return Object.freeze({
    observed: decodeProvenance(observed, `${path}.observed`),
    ...decodeValue(rest, path, 'stored'),
  })
}

/**
 * Reads a sidecar value. A newer schema, an unknown field, a credential or a
 * project anywhere in it is refused; nothing is silently dropped.
 */
export function decodeVaultProviderState(raw: unknown): VaultProviderStateFile {
  if (!isRecord(raw) || typeof raw.schemaVersion !== 'number')
    throw new VaultProviderStateError('malformed', 'state file is malformed')
  if (raw.schemaVersion > VAULT_PROVIDER_STATE_SCHEMA_VERSION)
    throw new VaultProviderStateError(
      'newer-schema',
      'state file was written by a newer version',
    )
  if (raw.schemaVersion !== VAULT_PROVIDER_STATE_SCHEMA_VERSION)
    throw new VaultProviderStateError(
      'malformed',
      'state file version is invalid',
    )
  for (const key of Object.keys(raw))
    if (!['schemaVersion', 'accounts', 'extensions'].includes(key))
      throw new VaultProviderStateError(
        'malformed',
        'state file has an unknown field',
      )
  if (!isRecord(raw.accounts))
    throw new VaultProviderStateError('malformed', 'accounts must be an object')
  const accounts: Record<string, VaultAccountState> = {}
  for (const [identity, entry] of Object.entries(raw.accounts)) {
    if (!isNonEmpty(identity))
      throw new VaultProviderStateError('malformed', 'blank account identity')
    accounts[identity] = decodeAccount(entry, 'accounts[]')
  }
  const extensions = decodeExtensions(raw.extensions, 'extensions')
  return Object.freeze({
    schemaVersion: VAULT_PROVIDER_STATE_SCHEMA_VERSION,
    accounts: Object.freeze(accounts),
    ...(extensions && { extensions }),
  })
}

function encodeAccount(state: VaultAccountState): JsonObject {
  const out: JsonObject = {
    observed: {
      routeId: state.observed.routeId,
      credentialId: state.observed.credentialId,
      recordVersion: state.observed.recordVersion,
    },
  }
  if (state.metadata) out.metadata = encodeProviderMetadata(state.metadata)
  if (state.quota) out.quota = encodeQuotaState(state.quota)
  if (state.extensions) out.extensions = state.extensions as JsonValue
  return out
}

export function encodeVaultProviderState(
  file: VaultProviderStateFile,
): JsonObject {
  const accounts: JsonObject = {}
  for (const [identity, state] of Object.entries(file.accounts))
    accounts[identity] = encodeAccount(state)
  const out: JsonObject = {
    schemaVersion: VAULT_PROVIDER_STATE_SCHEMA_VERSION,
    accounts,
  }
  if (file.extensions) out.extensions = file.extensions
  // Decoding what is about to be written enforces the same refusals on writes.
  decodeVaultProviderState(out)
  return out
}

const EMPTY_FILE: VaultProviderStateFile = Object.freeze({
  schemaVersion: VAULT_PROVIDER_STATE_SCHEMA_VERSION,
  accounts: Object.freeze({}),
})

/** Reads the sidecar; a missing file is an empty one, anything unreadable is refused. */
export async function readVaultProviderState(
  statePath: string,
): Promise<VaultProviderStateFile> {
  let text: string
  try {
    text = await readFile(statePath, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return EMPTY_FILE
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultProviderStateError('malformed', 'state file is not JSON')
  }
  return decodeVaultProviderState(raw)
}

/** The stored state of one asserted account, if any. */
export function vaultAccountState(
  file: VaultProviderStateFile,
  accountIdentity: string,
): VaultAccountState | undefined {
  return Object.hasOwn(file.accounts, accountIdentity)
    ? file.accounts[accountIdentity]
    : undefined
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

const ATTRIBUTION_FIELDS = [
  'accountIdentity',
  'credentialId',
  'recordVersion',
  'routeId',
] as const

/**
 * Copies an attribution after checking it is a plain object with exactly the
 * four own data fields, non-blank strings and a non-negative integer version
 * (a boolean, string or fraction is refused). Later checks use only the copy,
 * so a getter or a later mutation cannot move the fence.
 */
function pinAttribution(raw: unknown): VaultStateAttribution {
  const invalid = () =>
    new VaultProviderStateError(
      'invalid-attribution',
      'state commit needs exactly a route, credential, asserted account and record version',
    )
  if (!isRecord(raw) || Object.getPrototypeOf(raw) !== Object.prototype)
    throw invalid()
  const keys = Reflect.ownKeys(raw)
  if (
    keys.length !== ATTRIBUTION_FIELDS.length ||
    !ATTRIBUTION_FIELDS.every((key) => {
      const field = Object.getOwnPropertyDescriptor(raw, key)
      return field !== undefined && 'value' in field && field.enumerable
    })
  )
    throw invalid()
  const { routeId, credentialId, accountIdentity, recordVersion } = raw
  if (
    !isNonEmpty(routeId) ||
    !isNonEmpty(credentialId) ||
    !isNonEmpty(accountIdentity) ||
    typeof recordVersion !== 'number' ||
    !Number.isSafeInteger(recordVersion) ||
    recordVersion < 0
  )
    throw invalid()
  return Object.freeze({
    routeId,
    credentialId,
    accountIdentity,
    recordVersion,
  })
}

/**
 * The roster must still route the attributed credential to the attributed
 * account: the row exists, is enabled, active and not declined, and is
 * neither stale nor unclaimed. A removed account is never brought back by a
 * state write.
 */
function assertRosterBinding(
  roster: VaultRoster | undefined,
  attribution: VaultStateAttribution,
  claustrum: VaultRosterGuardModule,
): void {
  const row = roster?.rows.find(
    (entry) => entry.routeId === attribution.routeId,
  )
  if (
    !roster ||
    !row?.enabled ||
    row.state !== 'active' ||
    row.stale === true ||
    row.unclaimed === true ||
    row.credentialId !== attribution.credentialId ||
    row.accountIdentity !== attribution.accountIdentity ||
    claustrum.isDeclined(
      roster.declined,
      attribution.credentialId,
      attribution.accountIdentity,
    )
  )
    throw new VaultProviderStateError(
      'binding-stale',
      'the vault route no longer serves the attributed credential and account',
    )
}

export interface CommitVaultProviderStateInput {
  claustrum: VaultRosterGuardModule
  fs: AntigravityVaultStateFs
  rosterPath: string
  statePath: string
  attribution: VaultStateAttribution
  /**
   * Fresh proof, while the roster write lock and the state-file lock are both
   * held, that custody is still active, the host's stored credential record
   * is still not a real login, and the vault still serves the attributed
   * credential, account and record version. Throws to refuse. Must not use
   * or keep the proving receipt's token or project.
   */
  verify: (attribution: VaultStateAttribution) => Promise<void>
  update: AntigravityVaultStateUpdate
}

export async function commitVaultProviderState(
  input: CommitVaultProviderStateInput,
): Promise<VaultProviderStateCommitResult> {
  const { claustrum, fs, statePath } = input
  const attribution = pinAttribution(input.attribution)
  const identity = attribution.accountIdentity
  return claustrum.mutateVaultRoster(
    input.rosterPath,
    async (roster, rosterLock) => {
      assertRosterBinding(roster, attribution, claustrum)
      const result = await fs.withLock(
        statePath,
        VAULT_PROVIDER_STATE_LOCK,
        async (stateLock): Promise<VaultProviderStateCommitResult> => {
          await input.verify(attribution)
          const file = await readVaultProviderState(statePath)
          const current = vaultAccountState(file, identity)
          const requested: unknown = input.update(current)
          if (
            isRecord(requested) &&
            typeof (requested as { then?: unknown }).then === 'function'
          )
            throw new VaultProviderStateError(
              'invalid-update',
              'a state update must be synchronous',
            )
          if (requested === undefined)
            return current
              ? { status: 'unchanged', state: current }
              : { status: 'unchanged' }
          const accounts: Record<string, VaultAccountState> = {
            ...file.accounts,
          }
          let next: VaultAccountState | undefined
          if (requested === null) {
            if (!current) return { status: 'unchanged' }
            delete accounts[identity]
          } else {
            next = Object.freeze({
              observed: Object.freeze({
                routeId: attribution.routeId,
                credentialId: attribution.credentialId,
                recordVersion: attribution.recordVersion,
              }),
              ...decodeValue(requested, 'update', 'typed'),
            })
            accounts[identity] = next
          }
          const encoded = encodeVaultProviderState({ ...file, accounts })
          try {
            await fs.writeJsonAtomic(statePath, encoded, {
              beforeRename: async () => {
                await rosterLock.assertOwned()
                await stateLock.assertOwned()
              },
            })
          } catch (error) {
            let reloaded: VaultAccountState | undefined
            try {
              reloaded = vaultAccountState(
                await readVaultProviderState(statePath),
                identity,
              )
            } catch {
              reloaded = undefined
            }
            return reloaded
              ? { status: 'uncertain', error, state: reloaded }
              : { status: 'uncertain', error }
          }
          return next
            ? { status: 'written', state: next }
            : { status: 'cleared' }
        },
      )
      return { result }
    },
  )
}
