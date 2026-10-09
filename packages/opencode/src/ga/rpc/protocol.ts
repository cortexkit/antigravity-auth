/**
 * RPC contract between this plugin's server side and its clients (the TUI and
 * test tools) on OpenCode 2. "OpenCode 2" means the 2.x host line; this
 * contract targets its 2.0.22 release, whose plugin API lets a server plugin
 * register named RPC methods. "OpenCode 1" is the 1.x host line, where the
 * same dialogs talk to this plugin through its own loopback HTTP RPC
 * (`src/rpc/`).
 *
 * `antigravity-auth`, protocol version 1, and the methods `state` and `apply`
 * are names this plugin defines. They are not existing host or provider APIs.
 * The OpenCode 2.0.22 host routes `POST /api/rpc/:rpcID/:method` with body
 * `{ input }` to the definition registered under that id at the requested
 * location, and answers `{ output? }` (its generated client's `rpc.call`).
 * The host validates input before calling the handler, and validates output
 * before answering, with the schemas in the definition. It accepts Standard
 * Schema V1 objects as schemas, so every schema below is a Standard Schema
 * object backed by a strict hand-written validator.
 *
 * Portability: this module has no runtime imports. Clients can bundle it
 * without pulling in server, account, OAuth or credential code. Its imports
 * are type-only: the request, result and payload types of the Antigravity
 * menu (`/antigravity`), defined by `@cortexkit/common-auth/commands` and
 * carried by the OpenCode 1 RPC as well, and core's name for that command.
 *
 * Contract rules (each has a test in `protocol.test.ts`):
 *
 * - Version: every input and output carries `version: 1`. Any other value,
 *   including the string `"1"`, is refused before any effect.
 * - Generation: each server activation (one plugin setup at one location) has
 *   an opaque generation token. `state` with `generation: null` asks for the
 *   current one. A `state` with a different generation is answered with
 *   `reset: 'generation-changed'` and the scope's notifications restart at
 *   cursor 0. `apply` requires the current generation and is answered with
 *   `kind: 'stale-generation'` and no effect otherwise.
 * - Scope: `{ kind: 'session', sessionID }` or `{ kind: 'sessionless' }`.
 *   Scopes are disjoint: a session scope sees only that session's
 *   notifications and route; the sessionless scope sees only notifications
 *   raised without a session. Omitting a session never widens access.
 * - Cursor: a non-negative safe integer per scope. Notifications carry
 *   cursors starting at 1. Sending cursor `c` acknowledges everything up to
 *   `c`; the answer holds the next notifications after `c`, at most
 *   `MAX_NOTIFICATIONS_PER_STATE`, with `more` set when further ones remain.
 *   A cursor ahead of the scope's last issued cursor is answered with
 *   `reset: 'cursor-ahead'` and delivery from cursor 0. `dropped` counts
 *   notifications evicted before the client acknowledged them.
 * - Disposal: once an activation is disposed, both methods answer
 *   `kind: 'disposed'` with that activation's generation, and a late
 *   completion from it never touches a newer activation.
 * - Redaction: accounts are ordinal (`acct-<n>`, `Account <n+1>`) and carry
 *   only enabled/current/health/cooldown/quota percentages and plan tier.
 *   There is no field for an email, token, project id, fingerprint, profile
 *   name or upstream error text, and unknown keys are refused, so a live
 *   account object spread into a DTO fails validation.
 * - Menu: the GA `apply` input carries one action of the Antigravity menu,
 *   a `CommandApplyRequest` of `@cortexkit/common-auth/commands` without
 *   `sessionId`; the server sets `sessionId` from the input's scope. The
 *   answer is that module's `CommandApplyResult`, which holds the refreshed
 *   menu. A notification carries either the Antigravity menu payload (the
 *   client opens the menu) or a message for a toast. Menu actions name an
 *   account by the opaque item id the menu issued for its current
 *   credential; account positions and `acct-<n>` ids are never targets.
 * - Selectors: each account in a snapshot carries an opaque random
 *   `selector` naming its current credential, so a client can tell a
 *   replaced credential from the same one across reads.
 * - Account limit: a roster larger than `ANTIGRAVITY_RPC_LIMITS.accounts` is
 *   answered with `accountsStatus: over-limit` and no accounts, never with a
 *   shortened list.
 * - Settings: every snapshot carries the location's current operator
 *   settings, so a client never needs an `apply` to read them.
 * - Validation never coerces: `true`, `"5"`, `5.5`, `-1`, `-0`, `NaN` and
 *   `Infinity` are not cursors, and no value is passed through `Number()`.
 *   Issue messages name the field, never the received value, so a rejected
 *   menu value (which can hold a pasted OAuth code) is not echoed back.
 */

import type { ANTIGRAVITY_MENU_COMMAND } from '@cortexkit/antigravity-auth-core'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  RpcNotificationPayload,
} from '../../rpc/protocol.ts'

// Identity

/** The RPC id this adapter registers. Chosen by this adapter, not the host. */
export const ANTIGRAVITY_RPC_ID = 'antigravity-auth' as const

/** The only protocol version this module accepts and produces. */
export const ANTIGRAVITY_RPC_VERSION = 1 as const

export const ANTIGRAVITY_RPC_METHODS = ['state', 'apply'] as const
export type AntigravityRpcMethod = (typeof ANTIGRAVITY_RPC_METHODS)[number]

/** Event published to the location when a notification is queued. */
export const ANTIGRAVITY_RPC_EVENTS = ['changed'] as const
export type AntigravityRpcEvent = (typeof ANTIGRAVITY_RPC_EVENTS)[number]

/** The shared menu's slash command; every menu request and payload names it. */
export const ANTIGRAVITY_MENU_COMMAND_NAME = 'antigravity' as const

// Compile-time guard: core builds the shared menu under this same command.
const MENU_COMMAND_MATCHES_CORE: typeof ANTIGRAVITY_MENU_COMMAND =
  ANTIGRAVITY_MENU_COMMAND_NAME
void MENU_COMMAND_MATCHES_CORE

export const ANTIGRAVITY_LOG_LEVELS = [
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const
export type AntigravityLogLevel = (typeof ANTIGRAVITY_LOG_LEVELS)[number]

// Limits

export const ANTIGRAVITY_RPC_LIMITS = {
  /** Generation tokens: 1–64 characters of `[A-Za-z0-9_-]`. */
  generationMaxLength: 64,
  /** Session ids: 1–256 visible ASCII characters (0x21–0x7E). */
  sessionIDMaxLength: 256,
  /** Menu ids (command, section, item, action, knob, choice values). */
  menuIdMaxLength: 256,
  /** Knob values in one menu request. */
  menuValues: 64,
  /** Sections in one menu. */
  menuSections: 16,
  /** Items in one menu section. */
  menuItemsPerSection: 512,
  /** Actions on one section or item. */
  menuActions: 64,
  /** Knobs on one action. */
  menuKnobs: 64,
  /** Choices of one `choice` knob. */
  menuChoices: 256,
  /** Read-only lines of one section. */
  menuLines: 256,
  /** Entries in one `facts` record. */
  menuFacts: 64,
  /** Nesting depth of a `facts` value. */
  menuFactsDepth: 4,
  /** Any user-facing text in an output. */
  textMaxLength: 4096,
  /** Notifications returned by one `state` call. */
  notificationsPerState: 32,
  /** Accounts in one output. */
  accounts: 64,
  /** Quota windows per pool entry. */
  quotaWindows: 4,
  /** Maximum length of a plan tier id. */
  tierIDMaxLength: 128,
  /** OAuth authorization URLs handed to the user. */
  authorizationURLMaxLength: 4096,
} as const

export const MAX_NOTIFICATIONS_PER_STATE =
  ANTIGRAVITY_RPC_LIMITS.notificationsPerState

// Wire types

export type AntigravityRpcScope =
  | { readonly kind: 'session'; readonly sessionID: string }
  | { readonly kind: 'sessionless' }

export interface AntigravityStateInput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  /** The generation the client last saw, or `null` on first contact. */
  readonly generation: string | null
  readonly scope: AntigravityRpcScope
  /** Highest notification cursor the client has received in this scope. */
  readonly cursor: number
}

