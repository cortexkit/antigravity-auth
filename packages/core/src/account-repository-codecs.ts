/**
 * Pure codecs for the Antigravity values the account store keeps for each
 * row: the provider metadata beside its credential in the state file, the
 * latest quota reading in its config entry, and the account selection kept in
 * plugin settings.
 *
 * The store never interprets these values itself; it asks the codec whether a
 * value is valid before every write and on every load. A value the codec
 * refuses is hidden from readers but kept on disk, so these codecs refuse
 * anything malformed instead of filtering it: dropping a bad field here
 * would rewrite the user's data with the field silently gone.
 *
 * Decoding turns the stored JSON into the typed shapes of
 * `account-repository-types.ts`, moving unrecognised keys into `extensions`;
 * encoding puts them back. Both directions validate fully and return fresh
 * copies, keep absent and `null` apart, and keep every dynamic map key and
 * array order. Migration from older file versions is not done here.
 */

import {
  type ConfiguredProviderStateCodec,
  CREDENTIAL_BOUND_METADATA_FIELDS,
  type JsonObject,
  type JsonValue,
  PROVIDER_STATE_SCHEMA_VERSION,
  type ProviderMetadata,
  type ProviderStateEnvelope,
  type ProviderStatePolicy,
  QUOTA_STATE_SCHEMA_VERSION,
  type QuotaCodecContract,
  type QuotaState,
  ROUTING_SETTINGS_SCHEMA_VERSION,
  type RoutingSettings,
  type RowRef,
} from './account-repository-types.ts'

/**
 * Thrown for a value a codec refuses. The message names where and why, never
 * the value itself: the values can hold emails, labels and other personal
 * data.
 */
export class AccountCodecError extends Error {
  readonly path: string
  readonly problem: string

  constructor(path: string, problem: string) {
    super(`${path} ${problem}`)
    this.name = 'AccountCodecError'
    this.path = path
    this.problem = problem
  }
}

function fail(path: string, problem: string): never {
  throw new AccountCodecError(path, problem)
}

interface Codec<T> {
  decode(raw: unknown, path: string): T
  encode(value: unknown, path: string): JsonValue
}

/** Deep enough for any real value; a guard against runaway nesting. */
const MAX_JSON_DEPTH = 64

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$-]*$/

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return IDENTIFIER.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The own entries of a plain JSON object, refusing anything a JSON round trip
 * would lose or that is unsafe to copy by assignment: symbol keys, hidden or
 * accessor properties, and a `__proto__` key (which `JSON.parse` creates as
 * an ordinary key but assignment would turn into a prototype change).
 */
function objectEntries(value: unknown, path: string): [string, unknown][] {
  if (!isPlainObject(value)) fail(path, 'must be a JSON object')
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, 'has symbol keys, which JSON cannot hold')
  }
  const names = Object.getOwnPropertyNames(value)
  const entries: [string, unknown][] = []
  for (const key of names) {
    const at = childPath(path, key)
    if (key === '__proto__') fail(at, 'is a prototype key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      fail(at, 'is not a plain enumerable data property')
    }
    entries.push([key, descriptor.value])
  }
  return entries
}

function arrayItems(value: unknown, path: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(path, 'must be a JSON array')
  }
  const names = Object.getOwnPropertyNames(value)
  // An array's own names are its indices plus `length`; anything else is a
  // property JSON would drop.
  if (names.length !== value.length + 1) {
    fail(path, 'has holes or non-index properties, which JSON cannot hold')
  }
  return Array.from(value)
}

