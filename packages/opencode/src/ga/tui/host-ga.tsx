/** @jsxImportSource @opentui/solid */

/**
 * OpenCode GA adapter for the shared `/antigravity` drawer and sidebar.
 *
 * Everything goes through the host's native location RPC: the server plugin
 * registers `antigravity-auth` (version 1) with the methods `state` and
 * `apply` at its location, and this adapter calls them with the host
 * client's `rpc.call`, naming the location explicitly. There is no port
 * file, no PID discovery, no private HTTP port and no sidebar file here.
 *
 * Contract rules this client keeps (the server enforces the same ones):
 *
 * - Generation: the first `state` sends `generation: null`; every later call
 *   sends the generation the server last answered with. When the server
 *   answers with a different one (`reset: 'generation-changed'`) the client
 *   rebinds: every scope's cursor restarts at 0. An `apply` answered with
 *   `stale-generation` or `disposed` changed nothing; the drawer says so and
 *   the next `state` rebinds.
 * - Scope: the current session (`{ kind: 'session', sessionID }`) or the
 *   sessionless scope on the home screen. Each scope has its own cursor. A
 *   drawer applies in the scope its menu arrived in, never the scope that
 *   happens to be current when the user chooses.
 * - Cursor: the client sends the highest cursor it has handled; the answer
 *   holds the next notifications and the cursor to send next.
 * - Disposal: after cleanup, or after the client rebinds, an answer to a
 *   request sent earlier is dropped unread, so a late completion can never
 *   open a dialog, show a toast or change the sidebar.
 *
 * Every answer is validated field by field before use; an answer that does
 * not match is refused and logged by field name only.
 *
 * The wire shapes mirror the facade's `ga/rpc/protocol.ts` (clean v1:
 * accounts carry opaque `selector`s, typed account actions name accounts
 * only by selector, every snapshot carries the location's settings). GA
 * notifications name a dialog command only, so this host builds the
 * `/antigravity` menu from the latest snapshot and the shared drawer renders
 * it; after every apply the menu is rebuilt from a fresh `state` read.
 *
 * Nothing here imports account storage, tokens, OAuth, the vault client or
 * server code, and nothing writes to the terminal or forces a theme.
 */

import { createSignal, For, type JSX, Show } from 'solid-js'
import {
  type ProjectedSidebar,
  type ProjectionAccount,
  type ProjectionRoute,
  type ProjectionStatus,
  projectAccount,
  projectSidebar,
} from '../../sidebar-projection'
import {
  MenuRefusedError,
  openAntigravityMenu,
} from '../../tui/command-dialogs'
import {
  ANTIGRAVITY_MENU_COMMAND,
  ANTIGRAVITY_MENU_TITLE,
  type MenuAction,
  type MenuApplyRequest,
  type MenuApplyResult,
  type MenuModel,
  type MenuParseResult,
  type MenuSection,
  type MenuUi,
} from '../../tui/host-api'

export const GA_TUI_ID = 'cortexkit.antigravity-auth' as const
export const GA_RPC_ID = 'antigravity-auth' as const
export const GA_RPC_VERSION = 1 as const

/** How often the TUI pulls state and notifications from its location. */
export const GA_SIDEBAR_PULL_MS = 1_000

/** Pulls in one tick while the server reports more notifications waiting. */
const MAX_PULLS_PER_TICK = 4

// ── Host surface (structural subset of the GA TUI context) ─────────────────

export interface GaLocationRef {
  readonly directory: string
  readonly workspaceID?: string
}

export interface GaRpcCallInput {
  readonly rpcID: string
  readonly method: string
  readonly location?: GaLocationRef
  readonly input: unknown
}

export interface GaSelectOption {
  readonly title: string
  readonly value: string
  readonly description?: string
}

export type GaRoute =
  | { readonly type: 'home' }
  | { readonly type: 'session'; readonly sessionID: string }
  | { readonly type: 'plugin'; readonly id: string; readonly name: string }

export interface GaSlotClaim {
  readonly append: 'sidebar.content'
  readonly render: (input: { readonly sessionID: string }) => JSX.Element
}

/** The parts of the GA TUI `Context` this adapter uses. */
export interface GaTuiContext {
  readonly location: GaLocationRef | undefined
  readonly client: {
    readonly rpc: {
      call(input: GaRpcCallInput): Promise<unknown>
    }
  }
  readonly renderer?: { copyToClipboardOSC52?(text: string): boolean }
  readonly ui: {
    readonly dialog: {
      set(options: { readonly size?: 'medium' | 'large' | 'xlarge' }): void
      clear(): void
      alert(options: {
        readonly title: string
        readonly message: string
      }): Promise<void>
      confirm(options: {
        readonly title: string
        readonly message: string
      }): Promise<boolean | undefined>
      prompt(options: {
        readonly title: string
        readonly description?: string
        readonly placeholder?: string
        readonly value?: string
      }): Promise<string | undefined>
      select<Value>(options: {
        readonly title: string
        readonly options: readonly {
          readonly title: string
          readonly value: Value
          readonly description?: string
        }[]
        readonly current?: Value
      }): Promise<Value | undefined>
    }
    readonly toast: {
      show(options: {
        readonly message: string
        readonly variant?: 'info' | 'success' | 'warning' | 'error'
      }): void
    }
    readonly router: { current(): GaRoute }
    readonly slot: (claim: GaSlotClaim) => () => void
  }
}