/**
 * The `request` of a GA `apply` input: one Antigravity menu action, as
 * `@cortexkit/common-auth/commands`' `CommandApplyRequest` for the
 * `antigravity` command without `sessionId`. The server derives `sessionId`
 * from the input's scope; a request that names one itself is refused.
 */
export type AntigravityMenuRequest = Omit<
  CommandApplyRequest,
  'command' | 'sessionId'
> & {
  readonly command: typeof ANTIGRAVITY_MENU_COMMAND_NAME
}

export interface AntigravityApplyInput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  /**
   * Must equal the generation of the activation serving this location;
   * anything else is answered `stale-generation` without an effect.
   */
  readonly generation: string
  readonly scope: AntigravityRpcScope
  readonly request: AntigravityMenuRequest
}

export interface AntigravityQuotaWindowDto {
  readonly window: 'weekly' | '5h'
  readonly remainingPercent: number
  readonly resetAt?: number
}

export interface AntigravityQuotaEntryDto {
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly windows?: readonly AntigravityQuotaWindowDto[]
}

/**
 * One account as the sidebar shows it: the redacted, ordinal shape that
 * `redactAccountForSidebar` produces from a live account. Optional keys may
 * be absent or `undefined`.
 */
export interface AntigravityAccountDto {
  /**
   * Opaque value naming this account's current credential. It is random,
   * carries no account data, and changes when the credential is replaced or
   * its identity changes.
   */
  readonly selector: string
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly health: number
  readonly current: boolean
  readonly cooldownUntil?: number
  readonly quota: {
    readonly gemini?: AntigravityQuotaEntryDto
    readonly 'non-gemini'?: AntigravityQuotaEntryDto
  }
  readonly tier?: {
    readonly id: string
    readonly paidId?: string
    readonly capturedAt: number
  }
}

/** The requesting session's active route; never another session's. */
export interface AntigravityRouteDto {
  readonly accountId: string
  readonly modelFamily: 'claude' | 'gemini'
  readonly headerStyle: 'antigravity' | 'gemini-cli'
  readonly strategy: 'sticky' | 'round-robin' | 'hybrid' | null
  readonly updatedAt: number
}

export interface AntigravityStatusDto {
  /** When quota was last checked, or `null` if never. */
  readonly checkedAt: number | null
  /** End of the current quota backoff, or `null` without one. */
  readonly quotaBackoffUntil: number | null
  readonly routingAuthoritative: boolean
}

/**
 * The location's operator settings, read fresh for every `state` answer.
 * Per-account killswitch overrides are left out: their keys are derived from
 * refresh tokens.
 */
export interface AntigravitySettingsDto {
  readonly routing: {
    readonly cliFirst: boolean
    readonly quotaStyleFallback: boolean
  }
  readonly killswitch: {
    readonly enabled: boolean
    readonly minimumRemainingPercent: number
  }
  readonly logLevel: AntigravityLogLevel
  readonly dump: { readonly enabled: boolean }
}

/**
 * Whether `accounts` is the whole roster. When the roster is larger than
 * `ANTIGRAVITY_RPC_LIMITS.accounts`, the answer carries no accounts at all
 * rather than a silently shortened list.
 */
export type AntigravityAccountsStatus =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'over-limit'
      readonly count: number
      readonly limit: (typeof ANTIGRAVITY_RPC_LIMITS)['accounts']
    }

/**
 * One queued notification: the Antigravity menu payload the client opens,
 * or a message for a toast (the same payloads the OpenCode 1 RPC queues).
 */
export interface AntigravityNotificationDto {
  readonly cursor: number
  readonly payload: RpcNotificationPayload
}

export type AntigravityStateReset =
  | 'initial'
  | 'generation-changed'
  | 'cursor-ahead'

export const ANTIGRAVITY_STATE_RESETS = [
  'initial',
  'generation-changed',
  'cursor-ahead',
] as const satisfies readonly AntigravityStateReset[]

export interface AntigravityStateSnapshot {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  readonly kind: 'snapshot'
  readonly generation: string
  readonly scope: AntigravityRpcScope
  /** `null` when the client's generation and cursor were both current. */
  readonly reset: AntigravityStateReset | null
  /** Send this cursor next time; it acknowledges what this answer holds. */
  readonly cursor: number
  /** Notifications evicted in this scope before they were acknowledged. */
  readonly dropped: number
  /** True when notifications after `cursor` are still waiting. */
  readonly more: boolean
  readonly notifications: readonly AntigravityNotificationDto[]
  /**
   * Increases with every `state` answer of this activation, so an answer can
   * be matched with diagnostics recorded for the same read.
   */
  readonly readSeq: number
  readonly accountsStatus: AntigravityAccountsStatus
  /** Empty unless `accountsStatus.kind` is `complete`. */
  readonly accounts: readonly AntigravityAccountDto[]
  readonly route: AntigravityRouteDto | null
  readonly status: AntigravityStatusDto
  readonly settings: AntigravitySettingsDto
}

/** Answer from an activation that has been disposed. */
export interface AntigravityDisposedOutput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  readonly kind: 'disposed'
  readonly generation: string
}

export type AntigravityStateOutput =
  | AntigravityStateSnapshot
  | AntigravityDisposedOutput

export interface AntigravityAppliedOutput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  readonly kind: 'applied'
  readonly generation: string
  readonly scope: AntigravityRpcScope
  /** The menu's answer: the message, failure code and refreshed menu. */
  readonly result: CommandApplyResult
}

export interface AntigravityStaleGenerationOutput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  readonly kind: 'stale-generation'
  /** The activation's current generation; nothing was applied. */
  readonly generation: string
}

export type AntigravityApplyOutput =
  | AntigravityAppliedOutput
  | AntigravityStaleGenerationOutput
  | AntigravityDisposedOutput

/**
 * A type alias rather than an interface: the host requires an event schema's
 * output to be assignable to a plain string-keyed record, which TypeScript
 * grants to object type aliases but not to interfaces.
 */
export type AntigravityChangedEvent = {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  readonly generation: string
}

// Validation results