function jsonCopy(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite number')
    return value
  }
  if (typeof value !== 'object') fail(path, 'is not a JSON value')
  if (depth >= MAX_JSON_DEPTH) fail(path, 'is nested too deeply')
  if (ancestors.has(value)) fail(path, 'is circular')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return arrayItems(value, path).map((item, index) =>
        jsonCopy(item, childPath(path, index), depth + 1, ancestors),
      )
    }
    const out: JsonObject = {}
    for (const [key, item] of objectEntries(value, path)) {
      out[key] = jsonCopy(item, childPath(path, key), depth + 1, ancestors)
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

/** Any JSON value, copied; used for data this build does not recognise. */
const jsonValue: Codec<JsonValue> = {
  decode: (raw, path) => jsonCopy(raw, path, 0, new Set()),
  encode: (value, path) => jsonCopy(value, path, 0, new Set()),
}

/** A codec whose stored and typed forms are the same primitive. */
function primitive<T extends JsonValue>(
  check: (value: unknown) => value is T,
  expected: string,
): Codec<T> {
  const read = (value: unknown, path: string): T =>
    check(value) ? value : fail(path, `must be ${expected}`)
  return { decode: read, encode: read }
}

const string = primitive(
  (value): value is string => typeof value === 'string',
  'a string',
)

const nonEmptyString = primitive(
  (value): value is string => typeof value === 'string' && value.length > 0,
  'a non-empty string',
)

const finiteNumber = primitive(
  (value): value is number =>
    typeof value === 'number' && Number.isFinite(value),
  'a finite number',
)

const count = primitive(
  (value): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  'a non-negative integer',
)

const credentialEpoch = primitive(
  (value): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  'a positive safe integer',
)

const boolean = primitive(
  (value): value is boolean => typeof value === 'boolean',
  'a boolean',
)

/**
 * A row id as the store accepts it: stored exactly as given, so an id that
 * older readers would trim or that names an object prototype member is
 * refused rather than rewritten.
 */
const rowId = primitive(
  (value): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !(value in Object.prototype),
  'a non-empty id without surrounding whitespace or prototype names',
)

function enumOf<const V extends readonly string[]>(
  values: V,
): Codec<V[number]> {
  return primitive(
    (value): value is V[number] =>
      typeof value === 'string' && values.includes(value),
    `one of ${values.map((value) => JSON.stringify(value)).join(', ')}`,
  )
}

/**
 * The schema version this build writes. A higher one comes from a newer
 * build whose meaning this one cannot know, so it is refused, not read as
 * the current one.
 */
function schemaVersion<V extends number>(version: V): Codec<V> {
  const read = (value: unknown, path: string): V => {
    if (value === version) return version
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > version
    ) {
      fail(path, `is a newer schema version than ${version}`)
    }
    return fail(path, `must be ${version}`)
  }
  return { decode: read, encode: read }
}

function nullable<T>(codec: Codec<T>): Codec<T | null> {
  return {
    decode: (raw, path) => (raw === null ? null : codec.decode(raw, path)),
    encode: (value, path) =>
      value === null ? null : codec.encode(value, path),
  }
}

function arrayOf<T>(codec: Codec<T>): Codec<T[]> {
  return {
    decode: (raw, path) =>
      arrayItems(raw, path).map((item, index) =>
        codec.decode(item, childPath(path, index)),
      ),
    encode: (value, path) =>
      arrayItems(value, path).map((item, index) =>
        codec.encode(item, childPath(path, index)),
      ),
  }
}

/** A map with caller-chosen keys; every key is data and is kept. */
function mapOf<T>(codec: Codec<T>): Codec<Record<string, T>> {
  return {
    decode(raw, path) {
      const out: Record<string, T> = {}
      for (const [key, item] of objectEntries(raw, path)) {
        out[key] = codec.decode(item, childPath(path, key))
      }
      return out
    },
    encode(value, path) {
      const out: JsonObject = {}
      for (const [key, item] of objectEntries(value, path)) {
        out[key] = codec.encode(item, childPath(path, key))
      }
      return out
    },
  }
}

interface Field<T, Required extends boolean> {
  readonly codec: Codec<T>
  readonly required: Required
}

type Shape = Readonly<Record<string, Field<unknown, boolean>>>

const required = <T>(codec: Codec<T>): Field<T, true> => ({
  codec,
  required: true,
})
const optional = <T>(codec: Codec<T>): Field<T, false> => ({
  codec,
  required: false,
})

type FieldValue<F> = F extends Field<infer T, boolean> ? T : never
type RequiredKeys<S extends Shape> = {
  [K in keyof S]: S[K]['required'] extends true ? K : never
}[keyof S]
type Fields<S extends Shape> = {
  [K in RequiredKeys<S>]: FieldValue<S[K]>
} & {
  [K in Exclude<keyof S, RequiredKeys<S>>]?: FieldValue<S[K]>
}
type Open<S extends Shape> = Fields<S> & { extensions?: JsonObject }

/** Key of the typed slot holding keys the shape does not know. */
const EXTENSIONS = 'extensions'

interface RecordOptions {
  /**
   * Keys refused outright, with the reason, rather than kept as unknown
   * data: a credential must never be stored here, and a field owned by
   * another value must not be duplicated into this one.
   */
  forbidden?: Readonly<Record<string, string>>
}