export interface GaLogger {
  warn(message: string, detail?: Record<string, unknown>): void
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

export type GaScope =
  | { readonly kind: 'session'; readonly sessionID: string }
  | { readonly kind: 'sessionless' }

/** The dialog commands the server names in notifications and text applies. */
export const GA_COMMANDS = [
  'antigravity-quota',
  'antigravity-account',
  'antigravity-routing',
  'antigravity-killswitch',
  'antigravity-dump',
  'antigravity-logging',
] as const
export type GaCommand = (typeof GA_COMMANDS)[number]

export const GA_LOG_LEVELS = [
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const
export type GaLogLevel = (typeof GA_LOG_LEVELS)[number]

export interface GaNotification {
  readonly cursor: number
  readonly type: 'open-dialog'
  readonly command: GaCommand
  readonly text: string
}

/** A redacted account plus the opaque selector that names its credential. */
export interface GaAccount extends ProjectionAccount {
  readonly selector: string
}

/** The location's operator settings, read fresh for every `state` answer. */
export interface GaSettings {
  readonly routing: {
    readonly cliFirst: boolean
    readonly quotaStyleFallback: boolean
  }
  readonly killswitch: {
    readonly enabled: boolean
    readonly minimumRemainingPercent: number
  }
  readonly logLevel: GaLogLevel
  readonly dump: { readonly enabled: boolean }
}

export type GaAccountsStatus =
  | { readonly kind: 'complete' }
  | { readonly kind: 'over-limit'; readonly count: number; readonly limit: 64 }

export interface GaSnapshot {
  readonly kind: 'snapshot'
  readonly generation: string
  readonly scope: GaScope
  readonly reset: 'initial' | 'generation-changed' | 'cursor-ahead' | null
  readonly cursor: number
  readonly dropped: number
  readonly more: boolean
  readonly notifications: readonly GaNotification[]
  readonly readSeq: number
  readonly accountsStatus: GaAccountsStatus
  readonly accounts: readonly GaAccount[]
  readonly route: ProjectionRoute | null
  readonly status: ProjectionStatus & { readonly routingAuthoritative: boolean }
  readonly settings: GaSettings
}

export type GaStateOutput =
  | GaSnapshot
  | { readonly kind: 'disposed'; readonly generation: string }

/** A typed account action; accounts are named only by selector. */
export type GaAccountAction =
  | {
      readonly kind: 'select'
      readonly selector: string
      readonly target: 'active' | 'claude' | 'gemini'
    }
  | { readonly kind: 'enable'; readonly selector: string }
  | { readonly kind: 'disable'; readonly selector: string }
  | { readonly kind: 'remove'; readonly selector: string }

/** What the client sends besides version, generation and scope. */
export type GaApplyBody =
  | { readonly command: GaCommand; readonly arguments: string }
  | {
      readonly command: 'antigravity-account'
      readonly action: GaAccountAction
    }

export type GaTargetOutcome =
  | 'applied'
  | 'stale-target'
  | 'unknown-target'
  | 'unsupported-index-action'
  | 'failed'

/** The command result fields this TUI reads; the rest are validated only. */
export interface GaCommandResult {
  readonly command: GaCommand
  readonly status: 'applied' | 'rejected' | 'failed'
  readonly text: string
  readonly authorizationUrl?: string | null
  readonly targetOutcome?: GaTargetOutcome | null
}

export type GaApplyOutput =
  | {
      readonly kind: 'applied'
      readonly generation: string
      readonly scope: GaScope
      readonly result: GaCommandResult
    }
  | { readonly kind: 'stale-generation'; readonly generation: string }
  | { readonly kind: 'disposed'; readonly generation: string }

const GENERATION = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_ID = /^[\x21-\x7e]{1,256}$/
const ACCOUNT_ID = /^acct-(0|[1-9][0-9]{0,5})$/
const ACCOUNT_LABEL = /^Account [1-9][0-9]{0,5}$/
const SELECTOR = /^sel-[A-Za-z0-9_-]{32}$/
const TARGET_OUTCOMES: readonly GaTargetOutcome[] = [
  'applied',
  'stale-target',
  'unknown-target',
  'unsupported-index-action',
  'failed',
]

type Issues = string[]

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function keys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: Issues,
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      issues.push(`${path}.${key}: unexpected field`)
    }
  }
  for (const key of required) {
    if (!(key in record)) issues.push(`${path}.${key}: missing`)
  }
}

function isCursor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  )
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function checkVersion(
  record: Record<string, unknown>,
  path: string,
  issues: Issues,
) {
  if (record.version !== GA_RPC_VERSION)
    issues.push(`${path}.version: unsupported`)
}

function checkGeneration(value: unknown, path: string, issues: Issues) {
  if (typeof value !== 'string' || !GENERATION.test(value)) {
    issues.push(`${path}: expected a generation token`)
  }
}

function checkScope(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected a scope`)
    return
  }
  if (value.kind === 'sessionless') {
    keys(value, ['kind'], [], path, issues)
    return
  }
  if (value.kind === 'session') {
    keys(value, ['kind', 'sessionID'], [], path, issues)
    if (
      typeof value.sessionID !== 'string' ||
      !SESSION_ID.test(value.sessionID)
    ) {
      issues.push(`${path}.sessionID: expected a session id`)
    }
    return
  }
  issues.push(`${path}.kind: unknown scope`)
}

function checkPercent(value: unknown, path: string, issues: Issues) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    issues.push(`${path}: expected a percentage`)
  }
}

function checkQuotaEntry(value: unknown, path: string, issues: Issues) {
  if (value === undefined) return
  if (!isRecord(value)) {
    issues.push(`${path}: expected a quota reading`)
    return
  }
  keys(value, ['remainingPercent'], ['resetAt', 'windows'], path, issues)
  checkPercent(value.remainingPercent, `${path}.remainingPercent`, issues)
  if (value.resetAt !== undefined && !isTime(value.resetAt)) {
    issues.push(`${path}.resetAt: expected a time`)
  }
  if (value.windows === undefined) return
  if (!Array.isArray(value.windows) || value.windows.length > 4) {
    issues.push(`${path}.windows: expected at most four windows`)
    return
  }
  value.windows.forEach((window, index) => {
    const at = `${path}.windows.${index}`
    if (!isRecord(window)) {
      issues.push(`${at}: expected a window`)
      return
    }
    keys(window, ['window', 'remainingPercent'], ['resetAt'], at, issues)
    if (window.window !== 'weekly' && window.window !== '5h') {
      issues.push(`${at}.window: unknown window`)
    }
    checkPercent(window.remainingPercent, `${at}.remainingPercent`, issues)
    if (window.resetAt !== undefined && !isTime(window.resetAt)) {
      issues.push(`${at}.resetAt: expected a time`)
    }
  })
}

/**
 * One redacted account. The field list is closed: an email, token, project
 * id or fingerprint arrives as an unexpected field and the whole answer is
 * refused.
 */
function checkAccount(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected an account`)
    return
  }
  keys(
    value,
    ['selector', 'id', 'label', 'enabled', 'health', 'current', 'quota'],
    ['cooldownUntil', 'tier'],
    path,
    issues,
  )
  if (typeof value.selector !== 'string' || !SELECTOR.test(value.selector)) {
    issues.push(`${path}.selector: expected an opaque selector`)
  }
  if (typeof value.id !== 'string' || !ACCOUNT_ID.test(value.id)) {
    issues.push(`${path}.id: expected an ordinal account id`)
  }
  if (typeof value.label !== 'string' || !ACCOUNT_LABEL.test(value.label)) {
    issues.push(`${path}.label: expected an ordinal account label`)
  }
  if (typeof value.enabled !== 'boolean')
    issues.push(`${path}.enabled: expected true/false`)
  if (typeof value.current !== 'boolean')
    issues.push(`${path}.current: expected true/false`)
  checkPercent(value.health, `${path}.health`, issues)
  if (value.cooldownUntil !== undefined && !isTime(value.cooldownUntil)) {
    issues.push(`${path}.cooldownUntil: expected a time`)
  }
  if (!isRecord(value.quota)) {
    issues.push(`${path}.quota: expected quota readings`)
  } else {
    keys(value.quota, [], ['gemini', 'non-gemini'], `${path}.quota`, issues)
    checkQuotaEntry(value.quota.gemini, `${path}.quota.gemini`, issues)
    checkQuotaEntry(
      value.quota['non-gemini'],
      `${path}.quota.non-gemini`,
      issues,
    )
  }
  if (value.tier !== undefined) {
    const tier = value.tier
    if (!isRecord(tier)) {
      issues.push(`${path}.tier: expected a plan tier`)
    } else {
      keys(tier, ['id', 'capturedAt'], ['paidId'], `${path}.tier`, issues)
      if (typeof tier.id !== 'string')
        issues.push(`${path}.tier.id: expected text`)
      if (tier.paidId !== undefined && typeof tier.paidId !== 'string') {
        issues.push(`${path}.tier.paidId: expected text`)
      }
      if (!isTime(tier.capturedAt))
        issues.push(`${path}.tier.capturedAt: expected a time`)
    }
  }
}