export interface AntigravityRpcIssue {
  readonly message: string
  readonly path: readonly (string | number)[]
}

export type AntigravityRpcParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly AntigravityRpcIssue[] }

/**
 * The Standard Schema V1 interface (https://standardschema.dev). The
 * specification asks implementers to copy these types rather than import
 * them, so this module needs no schema library.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1Result<Output>
      | Promise<StandardSchemaV1Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output }
  }
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string
        readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[]
      }[]
    }

/** A strict validator usable both directly and as a Standard Schema. */
export interface AntigravityRpcSchema<T> extends StandardSchemaV1<T, T> {
  readonly parse: (value: unknown) => AntigravityRpcParseResult<T>
}

// Validator internals

type Path = readonly (string | number)[]

class Issues {
  readonly list: AntigravityRpcIssue[] = []
  add(path: Path, message: string): void {
    this.list.push({ path: [...path], message })
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Check an object's own keys. `required` keys must be present (an explicit
 * `undefined` counts as missing); `optional` keys may be absent or
 * `undefined`; any other key is refused.
 */
function checkRecord(
  value: unknown,
  path: Path,
  issues: Issues,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return false
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.add([...path, key], 'unexpected key')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      issues.add([...path, key], 'missing required key')
    }
  }
  return true
}

function present(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined
}

function checkLiteral<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  path: Path,
  issues: Issues,
): value is T {
  if (!allowed.some((candidate) => Object.is(candidate, value))) {
    issues.add(path, `expected one of ${allowed.join(', ')}`)
    return false
  }
  return true
}

function checkBoolean(value: unknown, path: Path, issues: Issues): void {
  if (typeof value !== 'boolean') issues.add(path, 'expected a boolean')
}

/** A non-negative safe integer, without coercion and without `-0`. */
function isCursor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  )
}

function checkCursor(value: unknown, path: Path, issues: Issues): void {
  if (!isCursor(value)) {
    issues.add(path, 'expected a non-negative safe integer')
  }
}

function checkPositiveCursor(value: unknown, path: Path, issues: Issues): void {
  if (!isCursor(value) || value === 0) {
    issues.add(path, 'expected a positive safe integer')
  }
}

/** A finite number in `[min, max]`. */
function checkFinite(
  value: unknown,
  path: Path,
  issues: Issues,
  min: number,
  max: number = Number.MAX_VALUE,
): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    issues.add(path, `expected a finite number in [${min}, ${max}]`)
  }
}

/** An epoch-millisecond timestamp. */
function checkTimestamp(value: unknown, path: Path, issues: Issues): void {
  checkFinite(value, path, issues, 0)
}

function checkString(
  value: unknown,
  path: Path,
  issues: Issues,
  options: { min?: number; max: number; pattern?: RegExp; noNul?: boolean },
): value is string {
  if (typeof value !== 'string') {
    issues.add(path, 'expected a string')
    return false
  }
  const min = options.min ?? 0
  if (value.length < min || value.length > options.max) {
    issues.add(path, `expected a string of length ${min}–${options.max}`)
    return false
  }
  if (options.pattern && !options.pattern.test(value)) {
    issues.add(path, 'string has an invalid format')
    return false
  }
  if (options.noNul && value.includes('\u0000')) {
    issues.add(path, 'string must not contain NUL')
    return false
  }
  return true
}

const GENERATION_PATTERN = /^[A-Za-z0-9_-]+$/
const SESSION_ID_PATTERN = /^[\x21-\x7e]+$/
const ACCOUNT_ID_PATTERN = /^acct-(0|[1-9][0-9]{0,5})$/
const ACCOUNT_LABEL_PATTERN = /^Account [1-9][0-9]{0,5}$/
const TIER_ID_PATTERN = /^[\x20-\x7e]+$/
const SELECTOR_PATTERN = /^sel-[A-Za-z0-9_-]{32}$/

function checkSelector(value: unknown, path: Path, issues: Issues): void {
  checkString(value, path, issues, {
    min: 36,
    max: 36,
    pattern: SELECTOR_PATTERN,
  })
}

function checkGeneration(value: unknown, path: Path, issues: Issues): void {
  checkString(value, path, issues, {
    min: 1,
    max: ANTIGRAVITY_RPC_LIMITS.generationMaxLength,
    pattern: GENERATION_PATTERN,
  })
}

function checkScope(value: unknown, path: Path, issues: Issues): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  if (value.kind === 'sessionless') {
    checkRecord(value, path, issues, ['kind'])
    return
  }
  if (value.kind === 'session') {
    if (!checkRecord(value, path, issues, ['kind', 'sessionID'])) return
    if (present(value, 'sessionID')) {
      checkString(value.sessionID, [...path, 'sessionID'], issues, {
        min: 1,
        max: ANTIGRAVITY_RPC_LIMITS.sessionIDMaxLength,
        pattern: SESSION_ID_PATTERN,
      })
    }
    return
  }
  issues.add([...path, 'kind'], 'expected one of session, sessionless')
}

function checkVersion(
  record: Record<string, unknown>,
  path: Path,
  issues: Issues,
): void {
  if (present(record, 'version')) {
    checkLiteral(
      record.version,
      [ANTIGRAVITY_RPC_VERSION],
      [...path, 'version'],
      issues,
    )
  }
}

function checkText(value: unknown, path: Path, issues: Issues): void {
  checkString(value, path, issues, {
    max: ANTIGRAVITY_RPC_LIMITS.textMaxLength,
    noNul: true,
  })
}

function checkArray(
  value: unknown,
  path: Path,
  issues: Issues,
  max: number,
  element: (item: unknown, path: Path, issues: Issues) => void,
): void {
  if (!Array.isArray(value)) {
    issues.add(path, 'expected an array')
    return
  }
  if (value.length > max) {
    issues.add(path, `expected at most ${max} items`)
    return
  }
  value.forEach((item, index) => {
    element(item, [...path, index], issues)
  })
}

function checkQuotaWindow(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['window', 'remainingPercent'],
      ['resetAt'],
    )
  ) {
    return
  }
  if (present(value, 'window')) {
    checkLiteral(value.window, ['weekly', '5h'], [...path, 'window'], issues)
  }
  if (present(value, 'remainingPercent')) {
    checkFinite(
      value.remainingPercent,
      [...path, 'remainingPercent'],
      issues,
      0,
      100,
    )
  }
  if (present(value, 'resetAt')) {
    checkTimestamp(value.resetAt, [...path, 'resetAt'], issues)
  }
}

function checkQuotaEntry(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['remainingPercent'],
      ['resetAt', 'windows'],
    )
  ) {
    return
  }
  if (present(value, 'remainingPercent')) {
    checkFinite(
      value.remainingPercent,
      [...path, 'remainingPercent'],
      issues,
      0,
      100,
    )
  }
  if (present(value, 'resetAt')) {
    checkTimestamp(value.resetAt, [...path, 'resetAt'], issues)
  }
  if (present(value, 'windows')) {
    checkArray(
      value.windows,
      [...path, 'windows'],
      issues,
      ANTIGRAVITY_RPC_LIMITS.quotaWindows,
      checkQuotaWindow,
    )
  }
}