function buildRecord<S extends Shape>(
  shape: S,
  open: boolean,
  options: RecordOptions,
): Codec<Record<string, unknown>> {
  const forbidden = options.forbidden ?? {}
  const knownField = (key: string) =>
    Object.hasOwn(shape, key) ? shape[key] : undefined
  const refusal = (key: string) =>
    Object.hasOwn(forbidden, key) ? forbidden[key] : undefined
  const requireFields = (present: Record<string, unknown>, path: string) => {
    for (const [key, field] of Object.entries(shape)) {
      if (field.required && !Object.hasOwn(present, key)) {
        fail(childPath(path, key), 'is required')
      }
    }
  }

  return {
    decode(raw, path) {
      const out: Record<string, unknown> = {}
      let extensions: JsonObject | undefined
      for (const [key, value] of objectEntries(raw, path)) {
        const at = childPath(path, key)
        const field = knownField(key)
        if (field) {
          out[key] = field.codec.decode(value, at)
          continue
        }
        const reason = refusal(key)
        if (reason !== undefined) fail(at, reason)
        if (!open) fail(at, 'is not a known field')
        extensions ??= {}
        extensions[key] = jsonValue.decode(value, at)
      }
      requireFields(out, path)
      if (extensions) out[EXTENSIONS] = extensions
      return out
    },
    encode(value, path) {
      const out: JsonObject = {}
      let extensions: unknown
      for (const [key, item] of objectEntries(value, path)) {
        const at = childPath(path, key)
        if (open && key === EXTENSIONS) {
          extensions = item
          continue
        }
        const field = knownField(key)
        if (!field) {
          fail(
            at,
            open
              ? 'is not a known field; unknown data belongs in extensions'
              : 'is not a known field',
          )
        }
        if (item === undefined) {
          fail(at, 'is undefined; leave the key out to keep it absent')
        }
        out[key] = field.codec.encode(item, at)
      }
      requireFields(out, path)
      if (extensions !== undefined) {
        const extensionsPath = childPath(path, EXTENSIONS)
        for (const [key, item] of objectEntries(extensions, extensionsPath)) {
          const at = childPath(extensionsPath, key)
          if (knownField(key)) fail(at, 'collides with a known field')
          const reason = refusal(key)
          if (reason !== undefined) fail(at, reason)
          out[key] = jsonValue.encode(item, at)
        }
      }
      return out
    },
  }
}

/** An object whose unknown keys are kept in `extensions`. */
function openRecord<S extends Shape>(
  shape: S,
  options: RecordOptions = {},
): Codec<Open<S>> {
  // The record builder checks every field against `shape`, which is exactly
  // what `Open<S>` describes; TypeScript cannot follow that through the
  // generic loop, hence the one narrowing here.
  return buildRecord(shape, true, options) as Codec<Open<S>>
}

/** An object that refuses keys it does not know. */
function closedRecord<S extends Shape>(shape: S): Codec<Fields<S>> {
  return buildRecord(shape, false, {}) as Codec<Fields<S>>
}

// ---------------------------------------------------------------------------
// Field rules shared by the shapes below
// ---------------------------------------------------------------------------

const CREDENTIAL_REFUSAL =
  "is a credential field; credentials live only in the store's own credential entry"

/** Keys that would put a credential into the metadata or quota values. */
const CREDENTIAL_KEYS: Readonly<Record<string, string>> = {
  refreshToken: CREDENTIAL_REFUSAL,
  accessToken: CREDENTIAL_REFUSAL,
  access: CREDENTIAL_REFUSAL,
  refresh: CREDENTIAL_REFUSAL,
  expires: CREDENTIAL_REFUSAL,
  apiKey: CREDENTIAL_REFUSAL,
}

const POOL_FIELD_REFUSAL =
  "belongs to the store's roster or to the routing settings, not provider metadata"
const QUOTA_FIELD_REFUSAL = 'belongs to the quota value, not provider metadata'
const LEGACY_FIELD_REFUSAL =
  'is a pre-v4 field; the migration normalises it before import'
const METADATA_FIELD_REFUSAL = 'belongs to provider metadata, not quota'

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

const clientMetadataCodec = openRecord({
  ideType: required(string),
  platform: required(string),
  pluginType: required(string),
})

