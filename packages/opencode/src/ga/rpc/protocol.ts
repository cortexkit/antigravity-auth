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
 * without pulling in server, account, OAuth or credential code. The one
 * type-only import keeps the command list identical to the OpenCode 1 RPC.
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
 * - Selectors: each account carries an opaque random `selector` naming its
 *   current credential. Typed account actions name accounts only by
 *   selector; positions and `acct-<n>` ids are never accepted as targets.
 * - Account limit: a roster larger than `ANTIGRAVITY_RPC_LIMITS.accounts` is
 *   answered with `accountsStatus: over-limit` and no accounts, never with a
 *   shortened list.
 * - Settings: every snapshot carries the location's current operator
 *   settings, so a client never needs an `apply` to read them.
 * - Validation never coerces: `true`, `"5"`, `5.5`, `-1`, `-0`, `NaN` and
 *   `Infinity` are not cursors, and no value is passed through `Number()`.
 *   Issue messages name the field, never the received value, so a rejected
 *   argument string (which can hold an OAuth code) is not echoed back.
 */

import type { CommandModalName } from '../../rpc/protocol.ts'

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

/** The dialog commands of the OpenCode 1 RPC, in that RPC's order. */
export const ANTIGRAVITY_RPC_COMMANDS = [
  'antigravity-quota',
  'antigravity-account',
  'antigravity-routing',
  'antigravity-killswitch',
  'antigravity-dump',
  'antigravity-logging',
] as const
export type AntigravityRpcCommand = (typeof ANTIGRAVITY_RPC_COMMANDS)[number]

// Compile-time guard: this command list and the OpenCode 1 union must be
// the same set. Adding a command to only one of them fails type checking.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false
const COMMANDS_MATCH_V1: MutuallyAssignable<
  AntigravityRpcCommand,
  CommandModalName
> = true
void COMMANDS_MATCH_V1

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
  /** `apply` arguments: at most 4096 UTF-16 code units, no NUL. */
  argumentsMaxLength: 4096,
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

/** A dialog command with its argument string. */
export interface AntigravityApplyTextInput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  /**
   * Must equal the generation of the activation serving this location;
   * anything else is answered `stale-generation` without an effect.
   */
  readonly generation: string
  readonly scope: AntigravityRpcScope
  readonly command: AntigravityRpcCommand
  /**
   * The dialog's argument string, in the format the OpenCode 1 `/rpc/apply`
   * endpoint accepts, so both hosts share one command parser.
   */
  readonly arguments: string
}

/**
 * One account action. `selector` is the opaque value the server sent with
 * that account in a `state` answer; it names exactly the credential that was
 * on the account then. Account positions and `acct-<n>` ids are never
 * accepted as targets.
 */
export type AntigravityAccountAction =
  | {
      readonly kind: 'select'
      readonly selector: string
      readonly target: 'active' | 'claude' | 'gemini'
    }
  | { readonly kind: 'enable'; readonly selector: string }
  | { readonly kind: 'disable'; readonly selector: string }
  | { readonly kind: 'remove'; readonly selector: string }

export const ANTIGRAVITY_ACCOUNT_ACTION_KINDS = [
  'select',
  'enable',
  'disable',
  'remove',
] as const satisfies readonly AntigravityAccountAction['kind'][]

/** A typed account action, instead of a dialog argument string. */
export interface AntigravityApplyAccountActionInput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  /** As in `AntigravityApplyTextInput`. */
  readonly generation: string
  readonly scope: AntigravityRpcScope
  readonly command: 'antigravity-account'
  readonly action: AntigravityAccountAction
}

export type AntigravityApplyInput =
  | AntigravityApplyTextInput
  | AntigravityApplyAccountActionInput

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
   * Opaque value naming this account's current credential for typed account
   * actions. It is random, carries no account data, and stops working when
   * the credential is replaced, its identity changes or the account is
   * removed.
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