function checkAccount(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['selector', 'id', 'label', 'enabled', 'health', 'current', 'quota'],
      ['cooldownUntil', 'tier'],
    )
  ) {
    return
  }
  if (present(value, 'selector')) {
    checkSelector(value.selector, [...path, 'selector'], issues)
  }
  if (present(value, 'id')) {
    checkString(value.id, [...path, 'id'], issues, {
      min: 1,
      max: 16,
      pattern: ACCOUNT_ID_PATTERN,
    })
  }
  if (present(value, 'label')) {
    checkString(value.label, [...path, 'label'], issues, {
      min: 1,
      max: 16,
      pattern: ACCOUNT_LABEL_PATTERN,
    })
  }
  if (present(value, 'enabled')) {
    checkBoolean(value.enabled, [...path, 'enabled'], issues)
  }
  if (present(value, 'health')) {
    checkFinite(value.health, [...path, 'health'], issues, 0, 100)
  }
  if (present(value, 'current')) {
    checkBoolean(value.current, [...path, 'current'], issues)
  }
  if (present(value, 'cooldownUntil')) {
    checkTimestamp(value.cooldownUntil, [...path, 'cooldownUntil'], issues)
  }
  if (present(value, 'quota')) {
    const quotaPath = [...path, 'quota']
    const quota = value.quota
    if (checkRecord(quota, quotaPath, issues, [], ['gemini', 'non-gemini'])) {
      for (const key of ['gemini', 'non-gemini'] as const) {
        if (present(quota, key)) {
          checkQuotaEntry(quota[key], [...quotaPath, key], issues)
        }
      }
    }
  }
  if (present(value, 'tier')) {
    const tierPath = [...path, 'tier']
    const tier = value.tier
    if (checkRecord(tier, tierPath, issues, ['id', 'capturedAt'], ['paidId'])) {
      for (const key of ['id', 'paidId'] as const) {
        if (present(tier, key)) {
          checkString(tier[key], [...tierPath, key], issues, {
            min: 1,
            max: ANTIGRAVITY_RPC_LIMITS.tierIDMaxLength,
            pattern: TIER_ID_PATTERN,
          })
        }
      }
      if (present(tier, 'capturedAt')) {
        checkTimestamp(tier.capturedAt, [...tierPath, 'capturedAt'], issues)
      }
    }
  }
}

function checkAccounts(value: unknown, path: Path, issues: Issues): void {
  checkArray(value, path, issues, ANTIGRAVITY_RPC_LIMITS.accounts, checkAccount)
}

function checkRoute(value: unknown, path: Path, issues: Issues): void {
  if (value === null) return
  if (
    !checkRecord(value, path, issues, [
      'accountId',
      'modelFamily',
      'headerStyle',
      'strategy',
      'updatedAt',
    ])
  ) {
    return
  }
  checkString(value.accountId, [...path, 'accountId'], issues, {
    min: 1,
    max: 16,
    pattern: ACCOUNT_ID_PATTERN,
  })
  checkLiteral(
    value.modelFamily,
    ['claude', 'gemini'],
    [...path, 'modelFamily'],
    issues,
  )
  checkLiteral(
    value.headerStyle,
    ['antigravity', 'gemini-cli'],
    [...path, 'headerStyle'],
    issues,
  )
  if (value.strategy !== null) {
    checkLiteral(
      value.strategy,
      ['sticky', 'round-robin', 'hybrid'],
      [...path, 'strategy'],
      issues,
    )
  }
  checkTimestamp(value.updatedAt, [...path, 'updatedAt'], issues)
}

function checkStatus(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['routingAuthoritative'],
      ['checkedAt', 'quotaBackoffUntil'],
    )
  ) {
    return
  }
  // `checkedAt` and `quotaBackoffUntil` must be present but may be `null`,
  // so their presence is checked separately from their values.
  checkNullableKeysPresent(
    value,
    ['checkedAt', 'quotaBackoffUntil'],
    path,
    issues,
  )
  for (const key of ['checkedAt', 'quotaBackoffUntil'] as const) {
    if (value[key] !== null && present(value, key)) {
      checkTimestamp(value[key], [...path, key], issues)
    }
  }
  if (present(value, 'routingAuthoritative')) {
    checkBoolean(
      value.routingAuthoritative,
      [...path, 'routingAuthoritative'],
      issues,
    )
  }
}

function checkNotification(value: unknown, path: Path, issues: Issues): void {
  if (!checkRecord(value, path, issues, ['cursor', 'payload'])) return
  if (present(value, 'cursor')) {
    checkPositiveCursor(value.cursor, [...path, 'cursor'], issues)
  }
  if (present(value, 'payload')) {
    checkNotificationPayload(value.payload, [...path, 'payload'], issues)
  }
}

/**
 * Check required keys whose value may be `null`. checkRecord treats an
 * explicit `undefined` as missing, which is still right for these keys.
 */
function checkNullableKeysPresent(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: Path,
  issues: Issues,
): void {
  for (const key of keys) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) {
      issues.add([...path, key], 'missing required key')
    }
  }
}

function checkDisposed(
  value: Record<string, unknown>,
  path: Path,
  issues: Issues,
): void {
  if (!checkRecord(value, path, issues, ['version', 'kind', 'generation'])) {
    return
  }
  checkVersion(value, path, issues)
  if (present(value, 'generation')) {
    checkGeneration(value.generation, [...path, 'generation'], issues)
  }
}

// Antigravity menu: validators for the `@cortexkit/common-auth/commands`
// menu model, request and result, which this module mirrors by hand
// because it may not import that module at runtime.

const MENU_ID_PATTERN = /^[\x21-\x7e]+$/
const SECTION_SLOTS = [
  'accounts',
  'quota',
  'routing',
  'limits',
  'cache',
  'diagnostics',
  'extra',
] as const
const KNOB_KINDS = ['choice', 'toggle', 'number', 'text'] as const
const NOTIFY_KINDS = ['info', 'warning', 'error'] as const

function checkMenuId(value: unknown, path: Path, issues: Issues): void {
  checkString(value, path, issues, {
    min: 1,
    max: ANTIGRAVITY_RPC_LIMITS.menuIdMaxLength,
    pattern: MENU_ID_PATTERN,
  })
}

function checkMenuCommand(value: unknown, path: Path, issues: Issues): void {
  checkLiteral(value, [ANTIGRAVITY_MENU_COMMAND_NAME], path, issues)
}

function checkFiniteNumber(value: unknown, path: Path, issues: Issues): void {
  checkFinite(value, path, issues, -Number.MAX_VALUE)
}

/** A knob value: string, finite number, boolean or `null`. */
function checkKnobValue(value: unknown, path: Path, issues: Issues): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    checkFiniteNumber(value, path, issues)
    return
  }
  if (typeof value === 'string') {
    checkText(value, path, issues)
    return
  }
  issues.add(path, 'expected a string, finite number, boolean or null')
}