const fingerprintCodec = openRecord({
  deviceId: required(string),
  sessionToken: required(string),
  userAgent: required(string),
  apiClient: required(string),
  clientMetadata: required(clientMetadataCodec),
  createdAt: required(finiteNumber),
})

const fingerprintVersionCodec = openRecord({
  fingerprint: required(fingerprintCodec),
  timestamp: required(finiteNumber),
  reason: required(enumOf(['initial', 'regenerated', 'restored'] as const)),
})

const dailyRequestCountsCodec = openRecord({
  date: required(string),
  claude: required(count),
  gemini: required(count),
})

const metadataShape = {
  email: optional(nullable(string)),
  projectId: optional(nullable(string)),
  managedProjectId: optional(nullable(string)),
  addedAt: required(finiteNumber),
  lastUsed: required(finiteNumber),
  enabled: optional(nullable(boolean)),
  lastSwitchReason: optional(
    nullable(enumOf(['rate-limit', 'initial', 'rotation'] as const)),
  ),
  rateLimitResetTimes: optional(nullable(mapOf(nullable(finiteNumber)))),
  coolingDownUntil: optional(nullable(finiteNumber)),
  cooldownReason: optional(
    nullable(
      enumOf([
        'auth-failure',
        'network-error',
        'project-error',
        'validation-required',
      ] as const),
    ),
  ),
  label: optional(nullable(string)),
  fingerprint: optional(nullable(fingerprintCodec)),
  fingerprintHistory: optional(nullable(arrayOf(fingerprintVersionCodec))),
  verificationRequired: optional(nullable(boolean)),
  verificationRequiredAt: optional(nullable(finiteNumber)),
  verificationRequiredReason: optional(nullable(string)),
  verificationUrl: optional(nullable(string)),
  accountIneligible: optional(nullable(boolean)),
  accountIneligibleAt: optional(nullable(finiteNumber)),
  accountIneligibleReason: optional(nullable(string)),
  eligibilityStateUpdatedAt: optional(nullable(finiteNumber)),
  capturedTierId: optional(nullable(string)),
  capturedPaidTierId: optional(nullable(string)),
  capturedTierAt: optional(nullable(finiteNumber)),
  capturedTierSchemaVersion: optional(nullable(finiteNumber)),
  dailyRequestCounts: optional(nullable(dailyRequestCountsCodec)),
} as const

const quotaShape = {
  schemaVersion: required(schemaVersion(QUOTA_STATE_SCHEMA_VERSION)),
  cachedQuotaAccountId: optional(nullable(string)),
  cachedQuota: optional(
    nullable(
      mapOf(
        openRecord({
          remainingFraction: optional(nullable(finiteNumber)),
          resetTime: optional(nullable(string)),
          modelCount: required(finiteNumber),
          windows: optional(
            nullable(
              arrayOf(
                openRecord({
                  window: required(enumOf(['weekly', '5h'] as const)),
                  remainingFraction: required(finiteNumber),
                  resetTime: required(string),
                }),
              ),
            ),
          ),
        }),
      ),
    ),
  ),
  cachedPerModelQuota: optional(
    nullable(
      arrayOf(
        openRecord({
          modelId: required(string),
          displayName: optional(nullable(string)),
          group: required(nullable(string)),
          remainingFraction: required(finiteNumber),
          resetTime: optional(nullable(string)),
        }),
      ),
    ),
  ),
  cachedQuotaUpdatedAt: optional(nullable(finiteNumber)),
} as const

const metadataForbidden: Readonly<Record<string, string>> = {
  ...CREDENTIAL_KEYS,
  version: POOL_FIELD_REFUSAL,
  accounts: POOL_FIELD_REFUSAL,
  activeIndex: POOL_FIELD_REFUSAL,
  activeIndexByFamily: POOL_FIELD_REFUSAL,
  isRateLimited: LEGACY_FIELD_REFUSAL,
  rateLimitResetTime: LEGACY_FIELD_REFUSAL,
  ...Object.fromEntries(
    Object.keys(quotaShape)
      .filter((key) => key !== 'schemaVersion')
      .map((key) => [key, QUOTA_FIELD_REFUSAL]),
  ),
}

const quotaForbidden: Readonly<Record<string, string>> = {
  ...CREDENTIAL_KEYS,
  ...Object.fromEntries(
    Object.keys(metadataShape).map((key) => [key, METADATA_FIELD_REFUSAL]),
  ),
}

const metadataCodec = openRecord(metadataShape, {
  forbidden: metadataForbidden,
})

