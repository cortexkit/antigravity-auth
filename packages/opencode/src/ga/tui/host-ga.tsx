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
 * accounts carry opaque `selector`s and every snapshot carries the location's
 * settings). Notifications and apply answers carry the server's shared menu.
 * The drawer keeps its presentation while submitting the issued menu item
 * and action ids, never a sidebar selector or an account position.
 *
 * Nothing here imports account storage, tokens, OAuth, the vault client or
 * server code, and nothing writes to the terminal or forces a theme.
 */

import { createSignal, type JSX } from 'solid-js'
import {
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
  type MenuDialogPayload,
  type MenuModel,
  type MenuNotifyPayload,
  type MenuParseResult,
  type MenuSection,
  type MenuUi,
  parseMenuApplyResult,
  parseMenuDialogPayload,
  parseMenuNotifyPayload,
} from '../../tui/host-api'
import {
  AntigravitySidebar,
  DEFAULT_FRAME_SETTINGS,
  type FrameColor,
  type FrameRoute,
  type FrameTheme,
} from '../../tui/sidebar-frame'

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

/**
 * The host's durable plugin storage, as far as the sidebar uses it: one
 * JSON store and the function that changes it.
 */
export interface GaStorage {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
}

/** The parts of the GA TUI `Context` this adapter uses. */
export interface GaTuiContext {
  /** The host's resolved theme; read on every render, so a switch shows. */
  readonly theme?: GaTheme
  readonly storage?: GaStorage
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
          readonly category?: string
          readonly footer?: string
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
  readonly payload: MenuDialogPayload | MenuNotifyPayload
}

/** A redacted account plus the opaque selector that names its credential. */
export interface GaAccount extends ProjectionAccount {
  readonly selector: string
}