function checkKnobValues(value: unknown, path: Path, issues: Issues): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  const names = Object.keys(value)
  if (names.length > ANTIGRAVITY_RPC_LIMITS.menuValues) {
    issues.add(
      path,
      `expected at most ${ANTIGRAVITY_RPC_LIMITS.menuValues} values`,
    )
    return
  }
  for (const name of names) {
    checkMenuId(name, [...path, name], issues)
    checkKnobValue(value[name], [...path, name], issues)
  }
}

/** One action request; `sessionId` is never part of it on this wire. */
function checkMenuRequest(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['command', 'sectionId', 'actionId'],
      ['itemId', 'values', 'confirmed'],
    )
  ) {
    return
  }
  if (present(value, 'command')) {
    checkMenuCommand(value.command, [...path, 'command'], issues)
  }
  for (const key of ['sectionId', 'actionId', 'itemId']) {
    if (present(value, key)) checkMenuId(value[key], [...path, key], issues)
  }
  if (present(value, 'values')) {
    checkKnobValues(value.values, [...path, 'values'], issues)
  }
  if (present(value, 'confirmed')) {
    checkBoolean(value.confirmed, [...path, 'confirmed'], issues)
  }
}

/**
 * Plugin facts: JSON data the Antigravity menu lists by name. Only plain records,
 * arrays, strings, finite numbers, booleans and `null`, bounded in size and
 * depth.
 */
function checkFactValue(
  value: unknown,
  path: Path,
  issues: Issues,
  depth: number,
): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    checkFiniteNumber(value, path, issues)
    return
  }
  if (typeof value === 'string') {
    checkText(value, path, issues)
    return
  }
  if (depth >= ANTIGRAVITY_RPC_LIMITS.menuFactsDepth) {
    issues.add(path, 'value is nested too deeply')
    return
  }
  if (Array.isArray(value)) {
    checkArray(
      value,
      path,
      issues,
      ANTIGRAVITY_RPC_LIMITS.menuFacts,
      (item, p, i) => checkFactValue(item, p, i, depth + 1),
    )
    return
  }
  checkFacts(value, path, issues, depth + 1)
}

function checkFacts(
  value: unknown,
  path: Path,
  issues: Issues,
  depth = 0,
): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  const names = Object.keys(value)
  if (names.length > ANTIGRAVITY_RPC_LIMITS.menuFacts) {
    issues.add(
      path,
      `expected at most ${ANTIGRAVITY_RPC_LIMITS.menuFacts} entries`,
    )
    return
  }
  for (const name of names) {
    checkText(name, [...path, name], issues)
    checkFactValue(value[name], [...path, name], issues, depth)
  }
}

function checkChoice(value: unknown, path: Path, issues: Issues): void {
  if (!checkRecord(value, path, issues, ['value', 'label'])) return
  if (present(value, 'value'))
    checkMenuId(value.value, [...path, 'value'], issues)
  if (present(value, 'label'))
    checkText(value.label, [...path, 'label'], issues)
}

function checkKnob(value: unknown, path: Path, issues: Issues): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  const base = ['kind', 'id', 'label']
  switch (value.kind) {
    case 'choice':
      if (!checkRecord(value, path, issues, [...base, 'choices'], ['value'])) {
        return
      }
      if (present(value, 'choices')) {
        checkArray(
          value.choices,
          [...path, 'choices'],
          issues,
          ANTIGRAVITY_RPC_LIMITS.menuChoices,
          checkChoice,
        )
      }
      if (present(value, 'value'))
        checkMenuId(value.value, [...path, 'value'], issues)
      break
    case 'toggle':
      if (!checkRecord(value, path, issues, [...base, 'value'])) return
      if (present(value, 'value'))
        checkBoolean(value.value, [...path, 'value'], issues)
      break
    case 'number':
      if (
        !checkRecord(value, path, issues, base, [
          'value',
          'min',
          'max',
          'required',
        ])
      ) {
        return
      }
      for (const key of ['value', 'min', 'max']) {
        if (present(value, key))
          checkFiniteNumber(value[key], [...path, key], issues)
      }
      if (present(value, 'required')) {
        checkBoolean(value.required, [...path, 'required'], issues)
      }
      break
    case 'text':
      if (
        !checkRecord(value, path, issues, base, [
          'value',
          'placeholder',
          'masked',
          'required',
        ])
      ) {
        return
      }
      for (const key of ['value', 'placeholder']) {
        if (present(value, key)) checkText(value[key], [...path, key], issues)
      }
      for (const key of ['masked', 'required']) {
        if (present(value, key))
          checkBoolean(value[key], [...path, key], issues)
      }
      break
    default:
      issues.add([...path, 'kind'], `expected one of ${KNOB_KINDS.join(', ')}`)
      return
  }
  if (present(value, 'id')) checkMenuId(value.id, [...path, 'id'], issues)
  if (present(value, 'label'))
    checkText(value.label, [...path, 'label'], issues)
}

function checkMenuAction(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['id', 'label', 'knobs'],
      ['description', 'confirm'],
    )
  ) {
    return
  }
  if (present(value, 'id')) checkMenuId(value.id, [...path, 'id'], issues)
  if (present(value, 'label'))
    checkText(value.label, [...path, 'label'], issues)
  if (present(value, 'description')) {
    checkText(value.description, [...path, 'description'], issues)
  }
  if (present(value, 'knobs')) {
    checkArray(
      value.knobs,
      [...path, 'knobs'],
      issues,
      ANTIGRAVITY_RPC_LIMITS.menuKnobs,
      checkKnob,
    )
  }
  if (present(value, 'confirm')) {
    const confirmPath = [...path, 'confirm']
    if (
      checkRecord(value.confirm, confirmPath, issues, [
        'message',
        'irreversible',
      ])
    ) {
      if (present(value.confirm, 'message')) {
        checkText(value.confirm.message, [...confirmPath, 'message'], issues)
      }
      if (present(value.confirm, 'irreversible')) {
        checkBoolean(
          value.confirm.irreversible,
          [...confirmPath, 'irreversible'],
          issues,
        )
      }
    }
  }
}

function checkMenuActions(value: unknown, path: Path, issues: Issues): void {
  checkArray(
    value,
    path,
    issues,
    ANTIGRAVITY_RPC_LIMITS.menuActions,
    checkMenuAction,
  )
}

function checkMenuAccount(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['id', 'enabled', 'type'],
      ['label', 'identity'],
    )
  ) {
    return
  }
  if (present(value, 'id')) checkMenuId(value.id, [...path, 'id'], issues)
  if (present(value, 'enabled')) {
    checkBoolean(value.enabled, [...path, 'enabled'], issues)
  }
  if (present(value, 'type')) {
    checkLiteral(value.type, ['oauth', 'api'], [...path, 'type'], issues)
  }
  for (const key of ['label', 'identity']) {
    if (present(value, key)) checkText(value[key], [...path, key], issues)
  }
}

function checkMenuItem(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['id', 'label', 'actions'],
      ['detail', 'account', 'facts'],
    )
  ) {
    return
  }
  if (present(value, 'id')) checkMenuId(value.id, [...path, 'id'], issues)
  if (present(value, 'label'))
    checkText(value.label, [...path, 'label'], issues)
  if (present(value, 'detail')) {
    checkText(value.detail, [...path, 'detail'], issues)
  }
  if (present(value, 'account')) {
    checkMenuAccount(value.account, [...path, 'account'], issues)
  }
  if (present(value, 'facts'))
    checkFacts(value.facts, [...path, 'facts'], issues)
  if (present(value, 'actions')) {
    checkMenuActions(value.actions, [...path, 'actions'], issues)
  }
}