const providerStateCodec = openRecord(
  {
    schemaVersion: required(schemaVersion(PROVIDER_STATE_SCHEMA_VERSION)),
    metadata: required(metadataCodec),
  },
  { forbidden: CREDENTIAL_KEYS },
)

const quotaCodec = openRecord(quotaShape, { forbidden: quotaForbidden })

// ---------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------

const rowRefCodec = closedRecord({
  id: required(rowId),
  credentialEpoch: required(credentialEpoch),
  identity: optional(nonEmptyString),
})

const routingCodec = openRecord(
  {
    schemaVersion: required(schemaVersion(ROUTING_SETTINGS_SCHEMA_VERSION)),
    activeIndex: optional(nullable(finiteNumber)),
    activeIndexByFamily: optional(
      nullable(
        openRecord({
          claude: optional(nullable(finiteNumber)),
          gemini: optional(nullable(finiteNumber)),
        }),
      ),
    ),
    activeRow: optional(nullable(rowRefCodec)),
    activeRowByFamily: optional(
      nullable(
        openRecord({
          claude: optional(nullable(rowRefCodec)),
          gemini: optional(nullable(rowRefCodec)),
        }),
      ),
    ),
  },
  { forbidden: CREDENTIAL_KEYS },
)

// The decoded shapes must be exactly the public contract types. Mutual
// assignability alone would accept an optional field present on one side
// only, so `Exact` also compares the key sets, at every nested object and
// array element; a field added to one side and not the other fails the
// typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Exact<A, B> =
  Same<A, B> extends true
    ? [A] extends [readonly (infer ItemA)[]]
      ? [B] extends [readonly (infer ItemB)[]]
        ? Exact<NonNullable<ItemA>, NonNullable<ItemB>>
        : false
      : [A] extends [object]
        ? Same<keyof A, keyof B> extends true
          ? {
              [K in keyof A]-?: Exact<
                NonNullable<A[K]>,
                NonNullable<K extends keyof B ? B[K] : never>
              >
            }[keyof A] extends true
            ? true
            : false
          : false
        : true
    : false
type CodecContractCheck = [
  Exact<ReturnType<typeof metadataCodec.decode>, ProviderMetadata>,
  Exact<ReturnType<typeof providerStateCodec.decode>, ProviderStateEnvelope>,
  Exact<ReturnType<typeof quotaCodec.decode>, QuotaState>,
  Exact<ReturnType<typeof routingCodec.decode>, RoutingSettings>,
  Exact<ReturnType<typeof rowRefCodec.decode>, RowRef>,
] extends [true, true, true, true, true]
  ? true
  : never
const codecContractHolds: CodecContractCheck = true
void codecContractHolds

function asObject(value: JsonValue): JsonObject {
  // Every record codec encodes to an object; this only narrows the type.
  return isPlainObject(value)
    ? (value as JsonObject)
    : fail('$', 'did not encode to an object')
}

function validates(read: (raw: unknown) => unknown, raw: unknown): boolean {
  try {
    read(raw)
    return true
  } catch (error) {
    if (error instanceof AccountCodecError) return false
    throw error
  }
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays in order.
 * The store digests the credential-bound projection, so equal values must
 * serialise identically whatever order their keys were written in.
 */
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const out: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (item !== undefined) out[key] = canonical(item)
  }
  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Reads a stored provider state; throws `AccountCodecError` when refused. */
export function decodeProviderState(raw: unknown): ProviderStateEnvelope {
  return providerStateCodec.decode(raw, '$')
}

/** Produces the JSON to store for a provider state; throws when invalid. */
export function encodeProviderState(value: ProviderStateEnvelope): JsonObject {
  return asObject(providerStateCodec.encode(value, '$'))
}

/** Reads one row's metadata on its own (without the envelope). */
export function decodeProviderMetadata(raw: unknown): ProviderMetadata {
  return metadataCodec.decode(raw, '$.metadata')
}

export function encodeProviderMetadata(value: ProviderMetadata): JsonObject {
  return asObject(metadataCodec.encode(value, '$.metadata'))
}

export function isValidProviderState(raw: unknown): boolean {
  return validates(decodeProviderState, raw)
}

/**
 * The credential-bound projection of a stored provider state: the schema
 * version and every field named in `CREDENTIAL_BOUND_METADATA_FIELDS` that
 * is present (a `null` counts as present), with keys sorted at every depth.
 * Unknown top-level metadata is left out: nothing says it describes the
 * signed-in account. Throws for an invalid value; the store only asks for
 * valid ones.
 */