function checkRoute(value: unknown, path: string, issues: Issues) {
  if (value === null) return
  if (!isRecord(value)) {
    issues.push(`${path}: expected a route`)
    return
  }
  keys(
    value,
    ['accountId', 'modelFamily', 'headerStyle', 'strategy', 'updatedAt'],
    [],
    path,
    issues,
  )
  if (
    typeof value.accountId !== 'string' ||
    !ACCOUNT_ID.test(value.accountId)
  ) {
    issues.push(`${path}.accountId: expected an ordinal account id`)
  }
  if (value.modelFamily !== 'claude' && value.modelFamily !== 'gemini') {
    issues.push(`${path}.modelFamily: unknown family`)
  }
  if (
    value.headerStyle !== 'antigravity' &&
    value.headerStyle !== 'gemini-cli'
  ) {
    issues.push(`${path}.headerStyle: unknown header style`)
  }
  if (
    value.strategy !== null &&
    value.strategy !== 'sticky' &&
    value.strategy !== 'round-robin' &&
    value.strategy !== 'hybrid'
  ) {
    issues.push(`${path}.strategy: unknown strategy`)
  }
  if (!isTime(value.updatedAt))
    issues.push(`${path}.updatedAt: expected a time`)
}

function checkStatus(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected a status`)
    return
  }
  keys(
    value,
    ['checkedAt', 'quotaBackoffUntil', 'routingAuthoritative'],
    [],
    path,
    issues,
  )
  if (value.checkedAt !== null && !isTime(value.checkedAt)) {
    issues.push(`${path}.checkedAt: expected a time or null`)
  }
  if (value.quotaBackoffUntil !== null && !isTime(value.quotaBackoffUntil)) {
    issues.push(`${path}.quotaBackoffUntil: expected a time or null`)
  }
  if (typeof value.routingAuthoritative !== 'boolean') {
    issues.push(`${path}.routingAuthoritative: expected true/false`)
  }
}

function checkNotification(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected a notification`)
    return
  }
  keys(value, ['cursor', 'type', 'command', 'text'], [], path, issues)
  if (!isCursor(value.cursor) || value.cursor < 1) {
    issues.push(`${path}.cursor: expected a positive cursor`)
  }
  if (value.type !== 'open-dialog') {
    issues.push(`${path}.type: unknown notification type`)
  }
  if (!GA_COMMANDS.includes(value.command as GaCommand)) {
    issues.push(`${path}.command: unknown command`)
  }
  if (typeof value.text !== 'string') issues.push(`${path}.text: expected text`)
}

function checkBool(value: unknown, path: string, issues: Issues) {
  if (typeof value !== 'boolean') issues.push(`${path}: expected true/false`)
}

function checkSettings(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected settings`)
    return
  }
  keys(value, ['routing', 'killswitch', 'logLevel', 'dump'], [], path, issues)
  const { routing, killswitch, dump } = value
  if (!isRecord(routing)) issues.push(`${path}.routing: expected an object`)
  else {
    keys(
      routing,
      ['cliFirst', 'quotaStyleFallback'],
      [],
      `${path}.routing`,
      issues,
    )
    checkBool(routing.cliFirst, `${path}.routing.cliFirst`, issues)
    checkBool(
      routing.quotaStyleFallback,
      `${path}.routing.quotaStyleFallback`,
      issues,
    )
  }
  if (!isRecord(killswitch))
    issues.push(`${path}.killswitch: expected an object`)
  else {
    keys(
      killswitch,
      ['enabled', 'minimumRemainingPercent'],
      [],
      `${path}.killswitch`,
      issues,
    )
    checkBool(killswitch.enabled, `${path}.killswitch.enabled`, issues)
    checkPercent(
      killswitch.minimumRemainingPercent,
      `${path}.killswitch.minimumRemainingPercent`,
      issues,
    )
  }
  if (!GA_LOG_LEVELS.includes(value.logLevel as GaLogLevel)) {
    issues.push(`${path}.logLevel: unknown level`)
  }
  if (!isRecord(dump)) issues.push(`${path}.dump: expected an object`)
  else {
    keys(dump, ['enabled'], [], `${path}.dump`, issues)
    checkBool(dump.enabled, `${path}.dump.enabled`, issues)
  }
}

function checkAccountsStatus(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected an accounts status`)
    return
  }
  if (value.kind === 'complete') {
    keys(value, ['kind'], [], path, issues)
    return
  }
  if (value.kind === 'over-limit') {
    keys(value, ['kind', 'count', 'limit'], [], path, issues)
    if (!isCursor(value.count)) issues.push(`${path}.count: expected a count`)
    if (value.limit !== 64) issues.push(`${path}.limit: unexpected limit`)
    return
  }
  issues.push(`${path}.kind: unknown accounts status`)
}

function checkAccountList(value: unknown, path: string, issues: Issues) {
  if (value === null) return
  if (!Array.isArray(value) || value.length > 64) {
    issues.push(`${path}: expected at most 64 accounts`)
    return
  }
  value.forEach((entry, index) => {
    checkAccount(entry, `${path}.${index}`, issues)
  })
}