export interface AntigravityNotificationDto {
  readonly cursor: number
  readonly type: 'open-dialog'
  readonly command: AntigravityRpcCommand
  readonly text: string
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

/**
 * `applied`: the command ran and changed state. `rejected`: the arguments
 * were not a valid action; nothing changed. `failed`: the action was valid
 * but could not be completed; nothing is known to have changed.
 */
export type AntigravityApplyStatus = 'applied' | 'rejected' | 'failed'

export const ANTIGRAVITY_APPLY_STATUSES = [
  'applied',
  'rejected',
  'failed',
] as const satisfies readonly AntigravityApplyStatus[]

interface CommandResultBase<C extends AntigravityRpcCommand> {
  readonly command: C
  readonly status: AntigravityApplyStatus
  /** Redacted, user-facing summary. */
  readonly text: string
}

export interface AntigravityQuotaResult
  extends CommandResultBase<'antigravity-quota'> {
  /** `null` when the roster is larger than the account limit. */
  readonly accounts: readonly AntigravityAccountDto[] | null
}

/**
 * What happened to the account a typed action named:
 * - `applied`: the action ran;
 * - `stale-target`: the selector named a credential that has since been
 *   replaced or removed, or whose identity changed; nothing was written;
 * - `unknown-target`: the selector was never issued by this activation (or
 *   is too old to be remembered); nothing was written;
 * - `unsupported-index-action`: a dialog argument named an account by
 *   position, which this host does not accept; nothing was written;
 * - `failed`: the action was attempted and did not complete.
 */
export type AntigravityTargetOutcome =
  | 'applied'
  | 'stale-target'
  | 'unknown-target'
  | 'unsupported-index-action'
  | 'failed'

export const ANTIGRAVITY_TARGET_OUTCOMES = [
  'applied',
  'stale-target',
  'unknown-target',
  'unsupported-index-action',
  'failed',
] as const satisfies readonly AntigravityTargetOutcome[]

export interface AntigravityAccountResult
  extends CommandResultBase<'antigravity-account'> {
  /** Accounts after the action, or `null` when the action did not run. */
  readonly accounts: readonly AntigravityAccountDto[] | null
  /** OAuth authorization URL to open for an account add, else `null`. */
  readonly authorizationUrl: string | null
  /** The named account's outcome; `null` for actions that name none. */
  readonly targetOutcome: AntigravityTargetOutcome | null
}

export interface AntigravityRoutingResult
  extends CommandResultBase<'antigravity-routing'> {
  readonly routing: {
    readonly cliFirst: boolean
    readonly quotaStyleFallback: boolean
  } | null
}

export interface AntigravityKillswitchResult
  extends CommandResultBase<'antigravity-killswitch'> {
  readonly killswitch: {
    readonly enabled: boolean
    readonly minimumRemainingPercent: number
  } | null
}

export interface AntigravityDumpResult
  extends CommandResultBase<'antigravity-dump'> {
  readonly dump: { readonly enabled: boolean } | null
}

export interface AntigravityLoggingResult
  extends CommandResultBase<'antigravity-logging'> {
  readonly logLevel: AntigravityLogLevel | null
}

export type AntigravityCommandResult =
  | AntigravityQuotaResult
  | AntigravityAccountResult
  | AntigravityRoutingResult
  | AntigravityKillswitchResult
  | AntigravityDumpResult
  | AntigravityLoggingResult

/** The result type for one command. */
export type AntigravityCommandResultFor<C extends AntigravityRpcCommand> =
  Extract<AntigravityCommandResult, { readonly command: C }>

export interface AntigravityAppliedOutput {
  readonly version: typeof ANTIGRAVITY_RPC_VERSION
  readonly kind: 'applied'
  readonly generation: string
  readonly scope: AntigravityRpcScope
  readonly result: AntigravityCommandResult
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

function checkCommand(value: unknown, path: Path, issues: Issues): void {
  checkLiteral(value, ANTIGRAVITY_RPC_COMMANDS, path, issues)
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
  if (
    !checkRecord(value, path, issues, ['cursor', 'type', 'command', 'text'])
  ) {
    return
  }
  if (present(value, 'cursor')) {
    checkPositiveCursor(value.cursor, [...path, 'cursor'], issues)
  }
  if (present(value, 'type')) {
    checkLiteral(value.type, ['open-dialog'], [...path, 'type'], issues)
  }
  if (present(value, 'command')) {
    checkCommand(value.command, [...path, 'command'], issues)
  }
  if (present(value, 'text')) checkText(value.text, [...path, 'text'], issues)
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

function checkCommandResult(value: unknown, path: Path, issues: Issues): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  const base = ['command', 'status', 'text']
  const command = value.command
  let extra: readonly string[]
  switch (command) {
    case 'antigravity-quota':
      extra = ['accounts']
      break
    case 'antigravity-account':
      extra = ['accounts', 'authorizationUrl', 'targetOutcome']
      break
    case 'antigravity-routing':
      extra = ['routing']
      break
    case 'antigravity-killswitch':
      extra = ['killswitch']
      break
    case 'antigravity-dump':
      extra = ['dump']
      break
    case 'antigravity-logging':
      extra = ['logLevel']
      break
    default:
      issues.add([...path, 'command'], 'unknown command')
      return
  }
  // The command-specific keys may be null, so only their presence is
  // required here; their values are checked below.
  if (!checkRecord(value, path, issues, base, extra)) return
  checkNullableKeysPresent(value, extra, path, issues)
  if (present(value, 'status')) {
    checkLiteral(
      value.status,
      ANTIGRAVITY_APPLY_STATUSES,
      [...path, 'status'],
      issues,
    )
  }
  if (present(value, 'text')) checkText(value.text, [...path, 'text'], issues)

  switch (command) {
    case 'antigravity-quota':
      if (value.accounts !== null && present(value, 'accounts')) {
        checkAccounts(value.accounts, [...path, 'accounts'], issues)
      }
      return
    case 'antigravity-account':
      if (value.accounts !== null && present(value, 'accounts')) {
        checkAccounts(value.accounts, [...path, 'accounts'], issues)
      }
      if (value.targetOutcome !== null && present(value, 'targetOutcome')) {
        checkLiteral(
          value.targetOutcome,
          ANTIGRAVITY_TARGET_OUTCOMES,
          [...path, 'targetOutcome'],
          issues,
        )
      }
      if (
        value.authorizationUrl !== null &&
        present(value, 'authorizationUrl')
      ) {
        if (
          checkString(
            value.authorizationUrl,
            [...path, 'authorizationUrl'],
            issues,
            {
              min: 9,
              max: ANTIGRAVITY_RPC_LIMITS.authorizationURLMaxLength,
              noNul: true,
            },
          ) &&
          !value.authorizationUrl.startsWith('https://')
        ) {
          issues.add([...path, 'authorizationUrl'], 'expected an https URL')
        }
      }
      return
    case 'antigravity-routing': {
      const routing = value.routing
      if (routing === null || routing === undefined) return
      const routingPath = [...path, 'routing']
      if (
        checkRecord(routing, routingPath, issues, [
          'cliFirst',
          'quotaStyleFallback',
        ])
      ) {
        checkBoolean(routing.cliFirst, [...routingPath, 'cliFirst'], issues)
        checkBoolean(
          routing.quotaStyleFallback,
          [...routingPath, 'quotaStyleFallback'],
          issues,
        )
      }
      return
    }
    case 'antigravity-killswitch': {
      const killswitch = value.killswitch
      if (killswitch === null || killswitch === undefined) return
      const killswitchPath = [...path, 'killswitch']
      if (
        checkRecord(killswitch, killswitchPath, issues, [
          'enabled',
          'minimumRemainingPercent',
        ])
      ) {
        checkBoolean(killswitch.enabled, [...killswitchPath, 'enabled'], issues)
        checkFinite(
          killswitch.minimumRemainingPercent,
          [...killswitchPath, 'minimumRemainingPercent'],
          issues,
          0,
          100,
        )
      }
      return
    }
    case 'antigravity-dump': {
      const dump = value.dump
      if (dump === null || dump === undefined) return
      const dumpPath = [...path, 'dump']
      if (checkRecord(dump, dumpPath, issues, ['enabled'])) {
        checkBoolean(dump.enabled, [...dumpPath, 'enabled'], issues)
      }
      return
    }
    case 'antigravity-logging':
      if (value.logLevel !== null && present(value, 'logLevel')) {
        checkLiteral(
          value.logLevel,
          ANTIGRAVITY_LOG_LEVELS,
          [...path, 'logLevel'],
          issues,
        )
      }
      return
  }
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

function checkAccountAction(value: unknown, path: Path, issues: Issues): void {
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  if (value.kind === 'select') {
    if (!checkRecord(value, path, issues, ['kind', 'selector', 'target'])) {
      return
    }
    if (present(value, 'target')) {
      checkLiteral(
        value.target,
        ['active', 'claude', 'gemini'],
        [...path, 'target'],
        issues,
      )
    }
  } else if (
    value.kind === 'enable' ||
    value.kind === 'disable' ||
    value.kind === 'remove'
  ) {
    if (!checkRecord(value, path, issues, ['kind', 'selector'])) return
  } else {
    issues.add(
      [...path, 'kind'],
      `expected one of ${ANTIGRAVITY_ACCOUNT_ACTION_KINDS.join(', ')}`,
    )
    return
  }
  if (present(value, 'selector')) {
    checkSelector(value.selector, [...path, 'selector'], issues)
  }
}

function validateApplyInput(value: unknown, issues: Issues): void {
  const path: Path = []
  if (!isPlainRecord(value)) {
    issues.add(path, 'expected a plain object')
    return
  }
  // A typed account action and a dialog argument string are separate forms;
  // an input carrying both, or neither, is refused.
  const isAction = Object.hasOwn(value, 'action')
  if (
    !checkRecord(value, path, issues, [
      'version',
      'generation',
      'scope',
      'command',
      isAction ? 'action' : 'arguments',
    ])
  ) {
    return
  }
  checkVersion(value, path, issues)
  if (present(value, 'generation')) {
    checkGeneration(value.generation, ['generation'], issues)
  }
  if (present(value, 'scope')) checkScope(value.scope, ['scope'], issues)
  if (isAction) {
    if (present(value, 'command')) {
      checkLiteral(value.command, ['antigravity-account'], ['command'], issues)
    }
    if (present(value, 'action')) {
      checkAccountAction(value.action, ['action'], issues)
    }
    return
  }
  if (present(value, 'command')) {
    checkCommand(value.command, ['command'], issues)
  }
  if (present(value, 'arguments')) {
    checkString(value.arguments, ['arguments'], issues, {
      max: ANTIGRAVITY_RPC_LIMITS.argumentsMaxLength,
      noNul: true,
    })
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
          checkCommandResult(value.result, ['result'], issues)
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
export const AntigravityCommandResultSchema =
  makeSchema<AntigravityCommandResult>((value, issues) =>
    checkCommandResult(value, [], issues),
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
  commands: ANTIGRAVITY_RPC_COMMANDS,
  logLevels: ANTIGRAVITY_LOG_LEVELS,
  scopeKinds: ['session', 'sessionless'],
  stateKinds: ['snapshot', 'disposed'],
  applyKinds: ['applied', 'stale-generation', 'disposed'],
  stateResets: ANTIGRAVITY_STATE_RESETS,
  applyStatuses: ANTIGRAVITY_APPLY_STATUSES,
  accountActionKinds: ANTIGRAVITY_ACCOUNT_ACTION_KINDS,
  accountActionTargets: ['active', 'claude', 'gemini'],
  targetOutcomes: ANTIGRAVITY_TARGET_OUTCOMES,
  accountsStatusKinds: ['complete', 'over-limit'],
  selectorPattern: '^sel-[A-Za-z0-9_-]{32}$',
  limits: ANTIGRAVITY_RPC_LIMITS,
  keys: {
    stateInput: ['version', 'generation', 'scope', 'cursor'],
    applyTextInput: ['version', 'generation', 'scope', 'command', 'arguments'],
    applyAccountActionInput: [
      'version',
      'generation',
      'scope',
      'command',
      'action',
    ],
    accountAction: {
      select: ['kind', 'selector', 'target'],
      enable: ['kind', 'selector'],
      disable: ['kind', 'selector'],
      remove: ['kind', 'selector'],
    },
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
    notification: ['cursor', 'type', 'command', 'text'],
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
    commandResult: {
      'antigravity-quota': ['accounts'],
      'antigravity-account': ['accounts', 'authorizationUrl', 'targetOutcome'],
      'antigravity-routing': ['routing'],
      'antigravity-killswitch': ['killswitch'],
      'antigravity-dump': ['dump'],
      'antigravity-logging': ['logLevel'],
    },
    changedEvent: ['version', 'generation'],
  },
} as const