export function providerStateCredentialBound(raw: unknown): JsonObject {
  const stored = encodeProviderState(decodeProviderState(raw))
  const metadata = asObject(stored.metadata ?? null)
  const bound: JsonObject = {}
  for (const key of CREDENTIAL_BOUND_METADATA_FIELDS) {
    const value = metadata[key]
    if (value !== undefined) bound[key] = value
  }
  return asObject(
    canonical({
      schemaVersion: PROVIDER_STATE_SCHEMA_VERSION,
      metadata: bound,
    }),
  )
}

/** Reads a stored quota value; throws `AccountCodecError` when refused. */
export function decodeQuotaState(raw: unknown): QuotaState {
  return quotaCodec.decode(raw, '$')
}

export function encodeQuotaState(value: QuotaState): JsonObject {
  return asObject(quotaCodec.encode(value, '$'))
}

export function isValidQuotaState(raw: unknown): boolean {
  return validates(decodeQuotaState, raw)
}

/**
 * Combines a stored quota value with a new reading. A reading is complete
 * for every field it carries, so each present top-level field (and each
 * unknown key) replaces the stored one wholesale; fields the reading leaves
 * out are kept. Both values must be valid.
 */
export function mergeQuotaState(
  stored: unknown | undefined,
  observation: unknown,
): JsonObject {
  const incoming = encodeQuotaState(decodeQuotaState(observation))
  if (stored === undefined) return incoming
  const prior = encodeQuotaState(decodeQuotaState(stored))
  return encodeQuotaState(decodeQuotaState({ ...prior, ...incoming }))
}

/** Reads the routing settings value; throws `AccountCodecError` when refused. */
export function decodeRoutingSettings(raw: unknown): RoutingSettings {
  return routingCodec.decode(raw, '$')
}

export function encodeRoutingSettings(value: RoutingSettings): JsonObject {
  return asObject(routingCodec.encode(value, '$'))
}

export function decodeRowRef(raw: unknown): RowRef {
  return rowRefCodec.decode(raw, '$')
}

export function encodeRowRef(value: RowRef): JsonObject {
  return asObject(rowRefCodec.encode(value, '$'))
}

/**
 * The provider-state codec to open the store with. The repository's merge
 * and replacement rules are required: without them the store would fall
 * back to its defaults (incoming metadata replacing the stored metadata on a
 * refresh, a replace keeping only what it was handed), silently bypassing
 * those rules. A policy missing either rule is refused here, before any
 * store is opened.
 *
 * The rules see decoded values and return decoded values; the codec
 * validates both sides, so a rule can neither be shown nor store malformed
 * metadata, and a rule that returns nothing from `merge` is refused rather
 * than read as "clear".
 */
export function createProviderStateCodec(
  policy: ProviderStatePolicy,
): ConfiguredProviderStateCodec {
  if (policy === null || typeof policy !== 'object') {
    fail('policy', 'must be an object with merge and onReplace rules')
  }
  for (const rule of ['merge', 'onReplace'] as const) {
    if (typeof policy[rule] !== 'function') {
      fail(
        `policy.${rule}`,
        "must be a function; the store's default would bypass the repository's rule",
      )
    }
  }
  return {
    validate: isValidProviderState,
    credentialBound: providerStateCredentialBound,
    merge(onDisk, incoming) {
      return encodeProviderState(
        policy.merge(
          decodeProviderState(onDisk),
          decodeProviderState(incoming),
        ),
      )
    },
    onReplace(previous, replacement) {
      const next = policy.onReplace(
        previous === undefined ? undefined : decodeProviderState(previous),
        {
          id: replacement.id,
          credentialEpoch: replacement.credentialEpoch,
          ...(replacement.identity !== undefined
            ? { identity: replacement.identity }
            : {}),
          ...(replacement.incoming !== undefined
            ? { incoming: decodeProviderState(replacement.incoming) }
            : {}),
        },
      )
      return next === undefined ? undefined : encodeProviderState(next)
    },
  }
}

/**
 * The quota codec to open the store with. Its merge is the whole quota rule
 * (`mergeQuotaState`), so it needs no configuration.
 */
export const QUOTA_CODEC: QuotaCodecContract = {
  validate: isValidQuotaState,
  merge: mergeQuotaState,
}