function checkMenuSection(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['id', 'slot', 'title', 'lines', 'items', 'actions'],
      ['facts'],
    )
  ) {
    return
  }
  if (present(value, 'id')) checkMenuId(value.id, [...path, 'id'], issues)
  if (present(value, 'slot')) {
    checkLiteral(value.slot, SECTION_SLOTS, [...path, 'slot'], issues)
  }
  if (present(value, 'title'))
    checkText(value.title, [...path, 'title'], issues)
  if (present(value, 'lines')) {
    checkArray(
      value.lines,
      [...path, 'lines'],
      issues,
      ANTIGRAVITY_RPC_LIMITS.menuLines,
      checkText,
    )
  }
  if (present(value, 'items')) {
    checkArray(
      value.items,
      [...path, 'items'],
      issues,
      ANTIGRAVITY_RPC_LIMITS.menuItemsPerSection,
      checkMenuItem,
    )
  }
  if (present(value, 'actions')) {
    checkMenuActions(value.actions, [...path, 'actions'], issues)
  }
  if (present(value, 'facts'))
    checkFacts(value.facts, [...path, 'facts'], issues)
}

function checkMenuModel(value: unknown, path: Path, issues: Issues): void {
  if (!checkRecord(value, path, issues, ['command', 'title', 'sections'])) {
    return
  }
  if (present(value, 'command')) {
    checkMenuCommand(value.command, [...path, 'command'], issues)
  }
  if (present(value, 'title'))
    checkText(value.title, [...path, 'title'], issues)
  if (present(value, 'sections')) {
    checkArray(
      value.sections,
      [...path, 'sections'],
      issues,
      ANTIGRAVITY_RPC_LIMITS.menuSections,
      checkMenuSection,
    )
  }
}

/** The Antigravity menu payload the client opens, or a toast message. */
function checkNotificationPayload(
  value: unknown,
  path: Path,
  issues: Issues,
): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  if (Object.hasOwn(value, 'notify')) {
    if (!checkRecord(value, path, issues, ['command', 'notify'])) return
    if (present(value, 'command')) {
      checkMenuCommand(value.command, [...path, 'command'], issues)
    }
    const notifyPath = [...path, 'notify']
    if (
      present(value, 'notify') &&
      checkRecord(value.notify, notifyPath, issues, ['message', 'kind'])
    ) {
      if (present(value.notify, 'message')) {
        checkText(value.notify.message, [...notifyPath, 'message'], issues)
      }
      if (present(value.notify, 'kind')) {
        checkLiteral(
          value.notify.kind,
          NOTIFY_KINDS,
          [...notifyPath, 'kind'],
          issues,
        )
      }
    }
    return
  }
  if (!checkRecord(value, path, issues, ['command', 'menu'])) return
  if (present(value, 'command')) {
    checkMenuCommand(value.command, [...path, 'command'], issues)
  }
  if (present(value, 'menu'))
    checkMenuModel(value.menu, [...path, 'menu'], issues)
}

/** `@cortexkit/common-auth/commands`' `CommandApplyResult` for the Antigravity menu. */
function checkApplyResult(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['command', 'ok', 'text', 'menu'],
      ['code', 'needsConfirmation'],
    )
  ) {
    return
  }
  if (present(value, 'command')) {
    checkMenuCommand(value.command, [...path, 'command'], issues)
  }
  if (present(value, 'ok')) checkBoolean(value.ok, [...path, 'ok'], issues)
  if (present(value, 'text')) checkText(value.text, [...path, 'text'], issues)
  if (present(value, 'code')) checkMenuId(value.code, [...path, 'code'], issues)
  if (present(value, 'needsConfirmation')) {
    checkBoolean(
      value.needsConfirmation,
      [...path, 'needsConfirmation'],
      issues,
    )
  }
  if (present(value, 'menu'))
    checkMenuModel(value.menu, [...path, 'menu'], issues)
}

// Top-level validators

function validateStateInput(value: unknown, issues: Issues): void {
  const path: Path = []
  if (
    !checkRecord(
      value,
      path,
      issues,
      ['version', 'scope', 'cursor'],
      ['generation'],
    )
  ) {
    return
  }
  // `generation` is required but may be `null` on first contact.
  checkNullableKeysPresent(value, ['generation'], path, issues)
  checkVersion(value, path, issues)
  if (value.generation !== null && present(value, 'generation')) {
    checkGeneration(value.generation, ['generation'], issues)
  }
  if (present(value, 'scope')) checkScope(value.scope, ['scope'], issues)
  if (present(value, 'cursor')) checkCursor(value.cursor, ['cursor'], issues)
}

function validateApplyInput(value: unknown, issues: Issues): void {
  const path: Path = []
  if (
    !checkRecord(value, path, issues, [
      'version',
      'generation',
      'scope',
      'request',
    ])
  ) {
    return
  }
  checkVersion(value, path, issues)
  if (present(value, 'generation')) {
    checkGeneration(value.generation, ['generation'], issues)
  }
  if (present(value, 'scope')) checkScope(value.scope, ['scope'], issues)
  if (present(value, 'request')) {
    checkMenuRequest(value.request, ['request'], issues)
  }
}

function validateStateOutput(value: unknown, issues: Issues): void {
  const path: Path = []
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  if (value.kind === 'disposed') {
    checkDisposed(value, path, issues)
    return
  }
  if (value.kind !== 'snapshot') {
    issues.add(['kind'], 'expected one of snapshot, disposed')
    return
  }
  if (
    !checkRecord(
      value,
      path,
      issues,
      [
        'version',
        'kind',
        'generation',
        'scope',
        'cursor',
        'dropped',
        'more',
        'notifications',
        'readSeq',
        'accountsStatus',
        'accounts',
        'status',
        'settings',
      ],
      ['reset', 'route'],
    )
  ) {
    return
  }
  checkNullableKeysPresent(value, ['reset', 'route'], path, issues)
  checkVersion(value, path, issues)
  if (present(value, 'generation')) {
    checkGeneration(value.generation, ['generation'], issues)
  }
  if (present(value, 'scope')) checkScope(value.scope, ['scope'], issues)
  if (value.reset !== null && present(value, 'reset')) {
    checkLiteral(value.reset, ANTIGRAVITY_STATE_RESETS, ['reset'], issues)
  }
  if (present(value, 'cursor')) checkCursor(value.cursor, ['cursor'], issues)
  if (present(value, 'dropped')) {
    checkCursor(value.dropped, ['dropped'], issues)
  }
  if (present(value, 'more')) checkBoolean(value.more, ['more'], issues)
  if (present(value, 'notifications')) {
    checkArray(
      value.notifications,
      ['notifications'],
      issues,
      ANTIGRAVITY_RPC_LIMITS.notificationsPerState,
      checkNotification,
    )
    // Delivered notifications must be in strictly increasing cursor order
    // and must not pass the answer's cursor.
    if (Array.isArray(value.notifications) && isCursor(value.cursor)) {
      let previous = 0
      value.notifications.forEach((notification, index) => {
        const cursor = isPlainRecord(notification)
          ? notification.cursor
          : undefined
        if (!isCursor(cursor)) return
        if (cursor <= previous || cursor > (value.cursor as number)) {
          issues.add(
            ['notifications', index, 'cursor'],
            'cursors must increase and not pass the answer cursor',
          )
        }
        previous = cursor
      })
    }
  }
  if (present(value, 'readSeq')) {
    checkPositiveCursor(value.readSeq, ['readSeq'], issues)
  }
  if (present(value, 'accountsStatus')) {
    checkAccountsStatus(value.accountsStatus, ['accountsStatus'], issues)
  }
  if (present(value, 'accounts')) {
    checkAccounts(value.accounts, ['accounts'], issues)
    // An over-limit answer carries no accounts, never a shortened list.
    if (
      isPlainRecord(value.accountsStatus) &&
      value.accountsStatus.kind === 'over-limit' &&
      Array.isArray(value.accounts) &&
      value.accounts.length > 0
    ) {
      issues.add(['accounts'], 'expected no accounts when over the limit')
    }
  }
  if (present(value, 'route')) checkRoute(value.route, ['route'], issues)
  if (present(value, 'status')) checkStatus(value.status, ['status'], issues)
  if (present(value, 'settings')) {
    checkSettings(value.settings, ['settings'], issues)
  }
}