/** The location's operator settings, read fresh for every `state` answer. */
export interface GaSettings {
  readonly selectionStrategy: 'sticky' | 'round-robin' | 'hybrid' | 'vault'
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
  readonly vaultHostStatus?: 'Served by Thalamus'
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

/** What the client sends besides version, generation and scope. */
export interface GaApplyBody {
  readonly request: MenuApplyRequest
}

export type GaApplyOutput =
  | {
      readonly kind: 'applied'
      readonly generation: string
      readonly scope: GaScope
      readonly result: MenuApplyResult
    }
  | { readonly kind: 'stale-generation'; readonly generation: string }
  | { readonly kind: 'disposed'; readonly generation: string }

const GENERATION = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_ID = /^[\x21-\x7e]{1,256}$/
const ACCOUNT_ID = /^acct-(0|[1-9][0-9]{0,5})$/
const ACCOUNT_LABEL = /^Account [1-9][0-9]{0,5}$/
const SELECTOR = /^sel-[A-Za-z0-9_-]{32}$/

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
  keys(
    value,
    ['remainingPercent'],
    ['resetAt', 'windows', 'checkedAt'],
    path,
    issues,
  )
  checkPercent(value.remainingPercent, `${path}.remainingPercent`, issues)
  if (value.resetAt !== undefined && !isTime(value.resetAt)) {
    issues.push(`${path}.resetAt: expected a time`)
  }
  if (value.checkedAt !== undefined && !isTime(value.checkedAt))
    issues.push(`${path}.checkedAt: expected a time`)
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
    keys(
      window,
      ['window', 'remainingPercent'],
      ['resetAt', 'checkedAt'],
      at,
      issues,
    )
    if (window.window !== 'weekly' && window.window !== '5h') {
      issues.push(`${at}.window: unknown window`)
    }
    if (window.checkedAt !== undefined && !isTime(window.checkedAt))
      issues.push(`${at}.checkedAt: expected a time`)
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
    keys(
      value.quota,
      [],
      ['gemini', 'non-gemini', 'gemini-argon'],
      `${path}.quota`,
      issues,
    )
    checkQuotaEntry(value.quota.gemini, `${path}.quota.gemini`, issues)
    checkQuotaEntry(
      value.quota['non-gemini'],
      `${path}.quota.non-gemini`,
      issues,
    )
    checkQuotaEntry(
      value.quota['gemini-argon'],
      `${path}.quota.gemini-argon`,
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
  if (value.headerStyle !== 'antigravity') {
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
  keys(value, ['cursor', 'payload'], [], path, issues)
  if (!isCursor(value.cursor) || value.cursor < 1) {
    issues.push(`${path}.cursor: expected a positive cursor`)
  }
  const parsed =
    isRecord(value.payload) && Object.hasOwn(value.payload, 'notify')
      ? parseMenuNotifyPayload(value.payload)
      : parseMenuDialogPayload(value.payload)
  if (!parsed.ok)
    issues.push(...parsed.issues.map((issue) => `${path}.payload: ${issue}`))
}

function checkBool(value: unknown, path: string, issues: Issues) {
  if (typeof value !== 'boolean') issues.push(`${path}: expected true/false`)
}

function checkSettings(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path}: expected settings`)
    return
  }
  keys(
    value,
    ['selectionStrategy', 'killswitch', 'logLevel', 'dump'],
    [],
    path,
    issues,
  )
  const { killswitch, dump } = value
  if (
    !['sticky', 'round-robin', 'hybrid', 'vault'].includes(
      value.selectionStrategy as string,
    )
  ) {
    issues.push(
      `${path}.selectionStrategy: expected an account selection strategy`,
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
    ['vaultHostStatus'],
    'output',
    issues,
  )
  if (!isCursor(output.readSeq)) issues.push('output.readSeq: expected a count')
  if (
    Object.hasOwn(output, 'vaultHostStatus') &&
    output.vaultHostStatus !== 'Served by Thalamus'
  )
    issues.push('output.vaultHostStatus: expected the hosted vault status')
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
  const result = parseMenuApplyResult(output.result)
  if (!result.ok) issues.push(...result.issues)
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
  apply(scope: GaScope, body: GaApplyBody): Promise<MenuApplyResult>
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
        `${row.label} ${row.figure}${row.reset ? ` · ${row.reset}` : ''}`,
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
            ...(snapshot.vaultHostStatus ||
            settings.selectionStrategy === 'vault'
              ? []
              : [
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
                ]),
          ],
        }
      }),
      actions:
        snapshot.vaultHostStatus || settings.selectionStrategy === 'vault'
          ? []
          : [
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
      lines:
        settings.selectionStrategy === 'vault'
          ? ["Selection follows the vault's served accounts."]
          : [
              `Account selection strategy: ${settings.selectionStrategy}`,
              {
                sticky: 'Keep the current account until it is unavailable.',
                'round-robin':
                  'Rotate among available accounts for each request.',
                hybrid:
                  'Choose available accounts using health and quota signals.',
              }[settings.selectionStrategy],
              'Configured in antigravity.json: account_selection_strategy',
            ],
      items: [],
      actions: [],
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
    sections: snapshot.vaultHostStatus
      ? [
          ...sections,
          {
            id: 'vault',
            slot: 'extra',
            title: 'Vault',
            lines: [snapshot.vaultHostStatus],
            items: [],
            actions: [],
          },
        ]
      : sections,
  }
}

/** A displayed choice is no longer present in the server-issued menu. */
export class GaMenuChoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GaMenuChoiceError'
  }
}

export interface GaMenuPresentation {
  readonly menu: MenuModel
  readonly source: MenuModel
  request(choice: MenuApplyRequest): MenuApplyRequest
}

/**
 * Keep the drawer's labels and order, but bind every choice to an action
 * actually issued by the server. Snapshot selectors are display data, not
 * shared-menu item ids. The bindings retain the server's exact item id even
 * when the roster changes before a choice arrives.
 */
export function presentGaMenu(
  snapshot: GaSnapshot,
  now: number,
  source: MenuModel,
): GaMenuPresentation {
  const bindings = new Map<
    string,
    (choice: MenuApplyRequest) => MenuApplyRequest
  >()
  const key = (
    sectionId: string,
    itemId: string | undefined,
    actionId: string,
  ) => JSON.stringify([sectionId, itemId, actionId])
  const bind = (
    sectionId: string,
    itemId: string | undefined,
    display: MenuAction,
    action: MenuAction,
    values: (
      choice: MenuApplyRequest['values'],
    ) => MenuApplyRequest['values'] = (choice) => choice,
  ): MenuAction => {
    bindings.set(key(sectionId, itemId, display.id), (choice) => ({
      command: source.command,
      sectionId,
      ...(itemId === undefined ? {} : { itemId }),
      actionId: action.id,
      values: values(choice.values),
      ...(choice.confirmed ? { confirmed: true } : {}),
    }))
    return {
      ...display,
      ...(action.confirm ? { confirm: action.confirm } : {}),
    }
  }
  const display = buildGaMenu(snapshot, now)
  const sections = display.sections
    .filter((section) => section.slot !== 'extra')
    .flatMap((section) => {
      const actual = source.sections.find(
        (candidate) => candidate.id === section.id,
      )
      if (!actual) return []
      const actions = section.actions.flatMap((action) => {
        const id =
          section.id === 'limits'
            ? 'set'
            : action.id === 'log-level'
              ? 'logging'
              : action.id.startsWith('dump-')
                ? 'dump'
                : action.id
        const offered = actual.actions.find((candidate) => candidate.id === id)
        if (!offered) return []
        const values =
          section.id !== 'limits'
            ? undefined
            : action.id === 'killswitch-minimum'
              ? (input: MenuApplyRequest['values']) => ({
                  minimumRemainingPercent: input.percent ?? null,
                })
              : () => ({ enabled: action.id === 'killswitch-on' })
        return [bind(actual.id, undefined, action, offered, values)]
      })
      const items = actual.items.map((item) => {
        const projected = section.items.find(
          (candidate) => candidate.label === item.label,
        )
        if (!projected) return { ...item, actions: [] }
        return {
          ...projected,
          id: item.id,
          actions: projected.actions.flatMap((action) => {
            const target = action.id.startsWith('select-')
              ? action.id.slice('select-'.length)
              : undefined
            const offered = item.actions.find(
              (candidate) => candidate.id === (target ? 'select' : action.id),
            )
            if (!offered) return []
            return [
              bind(
                actual.id,
                item.id,
                action,
                offered,
                target ? () => ({ target }) : undefined,
              ),
            ]
          }),
        }
      })
      return [{ ...section, items, actions }]
    })
  // Enrollment and hosted status remain the server's own sections, including
  // their authority-dependent Connect/Disconnect actions and read-only host.
  for (const section of source.sections.filter(
    (candidate) => candidate.slot === 'extra',
  )) {
    sections.push({
      ...section,
      actions: section.actions.map((action) =>
        bind(section.id, undefined, action, action),
      ),
      items: section.items.map((item) => ({
        ...item,
        actions: item.actions.map((action) =>
          bind(section.id, item.id, action, action),
        ),
      })),
    })
  }
  return {
    menu: { ...display, sections },
    source,
    request(choice) {
      const resolve = bindings.get(
        key(choice.sectionId, choice.itemId, choice.actionId),
      )
      if (choice.command !== source.command || !resolve)
        throw new GaMenuChoiceError(
          'That action is no longer offered. Open the menu again.',
        )
      return resolve(choice)
    },
  }
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/** The drawer owns this prompt, so a browser callback can dismiss it. */
export async function runGaDrawerLogin(input: {
  ui: MenuUi
  request: MenuApplyRequest
  apply(request: MenuApplyRequest): Promise<MenuApplyResult>
  completed: Promise<boolean>
}): Promise<MenuApplyResult> {
  const started = await input.apply(input.request)
  if (!started.ok) return started
  let promptOpen = true
  const completed = input.completed.then((ok) => {
    if (promptOpen) input.ui.clear()
    return {
      ...started,
      ok,
      text: ok
        ? 'Account added.'
        : 'The Antigravity pool login could not be completed.',
    }
  })
  const answer = input.ui
    .prompt({
      title: 'Add account',
      description: started.text,
      placeholder: "Paste the redirect URL from your browser's address bar",
    })
    .then((value) => ({ value }))
  const winner = await Promise.race([completed, answer])
  promptOpen = false
  if (!('value' in winner)) return winner
  if (winner.value === undefined) {
    return input.apply({ ...input.request, values: { cancel: true } })
  }
  if (!winner.value.trim()) return completed
  return Promise.race([
    input.apply({ ...input.request, values: { callback: winner.value } }),
    completed,
  ])
}

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
  /** The snapshot's accounts; the frame reads their state and stored windows. */
  readonly accounts: readonly GaAccount[]
  readonly route: ProjectionRoute | null
  readonly quotaBackoffUntil: number | null
  /** The clock reading the snapshot was taken at; the quota rows use it too. */
  readonly readAt: number
}

type HostColor = { readonly base?: FrameColor; readonly muted?: FrameColor }

/**
 * The OpenCode 2 host theme tokens the sidebar reads (the host's resolved
 * theme, as far as this sidebar uses it). Any of them may be missing.
 */
export interface GaTheme {
  readonly text?: HostColor & {
    readonly action?: { readonly primary?: HostColor }
    readonly feedback?: {
      readonly success?: HostColor
      readonly warning?: HostColor
      readonly error?: HostColor
    }
  }
  readonly background?: HostColor & { readonly raised?: HostColor }
  readonly border?: HostColor
}

/**
 * Maps the OpenCode 2 semantic theme tokens onto the frame's OpenCode 1
 * names. A missing token falls back to a sibling token; with none at all
 * the color stays `undefined`, so the host's default color shows and no
 * color is ever fixed here.
 */
export function sidebarThemeFromHost(theme: GaTheme | undefined): FrameTheme {
  const text =
    theme?.text?.base ??
    theme?.text?.muted ??
    theme?.text?.action?.primary?.base
  const accent = theme?.text?.action?.primary?.base ?? text
  const feedback = theme?.text?.feedback
  return {
    text,
    textMuted: theme?.text?.muted ?? text,
    accent,
    background: theme?.background?.base ?? theme?.background?.raised?.base,
    success: feedback?.success?.base ?? feedback?.success?.muted,
    warning: feedback?.warning?.base ?? feedback?.warning?.muted,
    error: feedback?.error?.base ?? feedback?.error?.muted,
  }
}

function GaSidebar(props: {
  readonly view: () => SidebarView | undefined
  readonly sessionID: string
  readonly theme: () => GaTheme | undefined
  readonly version: string
  readonly collapsed: () => boolean
  readonly toggleCollapsed: () => void
}): JSX.Element {
  // The route belongs to one session; show it only in that session's
  // sidebar, never another session's.
  const route = (): FrameRoute | null => {
    const view = props.view()
    if (view === undefined || view.scope.kind !== 'session') return null
    if (view.scope.sessionID !== props.sessionID || view.route === null)
      return null
    return {
      ...(view.route.strategy ? { strategy: view.route.strategy } : {}),
      family: view.route.modelFamily,
      style: view.route.headerStyle,
    }
  }
  return (
    <AntigravitySidebar
      theme={() => sidebarThemeFromHost(props.theme())}
      settings={() => DEFAULT_FRAME_SETTINGS}
      version={props.version}
      collapsed={props.collapsed}
      onToggleCollapsed={props.toggleCollapsed}
      accounts={() => props.view()?.accounts ?? []}
      route={route}
      quotaBackoffUntil={() => props.view()?.quotaBackoffUntil ?? undefined}
      lastError={() => undefined}
      now={() => props.view()?.readAt ?? 0}
    />
  )
}

/** Where the collapse choice is kept in the host's plugin storage. */
export const GA_SIDEBAR_STORE_KEY = 'antigravity-auth.sidebar'

/**
 * The collapse state: the host's durable plugin storage when it has one, so
 * the choice survives a reload; for this TUI session otherwise.
 */
function createGaCollapse(
  storage: GaStorage | undefined,
  logger: GaLogger | undefined,
): { collapsed: () => boolean; toggle: () => void } {
  const saved = storage?.store(GA_SIDEBAR_STORE_KEY, {
    initial: { collapsed: false },
  })
  // A click updates the sidebar at once: the local choice wins while its
  // save is pending, and once storage holds it the stored value decides
  // again. Without storage the local choice lasts for the session.
  const [chosen, setChosen] = createSignal<boolean | undefined>(undefined)
  const collapsed = () => chosen() ?? saved?.[0].collapsed === true
  const toggle = () => {
    const next = !collapsed()
    setChosen(next)
    if (!saved) return
    saved[1]((draft) => {
      draft.collapsed = next
    }).then(
      () => {
        if (chosen() === next && saved[0].collapsed === next)
          setChosen(undefined)
      },
      (error: unknown) => {
        logger?.warn('sidebar-collapse-not-saved', {
          error: error instanceof Error ? error.name : typeof error,
        })
      },
    )
  }
  return { collapsed, toggle }
}

// ── Plugin setup ────────────────────────────────────────────────────────────

export interface GaSetupOptions {
  readonly logger?: GaLogger
  /** The plugin version shown in the sidebar header; empty or absent hides it. */
  readonly version?: string
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
  const collapse = createGaCollapse(context.storage, logger)

  const releaseSlot = context.ui.slot({
    append: 'sidebar.content',
    render: (input) => (
      <GaSidebar
        view={view}
        sessionID={input.sessionID}
        theme={() => context.theme}
        version={options.version ?? ''}
        collapsed={collapse.collapsed}
        toggleCollapsed={collapse.toggle}
      />
    ),
  })

  // Sidebar readings and presentation are scoped to the menu's own session.
  const latest = new Map<string, GaSnapshot>()

  const showSnapshot = (snapshot: GaSnapshot) => {
    latest.set(scopeKey(snapshot.scope), snapshot)
    const readAt = now()
    setView({
      scope: snapshot.scope,
      accounts: snapshot.accounts,
      route: snapshot.route,
      quotaBackoffUntil: snapshot.status.quotaBackoffUntil,
      readAt,
    })
  }

  /**
   * Pulls fresh state for `scope`. Any
   * notifications the pull carries are handled like a poll tick's.
   */
  const refresh = async (scope: GaScope): Promise<void> => {
    await pollGaOnce({
      client,
      scope: () => scope,
      onSnapshot: (snapshot) => {
        showSnapshot(snapshot)
      },
      onNotification,
      ...(logger ? { logger } : {}),
    })
  }

  const applyRequest = async (
    scope: GaScope,
    request: MenuApplyRequest,
    shown: GaMenuPresentation,
  ): Promise<MenuApplyResult> => {
    const refused = async (text: string, code: string) => ({
      command: ANTIGRAVITY_MENU_COMMAND,
      ok: false,
      text,
      code,
      menu: shown.source,
    })
    let body: GaApplyBody
    try {
      body = { request: shown.request(request) }
    } catch (error) {
      if (error instanceof GaMenuChoiceError)
        return refused(error.message, 'invalid-choice')
      throw error
    }
    let result: MenuApplyResult
    try {
      result = await client.apply(scope, body)
    } catch (error) {
      if (error instanceof GaStaleError)
        return refused(error.message, error.reason)
      throw error
    }
    await refresh(scope)
    return result
  }

  let pendingLogin: { scope: string; finish(ok: boolean): void } | undefined
  const applyChoice = async (
    scope: GaScope,
    request: MenuApplyRequest,
    shown: GaMenuPresentation,
  ) => {
    if (
      request.sectionId !== 'accounts' ||
      request.actionId !== 'add' ||
      request.itemId !== undefined
    )
      return applyRequest(scope, request, shown)
    const completed = Promise.withResolvers<boolean>()
    const pending = { scope: scopeKey(scope), finish: completed.resolve }
    pendingLogin = pending
    try {
      return await runGaDrawerLogin({
        ui,
        request,
        completed: completed.promise,
        apply: (next) => applyRequest(scope, next, shown),
      })
    } finally {
      if (pendingLogin === pending) pendingLogin = undefined
    }
  }

  function onNotification(notification: GaNotification, scope: GaScope) {
    const payload = notification.payload
    if ('notify' in payload) {
      if (
        pendingLogin?.scope === scopeKey(scope) &&
        [
          'Account added.',
          'The Antigravity pool login could not be completed.',
        ].includes(payload.notify.message)
      ) {
        pendingLogin.finish(payload.notify.kind !== 'error')
        return
      }
      ui.toast(payload.notify.message, payload.notify.kind)
      return
    }
    const snapshot = latest.get(scopeKey(scope))
    if (!snapshot) return
    let shown = presentGaMenu(snapshot, now(), payload.menu)
    void openAntigravityMenu(
      {
        ui,
        apply: async (request) => {
          const result = await applyChoice(scope, request, shown)
          shown = presentGaMenu(
            latest.get(scopeKey(scope)) ?? snapshot,
            now(),
            result.menu,
          )
          return { ...result, menu: shown.menu }
        },
        ...(context.renderer?.copyToClipboardOSC52
          ? {
              copy: (text: string) =>
                context.renderer?.copyToClipboardOSC52?.(text) === true,
            }
          : {}),
        onError: (message, detail) => logger?.warn(message, detail),
      },
      { command: ANTIGRAVITY_MENU_COMMAND, menu: shown.menu },
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
    pendingLogin?.finish(false)
    stop()
    client.dispose()
    releaseSlot()
  }
}

/**
 * The GA TUI plugin definition (`{ id, setup }`, the 2.0.22 TUI plugin
 * shape). Importing this module starts nothing; `setup` binds to the
 * context's location and returns the cleanup that stops everything it
 * started. The host calls `setup(context)`; the package's `./tui` entry
 * passes the plugin version as the second argument. This module's graph
 * may use no Node built-in (the build refuses one), so it cannot read
 * `package.json` itself.
 */
const gaTuiPlugin = {
  id: GA_TUI_ID,
  setup: (
    context: GaTuiContext,
    options: { readonly version?: string } = {},
  ): (() => Promise<void>) =>
    setupGaTui(context, options.version ? { version: options.version } : {}),
}

export default gaTuiPlugin