/** One command result, with the closed field list of its command. */
function checkCommandResult(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected a command result`)
    return
  }
  const base = ['command', 'status', 'text']
  if (
    value.status !== 'applied' &&
    value.status !== 'rejected' &&
    value.status !== 'failed'
  ) {
    issues.push(`${path}.status: unknown status`)
  }
  if (typeof value.text !== 'string') issues.push(`${path}.text: expected text`)
  switch (value.command) {
    case 'antigravity-quota':
      keys(value, [...base, 'accounts'], [], path, issues)
      checkAccountList(value.accounts, `${path}.accounts`, issues)
      return
    case 'antigravity-account':
      keys(
        value,
        [...base, 'accounts', 'authorizationUrl', 'targetOutcome'],
        [],
        path,
        issues,
      )
      checkAccountList(value.accounts, `${path}.accounts`, issues)
      if (
        value.authorizationUrl !== null &&
        !(
          typeof value.authorizationUrl === 'string' &&
          /^https:\/\//.test(value.authorizationUrl) &&
          value.authorizationUrl.length <= 4096
        )
      ) {
        issues.push(`${path}.authorizationUrl: expected an https link or null`)
      }
      if (
        value.targetOutcome !== null &&
        !TARGET_OUTCOMES.includes(value.targetOutcome as GaTargetOutcome)
      ) {
        issues.push(`${path}.targetOutcome: unknown outcome`)
      }
      return
    case 'antigravity-routing':
      keys(value, [...base, 'routing'], [], path, issues)
      return
    case 'antigravity-killswitch':
      keys(value, [...base, 'killswitch'], [], path, issues)
      return
    case 'antigravity-dump':
      keys(value, [...base, 'dump'], [], path, issues)
      return
    case 'antigravity-logging':
      keys(value, [...base, 'logLevel'], [], path, issues)
      return
    default:
      issues.push(`${path}.command: unknown command`)
  }
}

/** Unwraps the host's `{ output }` answer. */
function unwrap(raw: unknown, issues: Issues): unknown {
  if (!isRecord(raw)) {
    issues.push('answer: expected an object')
    return undefined
  }
  keys(raw, ['output'], [], 'answer', issues)
  return raw.output
}

function finish<T>(value: unknown, issues: Issues): MenuParseResult<T> {
  return issues.length === 0
    ? { ok: true, value: value as T }
    : { ok: false, issues }
}

/** Validates a `state` answer (the host's `{ output }` wrapper included). */
export function parseGaStateAnswer(
  raw: unknown,
): MenuParseResult<GaStateOutput> {
  const issues: Issues = []
  const output = unwrap(raw, issues)
  if (issues.length > 0) return { ok: false, issues }
  if (!isRecord(output))
    return { ok: false, issues: ['output: expected an object'] }
  checkVersion(output, 'output', issues)
  if (output.kind === 'disposed') {
    keys(output, ['version', 'kind', 'generation'], [], 'output', issues)
    checkGeneration(output.generation, 'output.generation', issues)
    return finish(output, issues)
  }
  if (output.kind !== 'snapshot') {
    return { ok: false, issues: ['output.kind: unknown answer'] }
  }
  keys(
    output,
    [
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
    [],
    'output',
    issues,
  )
  if (!isCursor(output.readSeq)) issues.push('output.readSeq: expected a count')
  checkAccountsStatus(output.accountsStatus, 'output.accountsStatus', issues)
  checkSettings(output.settings, 'output.settings', issues)
  checkGeneration(output.generation, 'output.generation', issues)
  checkScope(output.scope, 'output.scope', issues)
  if (
    output.reset !== null &&
    output.reset !== 'initial' &&
    output.reset !== 'generation-changed' &&
    output.reset !== 'cursor-ahead'
  ) {
    issues.push('output.reset: unknown reset')
  }
  if (!isCursor(output.cursor)) issues.push('output.cursor: expected a cursor')
  if (!isCursor(output.dropped)) issues.push('output.dropped: expected a count')
  if (typeof output.more !== 'boolean')
    issues.push('output.more: expected true/false')
  if (
    !Array.isArray(output.notifications) ||
    output.notifications.length > 32
  ) {
    issues.push('output.notifications: expected at most 32 notifications')
  } else {
    output.notifications.forEach((entry, index) => {
      checkNotification(entry, `output.notifications.${index}`, issues)
    })
  }
  if (!Array.isArray(output.accounts) || output.accounts.length > 64) {
    issues.push('output.accounts: expected at most 64 accounts')
  } else {
    output.accounts.forEach((entry, index) => {
      checkAccount(entry, `output.accounts.${index}`, issues)
    })
  }
  checkRoute(output.route, 'output.route', issues)
  checkStatus(output.status, 'output.status', issues)
  return finish(output, issues)
}

/** Validates an `apply` answer (the host's `{ output }` wrapper included). */
export function parseGaApplyAnswer(
  raw: unknown,
): MenuParseResult<GaApplyOutput> {
  const issues: Issues = []
  const output = unwrap(raw, issues)
  if (issues.length > 0) return { ok: false, issues }
  if (!isRecord(output))
    return { ok: false, issues: ['output: expected an object'] }
  checkVersion(output, 'output', issues)
  if (output.kind === 'stale-generation' || output.kind === 'disposed') {
    keys(output, ['version', 'kind', 'generation'], [], 'output', issues)
    checkGeneration(output.generation, 'output.generation', issues)
    return finish(output, issues)
  }
  if (output.kind !== 'applied') {
    return { ok: false, issues: ['output.kind: unknown answer'] }
  }
  keys(
    output,
    ['version', 'kind', 'generation', 'scope', 'result'],
    [],
    'output',
    issues,
  )
  checkGeneration(output.generation, 'output.generation', issues)
  checkScope(output.scope, 'output.scope', issues)
  checkCommandResult(output.result, 'output.result', issues)
  return finish(output, issues)
}

// ── Location client ─────────────────────────────────────────────────────────

/** The server restarted or was disposed; the action did nothing. */
export class GaStaleError extends Error {
  constructor(readonly reason: 'stale-generation' | 'disposed' | 'not-bound') {
    super(
      reason === 'not-bound'
        ? 'Antigravity auth is not connected at this location yet.'
        : 'Antigravity auth restarted; nothing was changed. Reopen /antigravity.',
    )
    this.name = 'GaStaleError'
  }
}

/** This client was disposed; its answers are no longer read. */
export class GaClientDisposedError extends Error {
  constructor() {
    super('Antigravity TUI client disposed')
    this.name = 'GaClientDisposedError'
  }
}

export function scopeKey(scope: GaScope): string {
  return scope.kind === 'session' ? `session:${scope.sessionID}` : 'sessionless'
}

export type GaPullResult =
  | { readonly kind: 'snapshot'; readonly snapshot: GaSnapshot }
  | { readonly kind: 'server-disposed' }
  /** The answer arrived after a rebind or disposal and was dropped unread. */
  | { readonly kind: 'dropped' }

export interface GaLocationClient {
  /** The generation the client is bound to, or null before the first answer. */
  generation(): string | null
  /** The next cursor this client sends for `scope`. */
  cursor(scope: GaScope): number
  pull(scope: GaScope): Promise<GaPullResult>
  apply(scope: GaScope, body: GaApplyBody): Promise<GaCommandResult>
  dispose(): void
  disposed(): boolean
}

export function createGaLocationClient(options: {
  readonly call: (input: GaRpcCallInput) => Promise<unknown>
  readonly location: GaLocationRef | undefined
  readonly logger?: GaLogger
}): GaLocationClient {
  let generation: string | null = null
  const cursors = new Map<string, number>()
  let isDisposed = false
  // Bumped on every rebind and on disposal. A request remembers the epoch
  // it was sent in; an answer from an older epoch is dropped unread.
  let epoch = 0

  const call = (method: 'state' | 'apply', input: unknown) =>
    options.call({
      rpcID: GA_RPC_ID,
      method,
      ...(options.location ? { location: options.location } : {}),
      input,
    })

  const rebind = (next: string | null) => {
    if (next === generation) return
    generation = next
    cursors.clear()
    epoch += 1
  }

  // State pulls run one at a time, so two pulls can never send the same
  // cursor and hand the same notification over twice.
  let pullChain: Promise<unknown> = Promise.resolve()

  const pullNow = async (scope: GaScope): Promise<GaPullResult> => {
    if (isDisposed) throw new GaClientDisposedError()
    const sentEpoch = epoch
    const key = scopeKey(scope)
    const raw = await call('state', {
      version: GA_RPC_VERSION,
      generation,
      scope,
      cursor: cursors.get(key) ?? 0,
    })
    if (isDisposed || sentEpoch !== epoch) return { kind: 'dropped' }
    const parsed = parseGaStateAnswer(raw)
    if (!parsed.ok) {
      options.logger?.warn('ga-state-refused', { issues: parsed.issues })
      throw new MenuRefusedError(parsed.issues)
    }
    const output = parsed.value
    if (output.kind === 'disposed') {
      // The activation we were bound to is gone; the next pull binds to
      // whichever one the location runs now.
      rebind(null)
      return { kind: 'server-disposed' }
    }
    if (scopeKey(output.scope) !== key) {
      options.logger?.warn('ga-state-scope-mismatch', {})
      throw new MenuRefusedError(['output.scope: not the requested scope'])
    }
    if (output.generation !== generation) {
      rebind(output.generation)
    }
    cursors.set(key, output.cursor)
    return { kind: 'snapshot', snapshot: output }
  }

  return {
    generation: () => generation,
    cursor: (scope) => cursors.get(scopeKey(scope)) ?? 0,
    disposed: () => isDisposed,
    dispose() {
      isDisposed = true
      epoch += 1
    },
    pull(scope) {
      const run = pullChain.then(() => pullNow(scope))
      pullChain = run.catch(() => undefined)
      return run
    },
    async apply(scope, body) {
      if (isDisposed) throw new GaClientDisposedError()
      const bound = generation
      if (bound === null) throw new GaStaleError('not-bound')
      const sentEpoch = epoch
      const raw = await call('apply', {
        version: GA_RPC_VERSION,
        generation: bound,
        scope,
        ...body,
      })
      if (isDisposed) throw new GaClientDisposedError()
      const parsed = parseGaApplyAnswer(raw)
      if (!parsed.ok) {
        options.logger?.warn('ga-apply-refused', { issues: parsed.issues })
        throw new MenuRefusedError(parsed.issues)
      }
      const output = parsed.value
      if (output.kind === 'stale-generation' || output.kind === 'disposed') {
        if (sentEpoch === epoch) rebind(null)
        throw new GaStaleError(output.kind)
      }
      if (
        output.generation !== bound ||
        scopeKey(output.scope) !== scopeKey(scope)
      ) {
        throw new MenuRefusedError([
          'output: answered for another activation or scope',
        ])
      }
      return output.result
    },
  }
}

// ── Menu over the native state ──────────────────────────────────────────────

/**
 * GA notifications name only a dialog command, so this host builds the
 * `/antigravity` menu itself from the latest `state` answer: the accounts
 * with their opaque selectors and the location's settings, both read fresh
 * for that answer. The shared drawer renders it like the OpenCode 1 menu.
 * Each item and action id encodes what the action sends; an account is named
 * only by its selector, never by position or `acct-<n>` id.
 */
const SECTION_FOR_COMMAND: Readonly<Record<GaCommand, string>> = {
  'antigravity-account': 'accounts',
  'antigravity-quota': 'quota',
  'antigravity-routing': 'routing',
  'antigravity-killswitch': 'limits',
  'antigravity-dump': 'diagnostics',
  'antigravity-logging': 'diagnostics',
}

export function sectionForCommand(command: GaCommand): string {
  return SECTION_FOR_COMMAND[command]
}

const ACCOUNT_ITEM_PREFIX = 'account:'

function onOff(value: boolean): string {
  return value ? 'on' : 'off'
}

function quotaLine(account: GaAccount, now: number): string {
  const projected = projectSidebar({
    accounts: [account],
    route: null,
    status: { checkedAt: 0, quotaBackoffUntil: null },
    now,
  }).accounts[0]
  const pools = (projected?.quota ?? [])
    .map(
      (row) =>
        `${row.label} ${row.remaining === null ? '—' : `${Math.round(row.remaining)}%`}${row.reset ? ` (${row.reset})` : ''}`,
    )
    .join(' · ')
  return `${account.label}: ${pools}`
}

export function buildGaMenu(snapshot: GaSnapshot, now: number): MenuModel {
  const { settings } = snapshot
  const overLimit = snapshot.accountsStatus.kind === 'over-limit'
  const accountLines = overLimit
    ? [
        `${snapshot.accountsStatus.kind === 'over-limit' ? snapshot.accountsStatus.count : 0} accounts; more than this view can list. Manage them from the command line.`,
      ]
    : [
        snapshot.accounts.length === 0
          ? 'No accounts yet.'
          : `${snapshot.accounts.length} account${snapshot.accounts.length === 1 ? '' : 's'}`,
      ]
  const sections: MenuSection[] = [
    {
      id: 'accounts',
      slot: 'accounts',
      title: 'Accounts',
      lines: accountLines,
      items: snapshot.accounts.map((account) => {
        const projected = projectAccount(account, now)
        const use = (
          id: string,
          label: string,
          description: string,
        ): MenuAction => ({ id, label, description, knobs: [] })
        return {
          id: `${ACCOUNT_ITEM_PREFIX}${account.selector}`,
          label: account.label,
          detail: `${projected.status} · ${projected.health}`,
          actions: [
            account.enabled
              ? use(
                  'disable',
                  'Disable',
                  'Stop routing requests to this account.',
                )
              : use(
                  'enable',
                  'Enable',
                  'Route requests to this account again.',
                ),
            use(
              'select-active',
              'Use for all models',
              'Make this the current account.',
            ),
            use(
              'select-claude',
              'Use for Claude',
              'Make this the current Claude account.',
            ),
            use(
              'select-gemini',
              'Use for Gemini',
              'Make this the current Gemini account.',
            ),
            {
              id: 'remove',
              label: 'Remove',
              description: 'Delete this account from this machine.',
              knobs: [],
              confirm: {
                message: `Remove ${account.label}? This cannot be undone.`,
                irreversible: true,
              },
            },
          ],
        }
      }),
      actions: [
        {
          id: 'add',
          label: 'Add account',
          description: 'Sign in with Google in your browser.',
          knobs: [],
        },
      ],
    },
    {
      id: 'quota',
      slot: 'quota',
      title: 'Quota',
      lines: overLimit
        ? ['Quota is not listed while the account list is over the limit.']
        : snapshot.accounts.length === 0
          ? ['No accounts yet.']
          : snapshot.accounts.map((account) => quotaLine(account, now)),
      items: [],
      actions: [
        {
          id: 'refresh',
          label: 'Check quota now',
          description: 'Ask Google for every account’s current quota.',
          knobs: [],
        },
      ],
    },
    {
      id: 'routing',
      slot: 'routing',
      title: 'Routing',
      lines: [
        `Gemini CLI first: ${onOff(settings.routing.cliFirst)}`,
        `Quota-style fallback: ${onOff(settings.routing.quotaStyleFallback)}`,
      ],
      items: [],
      actions: [
        {
          id: settings.routing.cliFirst ? 'cli-first-off' : 'cli-first-on',
          label: `Turn Gemini CLI first ${settings.routing.cliFirst ? 'off' : 'on'}`,
          knobs: [],
        },
        {
          id: settings.routing.quotaStyleFallback
            ? 'quota-fallback-off'
            : 'quota-fallback-on',
          label: `Turn quota-style fallback ${settings.routing.quotaStyleFallback ? 'off' : 'on'}`,
          knobs: [],
        },
      ],
    },
    {
      id: 'limits',
      slot: 'limits',
      title: 'Limits',
      lines: [
        `Killswitch: ${onOff(settings.killswitch.enabled)}`,
        `Minimum remaining quota: ${settings.killswitch.minimumRemainingPercent}%`,
      ],
      items: [],
      actions: [
        {
          id: settings.killswitch.enabled ? 'killswitch-off' : 'killswitch-on',
          label: `Turn killswitch ${settings.killswitch.enabled ? 'off' : 'on'}`,
          description: 'Skip accounts whose quota is below the minimum.',
          knobs: [],
        },
        {
          id: 'killswitch-minimum',
          label: 'Set minimum remaining quota',
          knobs: [
            {
              kind: 'number',
              id: 'percent',
              label: 'Percent (0-100)',
              value: settings.killswitch.minimumRemainingPercent,
              min: 0,
              max: 100,
              required: true,
            },
          ],
        },
      ],
    },
    {
      id: 'diagnostics',
      slot: 'diagnostics',
      title: 'Diagnostics',
      lines: [
        `Logging: ${settings.logLevel}`,
        `Wire dump: ${onOff(settings.dump.enabled)}`,
      ],
      items: [],
      actions: [
        {
          id: 'log-level',
          label: 'Set log level',
          knobs: [
            {
              kind: 'choice',
              id: 'level',
              label: 'Level',
              value: settings.logLevel,
              choices: GA_LOG_LEVELS.map((level) => ({
                value: level,
                label: level,
              })),
            },
          ],
        },
        {
          id: settings.dump.enabled ? 'dump-off' : 'dump-on',
          label: `Turn wire dump ${settings.dump.enabled ? 'off' : 'on'}`,
          description: 'Write request and response bodies to the dump folder.',
          knobs: [],
        },
      ],
    },
  ]
  return {
    command: ANTIGRAVITY_MENU_COMMAND,
    title: ANTIGRAVITY_MENU_TITLE,
    sections,
  }
}

/** Why a drawer choice could not be turned into a native apply. */
export class GaMenuChoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GaMenuChoiceError'
  }
}

const TEXT_ACTIONS: Readonly<Record<string, GaApplyBody>> = {
  'accounts/add': {
    command: 'antigravity-account',
    arguments: 'add-oauth-start',
  },
  'quota/refresh': { command: 'antigravity-quota', arguments: 'refresh' },
  'routing/cli-first-on': {
    command: 'antigravity-routing',
    arguments: 'cli_first=true',
  },
  'routing/cli-first-off': {
    command: 'antigravity-routing',
    arguments: 'cli_first=false',
  },
  'routing/quota-fallback-on': {
    command: 'antigravity-routing',
    arguments: 'quota_style_fallback=true',
  },
  'routing/quota-fallback-off': {
    command: 'antigravity-routing',
    arguments: 'quota_style_fallback=false',
  },
  'limits/killswitch-on': {
    command: 'antigravity-killswitch',
    arguments: 'enabled=true',
  },
  'limits/killswitch-off': {
    command: 'antigravity-killswitch',
    arguments: 'enabled=false',
  },
  'diagnostics/dump-on': { command: 'antigravity-dump', arguments: 'on' },
  'diagnostics/dump-off': { command: 'antigravity-dump', arguments: 'off' },
}

/**
 * The native apply for one drawer choice. Explicit target values are sent
 * ("turn on"), never a toggle, so a repeated or late choice cannot flip a
 * setting back. An account item sends its selector exactly as the server
 * issued it; a malformed one is refused here rather than guessed at.
 */
export function gaApplyBody(request: MenuApplyRequest): GaApplyBody {
  const key = `${request.sectionId}/${request.actionId}`
  if (request.sectionId === 'accounts' && request.itemId !== undefined) {
    if (!request.itemId.startsWith(ACCOUNT_ITEM_PREFIX)) {
      throw new GaMenuChoiceError('That account entry is not valid.')
    }
    const selector = request.itemId.slice(ACCOUNT_ITEM_PREFIX.length)
    if (!SELECTOR.test(selector)) {
      throw new GaMenuChoiceError('That account entry is not valid.')
    }
    const action: GaAccountAction | undefined =
      request.actionId === 'enable'
        ? { kind: 'enable', selector }
        : request.actionId === 'disable'
          ? { kind: 'disable', selector }
          : request.actionId === 'remove'
            ? { kind: 'remove', selector }
            : request.actionId === 'select-active'
              ? { kind: 'select', selector, target: 'active' }
              : request.actionId === 'select-claude'
                ? { kind: 'select', selector, target: 'claude' }
                : request.actionId === 'select-gemini'
                  ? { kind: 'select', selector, target: 'gemini' }
                  : undefined
    if (!action) throw new GaMenuChoiceError('Unknown account action.')
    if (action.kind === 'remove' && request.confirmed !== true) {
      throw new GaMenuChoiceError('Removing an account needs a confirmation.')
    }
    return { command: 'antigravity-account', action }
  }
  if (request.itemId !== undefined) {
    throw new GaMenuChoiceError('Unknown menu entry.')
  }
  const fixed = TEXT_ACTIONS[key]
  if (fixed) return fixed
  if (key === 'limits/killswitch-minimum') {
    const percent = request.values.percent
    if (
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < 0 ||
      percent > 100
    ) {
      throw new GaMenuChoiceError(
        'The minimum must be a whole number from 0 to 100.',
      )
    }
    return {
      command: 'antigravity-killswitch',
      arguments: `minimum_remaining_percent=${percent}`,
    }
  }
  if (key === 'diagnostics/log-level') {
    const level = request.values.level
    if (!GA_LOG_LEVELS.includes(level as GaLogLevel)) {
      throw new GaMenuChoiceError('Unknown log level.')
    }
    return { command: 'antigravity-logging', arguments: String(level) }
  }
  throw new GaMenuChoiceError('Unknown menu action.')
}

const TARGET_TEXT: Readonly<
  Record<Exclude<GaTargetOutcome, 'applied'>, string>
> = {
  'stale-target':
    'That account changed since the list was shown; nothing was changed. Choose it again from the refreshed list.',
  'unknown-target':
    'That account is no longer known; nothing was changed. Choose it again from the refreshed list.',
  'unsupported-index-action':
    'Accounts can only be chosen from the list; nothing was changed.',
  failed: 'The account action did not complete.',
}

/**
 * Turns a native command result into the drawer's result. `ok` is true only
 * when the command applied and, for an account action, its target applied.
 * A sign-in link is shown in full: on GA the browser returns to this
 * machine's sign-in listener, so there is nothing to paste.
 */
export function gaMenuResult(
  result: GaCommandResult,
  menu: MenuModel,
): MenuApplyResult {
  const outcome = result.targetOutcome ?? null
  const ok =
    result.status === 'applied' && (outcome === null || outcome === 'applied')
  let text = result.text
  if (outcome !== null && outcome !== 'applied') {
    text = `${TARGET_TEXT[outcome]}`
  }
  if (result.authorizationUrl) {
    text = `Open ${result.authorizationUrl} in your browser and sign in.\nThe account is added when the browser returns here; there is nothing to paste.`
  }
  return {
    command: ANTIGRAVITY_MENU_COMMAND,
    ok,
    text,
    ...(ok ? {} : { code: outcome ?? result.status }),
    menu,
  }
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/**
 * `MenuUi` over the GA dialog API. After `isActive()` turns false every call
 * is inert: a select resolves as dismissed and nothing is shown.
 */
export function createGaMenuUi(
  context: GaTuiContext,
  isActive: () => boolean,
): MenuUi {
  const { dialog, toast } = context.ui
  return {
    async select(input) {
      if (!isActive()) return undefined
      dialog.set({ size: 'xlarge' })
      const chosen = await dialog.select<string>({
        title: input.title,
        options: input.options.map((option) => ({ ...option })),
        ...(input.current === undefined ? {} : { current: input.current }),
      })
      return isActive() ? chosen : undefined
    },
    async prompt(input) {
      if (!isActive()) return undefined
      dialog.set({ size: 'xlarge' })
      const value = await dialog.prompt({ ...input })
      return isActive() ? value : undefined
    },
    async confirm(input) {
      if (!isActive()) return false
      const yes = await dialog.confirm({ ...input })
      return isActive() && yes === true
    },
    async alert(input) {
      if (!isActive()) return
      await dialog.alert({ ...input })
    },
    toast(message, kind = 'info') {
      if (isActive()) toast.show({ message, variant: kind })
    },
    clear() {
      if (isActive()) dialog.clear()
    },
  }
}

// ── Poller ──────────────────────────────────────────────────────────────────

export function currentScope(route: GaRoute): GaScope {
  return route.type === 'session'
    ? { kind: 'session', sessionID: route.sessionID }
    : { kind: 'sessionless' }
}

export interface GaPollerOptions {
  readonly client: GaLocationClient
  readonly scope: () => GaScope
  readonly onSnapshot: (snapshot: GaSnapshot) => void
  readonly onNotification: (
    notification: GaNotification,
    scope: GaScope,
  ) => void
  readonly logger?: GaLogger
}

/**
 * One poll tick: pull the current scope, hand every new notification over in
 * cursor order, and keep pulling (bounded) while the server says more are
 * waiting. Never throws; a failed pull is logged and the next tick retries.
 */
export async function pollGaOnce(options: GaPollerOptions): Promise<void> {
  const scope = options.scope()
  for (let pulls = 0; pulls < MAX_PULLS_PER_TICK; pulls += 1) {
    let result: GaPullResult
    try {
      result = await options.client.pull(scope)
    } catch (error) {
      if (!(error instanceof GaClientDisposedError)) {
        options.logger?.warn('ga-pull-failed', {
          error: error instanceof Error ? error.name : typeof error,
        })
      }
      return
    }
    if (result.kind !== 'snapshot') return
    const { snapshot } = result
    options.onSnapshot(snapshot)
    for (const notification of [...snapshot.notifications].sort(
      (a, b) => a.cursor - b.cursor,
    )) {
      if (options.client.disposed()) return
      options.onNotification(notification, snapshot.scope)
    }
    if (!snapshot.more) return
  }
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

interface SidebarView {
  readonly scope: GaScope
  readonly projected: ProjectedSidebar
}

function GaSidebar(props: {
  readonly view: () => SidebarView | undefined
  readonly sessionID: string
}): JSX.Element {
  // The route line belongs to one session; show it only in that session's
  // sidebar, never another session's.
  const route = () => {
    const view = props.view()
    if (view === undefined || view.scope.kind !== 'session') return null
    return view.scope.sessionID === props.sessionID
      ? view.projected.route
      : null
  }
  return (
    <box flexDirection='column' width='100%'>
      <text>
        <b>Antigravity</b>
      </text>
      <Show when={props.view()} fallback={<text>connecting…</text>}>
        {(view) => (
          <>
            <For each={view().projected.accounts}>
              {(account) => (
                <box flexDirection='column' width='100%'>
                  <box
                    flexDirection='row'
                    justifyContent='space-between'
                    width='100%'
                  >
                    <text>{account.label}</text>
                    <text>{account.status}</text>
                  </box>
                  <For each={account.quota}>
                    {(row) => (
                      <box
                        flexDirection='row'
                        justifyContent='space-between'
                        width='100%'
                      >
                        <text>
                          {`${row.label.padEnd(6)}${row.remaining === null ? '—' : `${Math.round(row.remaining)}%`}`}
                        </text>
                        <text>{row.reset}</text>
                      </box>
                    )}
                  </For>
                  <text>{`  ${account.health}`}</text>
                </box>
              )}
            </For>
            <Show when={route()}>
              {(line) => <text>{`Route ${line()}`}</text>}
            </Show>
            <For each={view().projected.notices}>
              {(notice) => <text>{notice}</text>}
            </For>
          </>
        )}
      </Show>
    </box>
  )
}

// ── Plugin setup ────────────────────────────────────────────────────────────

export interface GaSetupOptions {
  readonly logger?: GaLogger
  readonly now?: () => number
  /** Replaces the interval timer (tests). Returns a function that stops it. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void
}

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

/**
 * GA TUI setup: claims the sidebar, starts the location poller and opens the
 * drawer for every menu the server pushes. Returns the cleanup that stops
 * all of it; after cleanup no answer, dialog or toast from this setup
 * reaches the host.
 */
export function setupGaTui(
  context: GaTuiContext,
  options: GaSetupOptions = {},
): () => Promise<void> {
  const logger = options.logger
  const now = options.now ?? Date.now
  const client = createGaLocationClient({
    call: (input) => context.client.rpc.call(input),
    location: context.location,
    ...(logger ? { logger } : {}),
  })
  const active = () => !client.disposed()
  const ui = createGaMenuUi(context, active)
  const [view, setView] = createSignal<SidebarView | undefined>(undefined)

  const releaseSlot = context.ui.slot({
    append: 'sidebar.content',
    render: (input) => <GaSidebar view={view} sessionID={input.sessionID} />,
  })

  // The latest snapshot per scope; the drawer's menu is built from it.
  const latest = new Map<string, GaSnapshot>()

  const showSnapshot = (snapshot: GaSnapshot) => {
    latest.set(scopeKey(snapshot.scope), snapshot)
    setView({
      scope: snapshot.scope,
      projected: projectSidebar({
        accounts: snapshot.accounts,
        route: snapshot.route,
        status: snapshot.status,
        now: now(),
      }),
    })
  }

  /**
   * Pulls fresh state for `scope` and returns the menu built from it. Any
   * notifications the pull carries are handled like a poll tick's.
   */
  const freshMenu = async (scope: GaScope): Promise<MenuModel | undefined> => {
    let fresh: GaSnapshot | undefined
    await pollGaOnce({
      client,
      scope: () => scope,
      onSnapshot: (snapshot) => {
        fresh = snapshot
        showSnapshot(snapshot)
      },
      onNotification,
      ...(logger ? { logger } : {}),
    })
    return fresh ? buildGaMenu(fresh, now()) : undefined
  }

  const applyChoice = async (
    scope: GaScope,
    request: MenuApplyRequest,
    shown: () => MenuModel,
  ): Promise<MenuApplyResult> => {
    const refused = async (text: string, code: string) => ({
      command: ANTIGRAVITY_MENU_COMMAND,
      ok: false,
      text,
      code,
      menu: (await freshMenu(scope)) ?? shown(),
    })
    let body: GaApplyBody
    try {
      body = gaApplyBody(request)
    } catch (error) {
      if (error instanceof GaMenuChoiceError)
        return refused(error.message, 'invalid-choice')
      throw error
    }
    let result: GaCommandResult
    try {
      result = await client.apply(scope, body)
    } catch (error) {
      if (error instanceof GaStaleError)
        return refused(error.message, error.reason)
      throw error
    }
    // Settings and accounts shown next come from a fresh read, not from the
    // apply's answer.
    const menu = (await freshMenu(scope)) ?? shown()
    return gaMenuResult(result, menu)
  }

  function onNotification(notification: GaNotification, scope: GaScope) {
    const snapshot = latest.get(scopeKey(scope))
    if (!snapshot) return
    let shown = buildGaMenu(snapshot, now())
    void openAntigravityMenu(
      {
        ui,
        apply: async (request) => {
          const result = await applyChoice(scope, request, () => shown)
          shown = result.menu
          return result
        },
        ...(context.renderer?.copyToClipboardOSC52
          ? {
              copy: (text: string) =>
                context.renderer?.copyToClipboardOSC52?.(text) === true,
            }
          : {}),
        onError: (message, detail) => logger?.warn(message, detail),
        startSection: sectionForCommand(notification.command),
      },
      { command: ANTIGRAVITY_MENU_COMMAND, menu: shown },
    ).catch((error: unknown) => {
      logger?.warn('menu-drawer-failed', {
        error: error instanceof Error ? error.name : typeof error,
      })
    })
  }

  let inFlight = false
  const tick = () => {
    if (inFlight || !active()) return
    inFlight = true
    void pollGaOnce({
      client,
      scope: () => currentScope(context.ui.router.current()),
      onSnapshot: showSnapshot,
      onNotification,
      ...(logger ? { logger } : {}),
    }).finally(() => {
      inFlight = false
    })
  }
  const stop = (options.schedule ?? defaultSchedule)(tick, GA_SIDEBAR_PULL_MS)
  tick()

  let cleaned = false
  return async () => {
    if (cleaned) return
    cleaned = true
    stop()
    client.dispose()
    releaseSlot()
  }
}

/**
 * The GA TUI plugin definition (`{ id, setup }`, the 2.0.22 TUI plugin
 * shape). Importing this module starts nothing; `setup` binds to the
 * context's location and returns the cleanup that stops everything it
 * started.
 */
const gaTuiPlugin = {
  id: GA_TUI_ID,
  setup: (context: GaTuiContext): (() => Promise<void>) => setupGaTui(context),
}

export default gaTuiPlugin