function checkAccountsStatus(value: unknown, path: Path, issues: Issues): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  if (value.kind === 'complete') {
    checkRecord(value, path, issues, ['kind'])
    return
  }
  if (value.kind !== 'over-limit') {
    issues.add([...path, 'kind'], 'expected one of complete, over-limit')
    return
  }
  if (!checkRecord(value, path, issues, ['kind', 'count', 'limit'])) return
  if (present(value, 'limit')) {
    checkLiteral(
      value.limit,
      [ANTIGRAVITY_RPC_LIMITS.accounts],
      [...path, 'limit'],
      issues,
    )
  }
  if (
    present(value, 'count') &&
    (!isCursor(value.count) || value.count <= ANTIGRAVITY_RPC_LIMITS.accounts)
  ) {
    issues.add([...path, 'count'], 'expected a count above the limit')
  }
}

function checkSettings(value: unknown, path: Path, issues: Issues): void {
  if (
    !checkRecord(value, path, issues, [
      'routing',
      'killswitch',
      'logLevel',
      'dump',
    ])
  ) {
    return
  }
  const routingPath = [...path, 'routing']
  if (
    present(value, 'routing') &&
    checkRecord(value.routing, routingPath, issues, [
      'cliFirst',
      'quotaStyleFallback',
    ])
  ) {
    checkBoolean(value.routing.cliFirst, [...routingPath, 'cliFirst'], issues)
    checkBoolean(
      value.routing.quotaStyleFallback,
      [...routingPath, 'quotaStyleFallback'],
      issues,
    )
  }
  const killswitchPath = [...path, 'killswitch']
  if (
    present(value, 'killswitch') &&
    checkRecord(value.killswitch, killswitchPath, issues, [
      'enabled',
      'minimumRemainingPercent',
    ])
  ) {
    checkBoolean(
      value.killswitch.enabled,
      [...killswitchPath, 'enabled'],
      issues,
    )
    checkFinite(
      value.killswitch.minimumRemainingPercent,
      [...killswitchPath, 'minimumRemainingPercent'],
      issues,
      0,
      100,
    )
  }
  if (present(value, 'logLevel')) {
    checkLiteral(
      value.logLevel,
      ANTIGRAVITY_LOG_LEVELS,
      [...path, 'logLevel'],
      issues,
    )
  }
  const dumpPath = [...path, 'dump']
  if (
    present(value, 'dump') &&
    checkRecord(value.dump, dumpPath, issues, ['enabled'])
  ) {
    checkBoolean(value.dump.enabled, [...dumpPath, 'enabled'], issues)
  }
}

function validateApplyOutput(value: unknown, issues: Issues): void {
  const path: Path = []
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  switch (value.kind) {
    case 'disposed':
      checkDisposed(value, path, issues)
      return
    case 'stale-generation':
      if (checkRecord(value, path, issues, ['version', 'kind', 'generation'])) {
        checkVersion(value, path, issues)
        if (present(value, 'generation')) {
          checkGeneration(value.generation, ['generation'], issues)
        }
      }
      return
    case 'applied':
      if (
        checkRecord(value, path, issues, [
          'version',
          'kind',
          'generation',
          'scope',
          'result',
        ])
      ) {
        checkVersion(value, path, issues)
        if (present(value, 'generation')) {
          checkGeneration(value.generation, ['generation'], issues)
        }
        if (present(value, 'scope')) checkScope(value.scope, ['scope'], issues)
        if (present(value, 'result')) {
          checkApplyResult(value.result, ['result'], issues)
        }
      }
      return
    default:
      issues.add(
        ['kind'],
        'expected one of applied, stale-generation, disposed',
      )
  }
}

function validateChangedEvent(value: unknown, issues: Issues): void {
  if (!checkRecord(value, [], issues, ['version', 'generation'])) return
  checkVersion(value, [], issues)
  if (present(value, 'generation')) {
    checkGeneration(value.generation, ['generation'], issues)
  }
}

const VENDOR = 'cortexkit.antigravity-auth'

function makeSchema<T>(
  validate: (value: unknown, issues: Issues) => void,
): AntigravityRpcSchema<T> {
  const parse = (value: unknown): AntigravityRpcParseResult<T> => {
    const issues = new Issues()
    try {
      validate(value, issues)
    } catch {
      // A getter or proxy that throws is a malformed value, not a crash.
      issues.add([], 'value could not be read')
    }
    if (issues.list.length > 0) return { ok: false, issues: issues.list }
    // Validated values are returned as-is: no field is coerced or copied.
    return { ok: true, value: value as T }
  }
  return {
    parse,
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate: (value) => {
        const result = parse(value)
        return result.ok ? { value: result.value } : { issues: result.issues }
      },
    },
  }
}

export const AntigravityStateInputSchema =
  makeSchema<AntigravityStateInput>(validateStateInput)
export const AntigravityStateOutputSchema =
  makeSchema<AntigravityStateOutput>(validateStateOutput)
export const AntigravityApplyInputSchema =
  makeSchema<AntigravityApplyInput>(validateApplyInput)
export const AntigravityApplyOutputSchema =
  makeSchema<AntigravityApplyOutput>(validateApplyOutput)
export const AntigravityChangedEventSchema =
  makeSchema<AntigravityChangedEvent>(validateChangedEvent)
export const AntigravityAccountsSchema = makeSchema<
  readonly AntigravityAccountDto[]
>((value, issues) => checkAccounts(value, [], issues))
export const AntigravityApplyResultSchema = makeSchema<CommandApplyResult>(
  (value, issues) => checkApplyResult(value, [], issues),
)
export const AntigravityNotificationPayloadSchema =
  makeSchema<RpcNotificationPayload>((value, issues) =>
    checkNotificationPayload(value, [], issues),
  )

// Definition

/**
 * The definition the server registers and clients call. Its shape is the one
 * the OpenCode 2.0.22 RPC registry reads: `id`, `methods.<name>.{input,
 * output}` and `events.<name>.schema`. This module imports nothing from the
 * host SDK, so the check against the SDK's `Rpc.PortableDefinition` type
 * happens where the server passes this object to `rpc.register`.
 */
export const ANTIGRAVITY_RPC_DEFINITION = {
  id: ANTIGRAVITY_RPC_ID,
  methods: {
    state: {
      input: AntigravityStateInputSchema,
      output: AntigravityStateOutputSchema,
    },
    apply: {
      input: AntigravityApplyInputSchema,
      output: AntigravityApplyOutputSchema,
    },
  },
  events: {
    changed: { schema: AntigravityChangedEventSchema },
  },
} as const

// Client call helpers

/**
 * Arguments for the OpenCode 2 client's `rpc.call`. `location` is left out:
 * the client calling from a location adds it, and the server never routes
 * by a caller-supplied path.
 */
export interface AntigravityRpcCall<
  M extends AntigravityRpcMethod,
  I extends AntigravityStateInput | AntigravityApplyInput,
> {
  readonly rpcID: typeof ANTIGRAVITY_RPC_ID
  readonly method: M
  readonly input: I
}

export function stateCall(
  input: AntigravityStateInput,
): AntigravityRpcCall<'state', AntigravityStateInput> {
  return { rpcID: ANTIGRAVITY_RPC_ID, method: 'state', input }
}

export function applyCall(
  input: AntigravityApplyInput,
): AntigravityRpcCall<'apply', AntigravityApplyInput> {
  return { rpcID: ANTIGRAVITY_RPC_ID, method: 'apply', input }
}

/**
 * Read the `output` member of the host's `rpc.call` answer (`{ output? }`)
 * and validate it. A client must not trust the answer without this.
 */
function readCallOutput<T>(
  raw: unknown,
  schema: AntigravityRpcSchema<T>,
): AntigravityRpcParseResult<T> {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      issues: [{ path: [], message: 'expected the rpc.call answer object' }],
    }
  }
  const unexpected = Object.keys(raw).filter((key) => key !== 'output')
  if (unexpected.length > 0) {
    return {
      ok: false,
      issues: unexpected.map((key) => ({
        path: [key],
        message: 'unexpected key',
      })),
    }
  }
  const result = schema.parse(raw.output)
  if (result.ok) return result
  return {
    ok: false,
    issues: result.issues.map((issue) => ({
      path: ['output', ...issue.path],
      message: issue.message,
    })),
  }
}

export function readStateCallOutput(
  raw: unknown,
): AntigravityRpcParseResult<AntigravityStateOutput> {
  return readCallOutput(raw, AntigravityStateOutputSchema)
}

export function readApplyCallOutput(
  raw: unknown,
): AntigravityRpcParseResult<AntigravityApplyOutput> {
  return readCallOutput(raw, AntigravityApplyOutputSchema)
}

// Contract descriptor

/**
 * Every name, literal and limit of the serialized contract in one value.
 * A test checks its SHA-256, so any change to the wire contract also changes
 * that hash, and clients built against another version can detect it.
 */
export const ANTIGRAVITY_RPC_CONTRACT = {
  id: ANTIGRAVITY_RPC_ID,
  version: ANTIGRAVITY_RPC_VERSION,
  methods: ANTIGRAVITY_RPC_METHODS,
  events: ANTIGRAVITY_RPC_EVENTS,
  menuCommand: ANTIGRAVITY_MENU_COMMAND_NAME,
  logLevels: ANTIGRAVITY_LOG_LEVELS,
  scopeKinds: ['session', 'sessionless'],
  stateKinds: ['snapshot', 'disposed'],
  applyKinds: ['applied', 'stale-generation', 'disposed'],
  stateResets: ANTIGRAVITY_STATE_RESETS,
  menuSectionSlots: SECTION_SLOTS,
  menuKnobKinds: KNOB_KINDS,
  notifyKinds: NOTIFY_KINDS,
  menuIdPattern: '^[\\x21-\\x7e]+$',
  accountsStatusKinds: ['complete', 'over-limit'],
  selectorPattern: '^sel-[A-Za-z0-9_-]{32}$',
  limits: ANTIGRAVITY_RPC_LIMITS,
  keys: {
    stateInput: ['version', 'generation', 'scope', 'cursor'],
    applyInput: ['version', 'generation', 'scope', 'request'],
    menuRequest: [
      'command',
      'sectionId',
      'actionId',
      'itemId?',
      'values?',
      'confirmed?',
    ],
    stateSnapshot: [
      'version',
      'kind',
      'generation',
      'scope',
      'reset',
      'cursor',
      'dropped',
      'more',
      'notifications',
      'readSeq',
      'accountsStatus',
      'accounts',
      'route',
      'status',
      'settings',
    ],
    notification: ['cursor', 'payload'],
    notificationPayload: {
      menu: ['command', 'menu'],
      notify: ['command', 'notify'],
      notifyBody: ['message', 'kind'],
    },
    menu: ['command', 'title', 'sections'],
    menuSection: ['id', 'slot', 'title', 'lines', 'items', 'actions', 'facts?'],
    menuItem: ['id', 'label', 'actions', 'detail?', 'account?', 'facts?'],
    menuAccount: ['id', 'enabled', 'type', 'label?', 'identity?'],
    menuAction: ['id', 'label', 'knobs', 'description?', 'confirm?'],
    menuConfirm: ['message', 'irreversible'],
    menuKnob: {
      choice: ['kind', 'id', 'label', 'choices', 'value?'],
      toggle: ['kind', 'id', 'label', 'value'],
      number: ['kind', 'id', 'label', 'value?', 'min?', 'max?', 'required?'],
      text: [
        'kind',
        'id',
        'label',
        'value?',
        'placeholder?',
        'masked?',
        'required?',
      ],
    },
    menuChoice: ['value', 'label'],
    applyResult: [
      'command',
      'ok',
      'text',
      'menu',
      'code?',
      'needsConfirmation?',
    ],
    account: [
      'selector',
      'id',
      'label',
      'enabled',
      'health',
      'current',
      'cooldownUntil?',
      'quota',
      'tier?',
    ],
    accountsStatus: {
      complete: ['kind'],
      'over-limit': ['kind', 'count', 'limit'],
    },
    settings: {
      root: ['routing', 'killswitch', 'logLevel', 'dump'],
      routing: ['cliFirst', 'quotaStyleFallback'],
      killswitch: ['enabled', 'minimumRemainingPercent'],
      dump: ['enabled'],
    },
    route: ['accountId', 'modelFamily', 'headerStyle', 'strategy', 'updatedAt'],
    status: ['checkedAt', 'quotaBackoffUntil', 'routingAuthoritative'],
    changedEvent: ['version', 'generation'],
  },
} as const
