/**
 * The OpenCode 2 (GA host) location services: account state for the
 * `antigravity-auth` RPC `state` method, the dialog commands behind `apply`,
 * and `createGaLocationServicesFactory`, which builds a location's services
 * from the admitted account repository and the shared request pipeline.
 *
 * Accounts come from the location's account repository, read once per
 * `state` call. Each account the client sees carries an opaque selector: a
 * random string issued for one exact credential (row id, credential epoch and
 * recorded identity). The client names accounts only by selector; a selector
 * whose credential has since been replaced, re-identified or removed is
 * refused as stale, and an account position is never accepted as a target.
 * Selectors are never reused for another credential.
 *
 * Everything a location needs (repository, settings controller, dump switch,
 * logger) arrives explicitly; nothing here reads a process-global binding.
 * The GA server module is imported for types only, so it can import this
 * module's factory without a cycle.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  type AccountManager,
  type AccountMetadataV3,
  type AccountRepository,
  AccountRepositoryError,
  type AccountRepositoryRead,
  type AccountRow,
  type AccountStoreBinding,
  type AccountStoreModules,
  type AccountTokenExchange,
  type AntigravityVaultAccountSource,
  createAccountRepositoryFactory,
  ensureProjectContext,
  type FetchAccountQuota,
  fetchWithAgyCliTransport,
  formatRefreshParts,
  HealthScoreTracker,
  loadCommonAuthStoreModules,
  type ManagedAccount,
  type OAuthAuthDetails,
  parseRefreshParts,
  type RowRef,
  readAccountStoreAdmission,
  readAccountStoreBinding,
  refreshAntigravityToken,
  rowRefKey,
  sameRowRef,
  TokenBucketTracker,
  type VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'
import type {
  AntigravityAccountAction,
  AntigravityAccountDto,
  AntigravityAccountResult,
  AntigravityCommandResult,
  AntigravityRpcScope,
  AntigravitySettingsDto,
  AntigravityStatusDto,
  AntigravityTargetOutcome,
} from '../ga/rpc/protocol.ts'
import type {
  GaApplyRequest,
  GaCommandService,
  GaJobExecutor,
  GaLocationServices,
  GaLocationServicesFactory,
  GaPluginOverrides,
  GaRuntimeCollaborators,
  GaStateRead,
  GaStateSource,
  HarnessAccessBlock,
  HarnessAccountObservation,
  HarnessMetadataStatus,
  ObserveAccountSnapshot,
} from '../ga/server/index.ts'
import {
  redactAccountForSidebar,
  type SidebarAccountRedactionInput,
  type SidebarRoutingEntry,
} from '../sidebar-state.ts'
import { extractAccountAccessErrorDetails } from './account-access.ts'
import {
  createLocalAccountCredentials,
  loadAccountManagerFromRepository,
} from './accounts.ts'
import {
  parseAccountAction,
  parseKillswitchArguments,
  parseLoggingLevel,
  parseToggleArguments,
} from './command-apply.ts'
import type { GeminiDumpState } from './gemini-dump.ts'
import { parseGeminiDumpCommandAction } from './gemini-dump.ts'
import type { Logger } from './logger.ts'
import type { OperatorSettings } from './operator-settings.ts'
import { createAuthorizedFetchAccountQuota } from './quota.ts'
import {
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from './request.ts'
import { AgySessionRegistry } from './session-context.ts'
import {
  type AntigravityRequestExecutor,
  createLocalQuotaRefresh,
  createRequestExecutor,
  type LocalRequestCredentials,
  type RequestAccountRow,
  type RequestRoutingEntry,
  type VaultRequestCredentials,
} from './shared/request-services.ts'
import { createMemoryQuotaSnapshots } from './shared/runtime.ts'

/** Accounts one `state` answer may carry (`ANTIGRAVITY_RPC_LIMITS.accounts`). */
const ACCOUNT_LIMIT = 64

/**
 * How many retired selectors are remembered so a late action on one is
 * answered `stale-target` rather than `unknown-target`. Older ones are
 * forgotten and then answered `unknown-target`; neither outcome writes.
 */
const RETIRED_SELECTOR_MEMORY = 256

/** `disabledReason` recorded when the user disables an account from a dialog. */
const DIALOG_DISABLED_REASON = 'disabled from the account dialog'

// ---------------------------------------------------------------------------
// Selector registry
// ---------------------------------------------------------------------------

/** What a selector names, as the registry resolves it. */
export type GaSelectorResolution =
  | { readonly kind: 'live'; readonly ref: RowRef }
  | { readonly kind: 'retired'; readonly ref: RowRef }
  | { readonly kind: 'unknown' }

/**
 * Selectors issued for one activation. A selector is bound to one exact
 * `RowRef` for life: the same credential keeps its selector across reads,
 * and a credential that changes gets a new one while the old one retires.
 */
export interface GaSelectorRegistry {
  /**
   * The selectors one read would show, without changing the registry.
   * `commit` makes them current; an aborted read simply drops the plan.
   */
  plan(refs: readonly RowRef[]): GaSelectorPlan
  resolve(selector: string): GaSelectorResolution
}

export interface GaSelectorPlan {
  /** One selector per input ref, in input order. */
  readonly selectors: readonly string[]
  /** Makes this plan current; returns the selectors it retired. */
  commit(): readonly string[]
}

/** 128 random bits, URL-safe; carries no account data. */
function defaultSelector(): string {
  return `s-${randomBytes(16).toString('base64url')}`
}

export function createGaSelectorRegistry(
  createSelector: () => string = defaultSelector,
): GaSelectorRegistry {
  /** Live selectors by exact ref key, and the ref each selector names. */
  const live = new Map<string, string>()
  const liveRefs = new Map<string, RowRef>()
  /** Retired selectors in retirement order (oldest first). */
  const retired = new Map<string, RowRef>()
  const issued = new Set<string>()

  const fresh = (): string => {
    for (;;) {
      const selector = createSelector()
      if (!issued.has(selector)) return selector
    }
  }

  return {
    plan(refs) {
      const additions = new Map<string, { selector: string; ref: RowRef }>()
      const selectors = refs.map((ref) => {
        const key = rowRefKey(ref)
        const existing = live.get(key) ?? additions.get(key)?.selector
        if (existing !== undefined) return existing
        const selector = fresh()
        additions.set(key, { selector, ref })
        return selector
      })
      const keep = new Set(refs.map((ref) => rowRefKey(ref)))
      let committed = false
      return {
        selectors,
        commit() {
          if (committed) return []
          committed = true
          const retiredNow: string[] = []
          for (const [key, selector] of live) {
            if (keep.has(key)) continue
            const ref = liveRefs.get(selector)
            live.delete(key)
            liveRefs.delete(selector)
            if (ref !== undefined) retired.set(selector, ref)
            retiredNow.push(selector)
          }
          for (const [key, entry] of additions) {
            if (live.has(key)) continue
            issued.add(entry.selector)
            live.set(key, entry.selector)
            liveRefs.set(entry.selector, entry.ref)
          }
          while (retired.size > RETIRED_SELECTOR_MEMORY) {
            const oldest = retired.keys().next().value
            if (oldest === undefined) break
            retired.delete(oldest)
          }
          return retiredNow
        },
      }
    },
    resolve(selector) {
      const ref = liveRefs.get(selector)
      if (ref !== undefined) return { kind: 'live', ref }
      const old = retired.get(selector)
      if (old !== undefined) return { kind: 'retired', ref: old }
      return { kind: 'unknown' }
    },
  }
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

type RoutingSlot = 'active' | 'claude' | 'gemini'

function routingSlotsOf(
  read: Extract<AccountRepositoryRead, { status: 'ready' }>,
  ref: RowRef,
): RoutingSlot[] {
  const routing = read.routing
  if (routing === undefined) return []
  const slots: RoutingSlot[] = []
  if (routing.activeRow && sameRowRef(routing.activeRow, ref))
    slots.push('active')
  const byFamily = routing.activeRowByFamily
  if (byFamily?.claude && sameRowRef(byFamily.claude, ref)) slots.push('claude')
  if (byFamily?.gemini && sameRowRef(byFamily.gemini, ref)) slots.push('gemini')
  return slots
}

function metadataStatusOf(row: AccountRow): HarnessMetadataStatus {
  const view = row.metadata
  if (view.status === 'present') return 'present'
  if (view.status === 'absent') return 'absent'
  return view.reason === 'uncovered' ? 'dropped-uncovered' : 'dropped-invalid'
}

/**
 * The access block the row's metadata records. Absent or dropped metadata
 * cannot rule a block out, so it is `unknown`, never `none`.
 */
export function accessBlockOf(row: AccountRow): HarnessAccessBlock {
  if (row.metadata.status !== 'present') return { kind: 'unknown' }
  const metadata = row.metadata.metadata
  const verification = metadata.verificationRequired
  const ineligible = metadata.accountIneligible
  const flag = (value: unknown) =>
    value === undefined || value === null || typeof value === 'boolean'
  if (!flag(verification) || !flag(ineligible)) return { kind: 'invalid' }
  if (verification === true && ineligible === true) return { kind: 'invalid' }
  if (verification === true) {
    const reason = metadata.verificationRequiredReason
    return {
      kind: 'verification-required',
      reason:
        reason === undefined || reason === null
          ? 'unrecorded'
          : reason === 'validation-required'
            ? 'validation-required'
            : 'other',
    }
  }
  if (ineligible === true) {
    const reason = metadata.accountIneligibleReason
    return {
      kind: 'ineligible',
      reason:
        reason === undefined || reason === null
          ? 'unrecorded'
          : reason === 'account-ineligible'
            ? 'account-ineligible'
            : 'other',
    }
  }
  return { kind: 'none' }
}

function cooldownOf(row: AccountRow): number | null {
  if (row.metadata.status !== 'present') return null
  const until = row.metadata.metadata.coolingDownUntil
  return typeof until === 'number' ? until : null
}

type CachedQuota = NonNullable<SidebarAccountRedactionInput['cachedQuota']>

function quotaOf(row: AccountRow): CachedQuota | undefined {
  if (row.quota.status !== 'present') return undefined
  const groups = row.quota.quota.cachedQuota
  if (!groups) return undefined
  const out: CachedQuota = {}
  for (const [key, group] of Object.entries(groups)) {
    out[key] = {
      ...(typeof group.remainingFraction === 'number'
        ? { remainingFraction: group.remainingFraction }
        : {}),
      ...(typeof group.resetTime === 'string'
        ? { resetTime: group.resetTime }
        : {}),
      modelCount: group.modelCount,
      ...(group.windows
        ? {
            windows: group.windows.map((window) => ({
              window: window.window,
              remainingFraction: window.remainingFraction,
              resetTime: window.resetTime,
            })),
          }
        : {}),
    }
  }
  return out
}

function tierOf(row: AccountRow): SidebarAccountRedactionInput['tier'] {
  if (row.metadata.status !== 'present') return undefined
  const metadata = row.metadata.metadata
  if (
    typeof metadata.capturedTierId !== 'string' ||
    typeof metadata.capturedTierAt !== 'number'
  )
    return undefined
  return {
    id: metadata.capturedTierId,
    ...(typeof metadata.capturedPaidTierId === 'string'
      ? { paidId: metadata.capturedPaidTierId }
      : {}),
    capturedAt: metadata.capturedTierAt,
  }
}

/**
 * The redaction input for one row: position, flags, cooldown, quota and
 * tier. It carries no email, label, token, project, identity or row id.
 */
function redactionInputOf(
  row: AccountRow,
  position: number,
  current: boolean,
  health: (row: AccountRow) => number | undefined,
): SidebarAccountRedactionInput {
  const cooldown = cooldownOf(row)
  const quota = quotaOf(row)
  const tier = tierOf(row)
  const score = health(row)
  return {
    index: position,
    enabled: row.enabled,
    current,
    ...(cooldown !== null ? { coolingDownUntil: cooldown } : {}),
    ...(score !== undefined ? { healthScore: score } : {}),
    ...(quota !== undefined ? { cachedQuota: quota } : {}),
    ...(tier !== undefined ? { tier } : {}),
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The settings DTO from the location's live controller and dump switch. It
 * only reads; per-account killswitch overrides stay out because their keys
 * derive from refresh tokens.
 */
export function gaSettingsOf(
  settings: OperatorSettings,
  dump: Pick<GeminiDumpState, 'isEnabled'>,
): AntigravitySettingsDto {
  return {
    routing: {
      cliFirst: settings.routing.cli_first,
      quotaStyleFallback: settings.routing.quota_style_fallback,
    },
    killswitch: {
      enabled: settings.killswitch.enabled,
      minimumRemainingPercent: settings.killswitch.minimum_remaining_percent,
    },
    logLevel: settings.log_level,
    dump: { enabled: dump.isEnabled() },
  }
}

// ---------------------------------------------------------------------------
// State source
// ---------------------------------------------------------------------------

export interface GaAccountStateOptions {
  readonly repository: Pick<AccountRepository, 'read'>
  readonly registry: GaSelectorRegistry
  readonly generation: string
  /** Read fresh for every answer, after the repository read. */
  readonly settings: () => AntigravitySettingsDto
  readonly status: () => AntigravityStatusDto
  /** The requesting session's route; `null` when there is none. */
  readonly route: (scope: AntigravityRpcScope) => SidebarRoutingEntry | null
  /** Health score for a row, when the location tracks one. */
  readonly health?: (row: AccountRow) => number | undefined
  readonly observe?: ObserveAccountSnapshot
}

/** One read's projected rows, with each row's exact ref kept privately. */
interface ProjectedRead {
  readonly read: AccountRepositoryRead
  readonly rows: readonly {
    readonly selector: string
    readonly row: SidebarAccountRedactionInput
    readonly source: AccountRow
    readonly slots: readonly RoutingSlot[]
  }[]
  readonly overLimit: number | null
  readonly plan: GaSelectorPlan | null
}

function project(
  read: AccountRepositoryRead,
  registry: GaSelectorRegistry,
  health: (row: AccountRow) => number | undefined,
): ProjectedRead {
  if (read.status !== 'ready') {
    return { read, rows: [], overLimit: null, plan: null }
  }
  if (read.rows.length > ACCOUNT_LIMIT) {
    return { read, rows: [], overLimit: read.rows.length, plan: null }
  }
  const plan = registry.plan(read.rows.map((row) => row.ref))
  const rows = read.rows.map((row, position) => {
    const slots = routingSlotsOf(read, row.ref)
    return {
      selector: plan.selectors[position] ?? '',
      row: redactionInputOf(row, position, slots.includes('active'), health),
      source: row,
      slots,
    }
  })
  return { read, rows, overLimit: null, plan }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('The state read was aborted')
}

/**
 * Builds the `state` source. Reads run one at a time, so `readSeq` follows
 * the order answers are built in; an aborted read leaves the selector
 * registry unchanged. The diagnostic observer, when present, is called
 * synchronously with a view of the same read.
 */
export function createGaAccountStateSource(
  options: GaAccountStateOptions,
): GaStateSource {
  let readSeq = 0
  let queue: Promise<unknown> = Promise.resolve()
  const health = options.health ?? (() => undefined)

  const readOnce = async (input: {
    readonly scope: AntigravityRpcScope
    readonly signal: AbortSignal
  }): Promise<GaStateRead> => {
    if (input.signal.aborted) throw abortError(input.signal)
    const read = await options.repository.read()
    if (input.signal.aborted) throw abortError(input.signal)
    const projected = project(read, options.registry, health)
    const settings = options.settings()
    const status = options.status()
    const route = options.route(input.scope)
    if (input.signal.aborted) throw abortError(input.signal)

    const retiredSelectors = projected.plan?.commit() ?? []
    readSeq += 1
    const answer: GaStateRead = {
      readSeq,
      accounts:
        projected.overLimit !== null
          ? { kind: 'over-limit', count: projected.overLimit }
          : {
              kind: 'complete',
              rows: projected.rows.map(({ selector, row }) => ({
                selector,
                row,
              })),
            },
      route,
      status,
      settings,
    }
    if (options.observe) {
      const accounts: HarnessAccountObservation[] = projected.rows.map(
        ({ selector, source, slots }, position) => ({
          selector,
          position,
          enabled: source.enabled,
          usable: source.usable,
          metadataStatus: metadataStatusOf(source),
          accessBlock: accessBlockOf(source),
          currentFor: slots,
          cooldownUntil: cooldownOf(source),
        }),
      )
      try {
        options.observe({
          generation: options.generation,
          readSeq,
          status: read.status,
          accountsStatus:
            projected.overLimit !== null ? 'over-limit' : 'complete',
          accounts,
          retiredSelectors,
        })
      } catch {
        // A diagnostic observer cannot change the answer.
      }
    }
    return answer
  }

  return {
    read(input) {
      const next = queue.then(
        () => readOnce(input),
        () => readOnce(input),
      )
      queue = next.catch(() => undefined)
      return next
    },
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface GaCommandServiceOptions {
  readonly repository: Pick<
    AccountRepository,
    'read' | 'setEnabled' | 'remove' | 'selectAccount'
  >
  readonly registry: GaSelectorRegistry
  readonly settings: {
    get(): OperatorSettings
    update(mutator: (draft: OperatorSettings) => void): Promise<void>
  }
  readonly dump: Pick<GeminiDumpState, 'isEnabled' | 'setEnabled'>
  /** Applies a changed log level to the location's logger. */
  readonly applyLogLevel: () => void
  /** Checks quota now for every account; resolves when the pulls settle. */
  readonly refreshQuota: (signal: AbortSignal) => Promise<void>
  readonly health?: (row: AccountRow) => number | undefined
}

/** Repository failures meaning the selector's credential is gone. */
const STALE_FAILURES = new Set(['attribution', 'unknown-row', 'id-removed'])

function staleKind(error: unknown): boolean {
  return (
    error instanceof AccountRepositoryError &&
    STALE_FAILURES.has(error.failure.kind)
  )
}

function textOf(error: unknown): string {
  return error instanceof AccountRepositoryError
    ? `The account store refused the change (${error.failure.kind}).`
    : 'The change could not be completed.'
}

/**
 * Builds the dialog command service. Account actions resolve their selector
 * to the exact credential it was issued for, re-read the repository and
 * refuse a credential that has changed before anything is written.
 */
export function createGaCommandService(
  options: GaCommandServiceOptions,
): GaCommandService {
  const health = options.health ?? (() => undefined)

  const accountsAfter = async (): Promise<AntigravityAccountDto[] | null> => {
    const projected = project(
      await options.repository.read(),
      options.registry,
      health,
    )
    if (projected.read.status !== 'ready' || projected.overLimit !== null)
      return null
    projected.plan?.commit()
    return projected.rows.map(({ selector, row }) => ({
      ...redactAccountForSidebar(row),
      selector,
    }))
  }

  const accountResult = (
    status: AntigravityAccountResult['status'],
    text: string,
    targetOutcome: AntigravityTargetOutcome | null,
    accounts: AntigravityAccountDto[] | null = null,
  ): AntigravityAccountResult => ({
    command: 'antigravity-account',
    status,
    text,
    accounts,
    authorizationUrl: null,
    targetOutcome,
  })

  const runAction = async (
    action: AntigravityAccountAction,
    signal: AbortSignal,
  ): Promise<AntigravityAccountResult> => {
    if (signal.aborted)
      return accountResult('failed', 'The location is shutting down.', null)
    const resolved = options.registry.resolve(action.selector)
    if (resolved.kind === 'unknown')
      return accountResult(
        'rejected',
        'That account is not known; reopen the dialog.',
        'unknown-target',
      )
    if (resolved.kind === 'retired')
      return accountResult(
        'rejected',
        'That account changed since the dialog opened; reopen it.',
        'stale-target',
      )
    const ref = resolved.ref
    const read = await options.repository.read()
    if (read.status !== 'ready')
      return accountResult(
        'failed',
        `The account store is not ready (${read.status}).`,
        'failed',
      )
    const row = read.rows.find((candidate) => candidate.ref.id === ref.id)
    if (row === undefined || !sameRowRef(row.ref, ref))
      return accountResult(
        'rejected',
        'That account changed since the dialog opened; reopen it.',
        'stale-target',
      )
    if (signal.aborted)
      return accountResult('failed', 'The location is shutting down.', null)
    try {
      switch (action.kind) {
        case 'enable':
          await options.repository.setEnabled(ref, {
            enabled: true,
            actor: 'user',
          })
          break
        case 'disable':
          await options.repository.setEnabled(ref, {
            enabled: false,
            actor: 'user',
            reason: DIALOG_DISABLED_REASON,
          })
          break
        case 'remove':
          await options.repository.remove(ref)
          break
        case 'select':
          await options.repository.selectAccount(action.target, ref)
          break
      }
    } catch (error) {
      if (staleKind(error))
        return accountResult(
          'rejected',
          'That account changed since the dialog opened; reopen it.',
          'stale-target',
        )
      return accountResult('failed', textOf(error), 'failed')
    }
    return accountResult(
      'applied',
      `Account ${action.kind} applied.`,
      'applied',
      await accountsAfter(),
    )
  }

  const settingsUpdate = async (
    mutator: (draft: OperatorSettings) => void,
  ): Promise<string | null> => {
    try {
      await options.settings.update(mutator)
      return null
    } catch {
      return 'The settings file could not be updated.'
    }
  }

  const apply = async (
    request: GaApplyRequest,
  ): Promise<AntigravityCommandResult> => {
    if (request.signal.aborted && request.command !== 'antigravity-quota') {
      return failedFor(request.command)
    }
    switch (request.command) {
      case 'antigravity-quota': {
        try {
          await options.refreshQuota(request.signal)
        } catch {
          return {
            command: 'antigravity-quota',
            status: 'failed',
            text: 'Quota could not be refreshed.',
            accounts: null,
          }
        }
        return {
          command: 'antigravity-quota',
          status: 'applied',
          text: 'Quota refreshed',
          accounts: await accountsAfter(),
        }
      }
      case 'antigravity-account': {
        const parsed = parseAccountAction(request.arguments)
        if (parsed === undefined)
          return accountResult('rejected', 'Unrecognised account action.', null)
        if (
          parsed.kind === 'current' ||
          parsed.kind === 'toggle' ||
          parsed.kind === 'remove'
        )
          return accountResult(
            'rejected',
            'Accounts are chosen from the dialog list, not by number.',
            'unsupported-index-action',
          )
        if (parsed.kind === 'refresh')
          return accountResult(
            'applied',
            'Accounts reloaded',
            null,
            await accountsAfter(),
          )
        return accountResult(
          'rejected',
          'Add accounts with the OpenCode login flow for this provider.',
          null,
        )
      }
      case 'antigravity-routing': {
        const parsed = parseToggleArguments(request.arguments)
        const failure = await settingsUpdate((draft) => {
          if (parsed.cli_first !== undefined)
            draft.routing.cli_first = parsed.cli_first
          if (parsed.quota_style_fallback !== undefined)
            draft.routing.quota_style_fallback = parsed.quota_style_fallback
        })
        const after = options.settings.get()
        return {
          command: 'antigravity-routing',
          status: failure ? 'failed' : 'applied',
          text: failure ?? 'Routing updated',
          routing: failure
            ? null
            : {
                cliFirst: after.routing.cli_first,
                quotaStyleFallback: after.routing.quota_style_fallback,
              },
        }
      }
      case 'antigravity-killswitch': {
        const parsed = parseKillswitchArguments(request.arguments)
        const failure = await settingsUpdate((draft) => {
          if (parsed.enabled !== undefined)
            draft.killswitch.enabled = parsed.enabled
          if (parsed.minimum_remaining_percent !== undefined)
            draft.killswitch.minimum_remaining_percent =
              parsed.minimum_remaining_percent
        })
        const after = options.settings.get()
        return {
          command: 'antigravity-killswitch',
          status: failure ? 'failed' : 'applied',
          text: failure ?? 'Killswitch updated',
          killswitch: failure
            ? null
            : {
                enabled: after.killswitch.enabled,
                minimumRemainingPercent:
                  after.killswitch.minimum_remaining_percent,
              },
        }
      }
      case 'antigravity-dump': {
        const action = parseGeminiDumpCommandAction(request.arguments)
        if (action.type === 'enable') options.dump.setEnabled(true)
        else if (action.type === 'disable') options.dump.setEnabled(false)
        const enabled = options.dump.isEnabled()
        return {
          command: 'antigravity-dump',
          status: 'applied',
          text: `Gemini dump is ${enabled ? 'on' : 'off'}`,
          dump: { enabled },
        }
      }
      case 'antigravity-logging': {
        const level = parseLoggingLevel(request.arguments)
        const failure = await settingsUpdate((draft) => {
          draft.log_level = level
        })
        if (!failure) options.applyLogLevel()
        return {
          command: 'antigravity-logging',
          status: failure ? 'failed' : 'applied',
          text: failure ?? `Logging level set to ${level}`,
          logLevel: failure ? null : level,
        }
      }
    }
  }

  return {
    apply,
    applyAccountAction: (request) => runAction(request.action, request.signal),
  }
}

function failedFor(
  command: GaApplyRequest['command'],
): AntigravityCommandResult {
  const text = 'The location is shutting down.'
  switch (command) {
    case 'antigravity-quota':
      return { command, status: 'failed', text, accounts: null }
    case 'antigravity-account':
      return {
        command,
        status: 'failed',
        text,
        accounts: null,
        authorizationUrl: null,
        targetOutcome: null,
      }
    case 'antigravity-routing':
      return { command, status: 'failed', text, routing: null }
    case 'antigravity-killswitch':
      return { command, status: 'failed', text, killswitch: null }
    case 'antigravity-dump':
      return { command, status: 'failed', text, dump: null }
    case 'antigravity-logging':
      return { command, status: 'failed', text, logLevel: null }
  }
}

// ---------------------------------------------------------------------------
// Location services factory
// ---------------------------------------------------------------------------

/** The legacy account file name inside a location directory. */
export const GA_ACCOUNTS_FILE = 'antigravity-accounts.json'

/** What `start` hands the request pipeline binding. */
export interface GaRequestPipelineInput {
  readonly repository: AccountRepository
  readonly runtime: GaStartInput['runtime']
  readonly send: GaStartInput['send']
  readonly generation: string
  readonly overrides: GaPluginOverrides
  /** Where the engine records each session's route for `state`. */
  readonly routes: GaRouteBook
}

/** The request pipeline for one activation, as the shared engine builds it. */
export interface GaRequestPipeline {
  readonly execute: GaJobExecutor
  dispose(): Promise<void>
}

type GaStartInput = Parameters<GaLocationServices['start']>[0]

export interface GaLocationServicesBindings {
  /** The common-auth `./store` and `./fs` modules the repository is built on. */
  readonly loadStoreModules: () => Promise<AccountStoreModules>
  readonly now: () => number
  readonly createSelector?: () => string
  /** The location runtime's collaborators (sidebar file, quota, refresh). */
  readonly runtime: (input: {
    readonly directory: string
    readonly repository: AccountRepository
    readonly overrides: GaPluginOverrides
  }) => GaRuntimeCollaborators
  /** Builds the shared request engine over the location's repository. */
  readonly createPipeline: (
    input: GaRequestPipelineInput,
  ) => Promise<GaRequestPipeline>
}

/**
 * The repository's token exchange: the core OAuth refresh, or the test
 * override. It returns the bare tokens; the repository stores them.
 */
function tokenExchange(overrides: GaPluginOverrides): AccountTokenExchange {
  const refresh = overrides.refreshAccessToken ?? refreshAntigravityToken
  return async ({ refreshToken }) => {
    const result = await refresh(refreshToken)
    return {
      accessToken: result.access,
      refreshToken: result.refresh,
      expiresAt: result.expires,
    }
  }
}

function storeRefusal(
  status: Exclude<AccountStoreBinding, { status: 'bound' }>,
): Error {
  return new Error(
    status.status === 'initialization-required'
      ? 'The Antigravity account store is not initialized; initialize it with the antigravity-auth CLI.'
      : status.status === 'error'
        ? `The Antigravity account store cannot be opened: ${status.reason}`
        : `The Antigravity account store is ${status.status}; finish its migration or rollback with \`antigravity-auth migrate --offline\` or \`antigravity-auth rollback --offline\`.`,
  )
}

/** The location's repository and the store generation it was bound to. */
interface LocationRepository {
  readonly repository: AccountRepository
  readonly legacyPath: string
  readonly generation: string
  readonly modules: AccountStoreModules
}

/**
 * Opens the location's account repository on the migration's canonical
 * binding: a completed generation the repository may open, including to
 * resume its own pending clear or replace work. Binding is not permission
 * to route; `assertServingAdmission` checks that before any credential is
 * used. Initialization and migration are offline CLI operations, never a
 * side effect of activation.
 */
async function openLocationRepository(
  directory: string,
  bindings: GaLocationServicesBindings,
  overrides: GaPluginOverrides,
): Promise<LocationRepository> {
  const legacyPath = join(directory, GA_ACCOUNTS_FILE)
  const modules = await bindings.loadStoreModules()
  const binding = await readAccountStoreBinding(
    legacyPath,
    modules,
    bindings.now,
  )
  if (binding.status !== 'bound') throw storeRefusal(binding)
  return {
    repository: createAccountRepositoryFactory(modules)({
      paths: binding.paths,
      now: bindings.now,
      exchange: tokenExchange(overrides),
    }),
    legacyPath,
    generation: binding.receipt.id,
    modules,
  }
}

/**
 * Serving needs the full admission of the same generation the repository
 * was bound to: healthy current rows and no pending management work.
 */
async function assertServingAdmission(
  location: LocationRepository,
  now: () => number,
): Promise<void> {
  const admission = await readAccountStoreAdmission(
    location.legacyPath,
    location.modules,
    now,
    location.generation,
  )
  if (admission.status === 'active') return
  if (admission.status === 'pending' && admission.phase === 'activate')
    throw new Error(
      'An Antigravity account operation is still finishing; reopen the session once it completes.',
    )
  throw storeRefusal(admission)
}

// ---------------------------------------------------------------------------
// Request pipeline (local account repository)
// ---------------------------------------------------------------------------

/**
 * How long a response body may stall before the transport destroys the
 * socket; the GA raw sender (`GA_RAW_IDLE_TIMEOUT_MS`) uses the same five
 * minutes. Declared here because the GA server module is imported for types
 * only.
 */
const GA_TRANSPORT_IDLE_TIMEOUT_MS = 300_000

/** A local grant whose account no longer holds it; the engine reselects. */
export class GaStaleGrantError extends Error {
  constructor() {
    super('The selected account no longer holds this grant')
    this.name = 'GaStaleGrantError'
  }
}

/**
 * Local credentials for a repository-backed GA location, in the shared
 * engine's `local` domain. A refresh is of the selected account itself:
 * `refreshAccount` uses the ref the account was loaded with, so the
 * repository stores a successor token only for that exact credential and
 * refuses one whose row has since changed. Rows are never found again by
 * token.
 */
export function createGaLocalCredentials(
  manager: AccountManager,
  options: {
    readonly overrides: GaPluginOverrides
    readonly refreshQuotaAfterSuccess?: LocalRequestCredentials<ManagedAccount>['refreshQuotaAfterSuccess']
  },
): LocalRequestCredentials<ManagedAccount> {
  const local = createLocalAccountCredentials(manager, {
    ...(options.overrides.ensureProjectContext
      ? { ensureProject: options.overrides.ensureProjectContext }
      : {}),
  })
  return {
    domain: 'local',
    toAuthDetails: (account) => manager.toAuthDetails(account),
    updateFromAuth: (account, auth) => manager.updateFromAuth(account, auth),
    removeAccount: (account) => manager.removeAccount(account),
    saveToDisk: () => manager.saveToDisk(),
    saveToDiskReplace: () => manager.saveToDiskReplace(),
    refresh: (account) => local.refresh(account),
    // A grant is sent only while its account is still in this manager's
    // pool, enabled, attributed to a repository row and still holding the
    // grant's access token; otherwise the engine reselects.
    assertGrantCurrent: ({ account, accessToken }) => {
      if (
        account.ref === undefined ||
        !manager.getAccounts().includes(account) ||
        account.enabled === false ||
        manager.toAuthDetails(account).access !== accessToken
      ) {
        throw new GaStaleGrantError()
      }
    },
    ensureProject: (auth) => local.ensureProject(auth),
    isInvalidGrant: (error) => local.isInvalidGrant(error),
    // The GA host keeps no OAuth credential of its own for this provider;
    // accounts live only in the repository, so there is nothing to clear.
    clearStoredAuth: async () => undefined,
    ...(options.refreshQuotaAfterSuccess
      ? { refreshQuotaAfterSuccess: options.refreshQuotaAfterSuccess }
      : {}),
  }
}

/**
 * A quota check's account, carrying the repository ref captured when the
 * account list was taken. Without a ref the account cannot be attributed
 * and is refused.
 */
export interface GaQuotaTarget {
  /** Same field as the core manager's quota-check target. */
  readonly rowRef?: RowRef
}

/** The bearer a quota check may use, for exactly the captured credential. */
export type GaQuotaAuthorization =
  | {
      readonly status: 'authorized'
      readonly ref: RowRef
      readonly auth: OAuthAuthDetails
    }
  | {
      readonly status: 'refused'
      readonly reason:
        | 'unattributed'
        | 'stale'
        | 'not-ready'
        | 'refresh-refused'
    }

/** How close to expiry a stored access token is still used as is. */
const QUOTA_TOKEN_SKEW_MS = 60_000

/**
 * Resolves the bearer for one quota check from the repository, by the
 * target's captured ref only. A row that no longer holds that exact
 * credential (replaced, re-identified or removed) is refused rather than
 * checked on its successor. An expired token is refreshed through the
 * repository's attributed refresh, never locally.
 */
export async function authorizeGaQuotaCheck(
  repository: Pick<AccountRepository, 'read' | 'refresh'>,
  target: GaQuotaTarget,
  now: () => number,
): Promise<GaQuotaAuthorization> {
  const ref = target.rowRef
  if (ref === undefined) return { status: 'refused', reason: 'unattributed' }
  const read = await repository.read()
  if (read.status !== 'ready') return { status: 'refused', reason: 'not-ready' }
  const row = read.rows.find((candidate) => sameRowRef(candidate.ref, ref))
  if (row === undefined || row.credential === undefined || !row.usable)
    return { status: 'refused', reason: 'stale' }
  const metadata =
    row.metadata.status === 'present' ? row.metadata.metadata : undefined
  const projects = {
    ...(metadata?.projectId ? { projectId: metadata.projectId } : {}),
    ...(metadata?.managedProjectId
      ? { managedProjectId: metadata.managedProjectId }
      : {}),
  }
  const stored = row.credential
  if (
    stored.accessToken !== undefined &&
    stored.expiresAt !== undefined &&
    stored.expiresAt - QUOTA_TOKEN_SKEW_MS > now()
  ) {
    return {
      status: 'authorized',
      ref,
      auth: {
        type: 'oauth',
        refresh: formatRefreshParts({
          refreshToken: stored.refreshToken,
          ...projects,
        }),
        access: stored.accessToken,
        expires: stored.expiresAt,
      },
    }
  }
  const outcome = await repository.refresh(ref)
  if (outcome.status !== 'rotated')
    return { status: 'refused', reason: 'refresh-refused' }
  const after = await repository.read()
  const successor =
    after.status === 'ready'
      ? after.rows.find((candidate) => sameRowRef(candidate.ref, outcome.ref))
      : undefined
  if (successor?.credential === undefined)
    return { status: 'refused', reason: 'stale' }
  return {
    status: 'authorized',
    ref: outcome.ref,
    auth: {
      type: 'oauth',
      refresh: formatRefreshParts({
        refreshToken: successor.credential.refreshToken,
        ...projects,
      }),
      access: outcome.accessToken,
      expires: outcome.expiresAt,
    },
  }
}

// ---------------------------------------------------------------------------
// Vault credentials
// ---------------------------------------------------------------------------

/**
 * A vault-backed pool row: selection metadata plus the vault route it was
 * listed under. It carries no token, refresh token or project.
 */
export interface GaVaultAccountRow extends RequestAccountRow {
  readonly route: VaultRouteRef
}

/**
 * The shared engine's vault credential domain over the core vault account
 * source. Every physical send asks the source for a fresh receipt for the
 * selected row's route and uses that receipt's token and project for that
 * send only; a 401 is reported against the exact receipt that served it.
 * Nothing is refreshed locally, cached or written to a row.
 */
export function createGaVaultCredentials(
  source: Pick<AntigravityVaultAccountSource, 'admit' | 'reportServedStatus'>,
): VaultRequestCredentials<GaVaultAccountRow> {
  return {
    domain: 'vault',
    async admit({ account, signal }) {
      const admission = await source.admit(account.route, signal)
      return {
        credentialId: admission.credentialId,
        accountIdentity: admission.accountIdentity,
        recordVersion: admission.recordVersion,
        accessToken: admission.accessToken,
        projectId: admission.projectId,
        report401: (status) => source.reportServedStatus(admission, status),
      }
    },
  }
}

function isRowRef(value: unknown): value is RowRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'credentialEpoch' in value &&
    typeof value.credentialEpoch === 'number' &&
    (!('identity' in value) ||
      value.identity === undefined ||
      typeof value.identity === 'string')
  )
}

/** The captured ref a quota target carries, when it carries a valid one. */
function rowRefOfTarget(account: AccountMetadataV3): RowRef | undefined {
  if (!('rowRef' in account)) return undefined
  return isRowRef(account.rowRef) ? account.rowRef : undefined
}

/**
 * The GA location's quota fetcher. Each check is attributed to the target's
 * captured repository ref: the bearer comes from `authorizeGaQuotaCheck`
 * (stored token, or the repository's attributed refresh), and a target
 * without a ref, or whose credential has since changed, is answered with an
 * error result instead of being checked on another credential.
 */
export function createGaFetchAccountQuota(options: {
  readonly repository: Pick<AccountRepository, 'read' | 'refresh'>
  readonly now: () => number
  readonly overrides: GaPluginOverrides
  readonly logger: Pick<Logger, 'debug'>
}): FetchAccountQuota {
  const ensureProject =
    options.overrides.ensureProjectContext ?? ensureProjectContext
  const quotaFetch = options.overrides.quotaFetch
  return createAuthorizedFetchAccountQuota({
    logger: options.logger,
    ...(quotaFetch ? { transport: () => quotaFetch } : {}),
    async authorize(account) {
      // Captured before any await: the ref of exactly this target.
      const rowRef = rowRefOfTarget(account)
      const authorization = await authorizeGaQuotaCheck(
        options.repository,
        { rowRef },
        options.now,
      )
      if (authorization.status !== 'authorized')
        return { status: 'refused', reason: authorization.reason }
      const ref = authorization.ref
      const accessToken = authorization.auth.access ?? ''
      const project = await ensureProject(authorization.auth)
      const managedProjectId = parseRefreshParts(
        project.auth.refresh,
      ).managedProjectId
      return {
        status: 'authorized',
        domain: 'local',
        accessToken,
        projectId: project.effectiveProjectId,
        ...(managedProjectId ? { managedProjectId } : {}),
        // Before every request: the row must still hold exactly this
        // credential and this access token.
        confirmSend: async () => {
          const read = await options.repository.read()
          const row =
            read.status === 'ready'
              ? read.rows.find((candidate) => sameRowRef(candidate.ref, ref))
              : undefined
          if (row === undefined || !row.usable)
            return { status: 'stale', reason: 'credential changed' }
          if (row.credential?.accessToken !== accessToken)
            return { status: 'stale', reason: 'access token changed' }
          return { status: 'current' }
        },
      }
    },
  })
}

/** The route each session's last request was dispatched on, in memory. */
export interface GaRouteBook {
  record(sessionId: string, entry: RequestRoutingEntry): void
  route(scope: AntigravityRpcScope): SidebarRoutingEntry | null
}

export function createGaRouteBook(limit = 256): GaRouteBook {
  const routes = new Map<string, SidebarRoutingEntry>()
  return {
    record(sessionId, entry) {
      routes.delete(sessionId)
      routes.set(sessionId, {
        accountId: entry.accountId,
        modelFamily: entry.modelFamily,
        headerStyle: entry.headerStyle,
        ...(entry.strategy ? { strategy: entry.strategy } : {}),
        updatedAt: entry.updatedAt,
      })
      while (routes.size > limit) {
        const oldest = routes.keys().next().value
        if (oldest === undefined) break
        routes.delete(oldest)
      }
    },
    route(scope) {
      return scope.kind === 'session'
        ? (routes.get(scope.sessionID) ?? null)
        : null
    },
  }
}

/** Runs one bridged job through the shared request engine. */
export function createGaJobExecutor(
  executor: Pick<AntigravityRequestExecutor, 'execute'>,
): GaJobExecutor {
  return (job, context) =>
    executor.execute(
      job.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: job.body,
        signal: context.signal,
      },
      {
        session: {
          sessionId: job.sessionID,
          parentSessionId: job.parentSessionID,
        },
      },
    )
}

/**
 * The shared request engine over a repository-backed account manager. The
 * engine is the same one OpenCode 1 uses; only its collaborators are this
 * location's.
 */
export async function createGaLocalRequestPipeline(
  input: GaRequestPipelineInput & {
    /** This activation's account slot, read by its runtime's token refresher. */
    readonly accounts: GaAccountSlot
  },
): Promise<GaRequestPipeline> {
  const runtime = input.runtime
  const manager = await loadAccountManagerFromRepository(input.repository)
  input.accounts.current = manager
  input.accounts.quotaLogger = runtime.logger.createLogger('quota')
  await runtime.replaceAccounts(manager)
  const logger = runtime.logger.createLogger('request')
  const observe = input.overrides.observeRawSenderSignal
  const config = runtime.config.config
  const executor = createRequestExecutor({
    config,
    accounts: manager,
    credentials: createGaLocalCredentials(manager, {
      overrides: input.overrides,
      refreshQuotaAfterSuccess: createLocalQuotaRefresh(
        manager,
        runtime.quotaManager,
        logger,
      ),
    }),
    sessions: new AgySessionRegistry(runtime.directory),
    operatorSettings: runtime.operatorSettings,
    transport: (url, init, options) => {
      const transportOptions = {
        ...options,
        idleTimeoutMs: options?.idleTimeoutMs ?? GA_TRANSPORT_IDLE_TIMEOUT_MS,
      }
      if (observe && transportOptions.signal) {
        try {
          observe(transportOptions.signal)
        } catch {
          // A diagnostic failure must not change or delay the dispatch.
        }
      }
      return fetchWithAgyCliTransport(url, init, transportOptions)
    },
    fetchImpl: (request, init) => fetch(request, init),
    wire: {
      prepare: prepareAntigravityRequest,
      transformResponse: transformAntigravityResponse,
      buildThinkingWarmupBody,
      getImageModelLocalTitle,
      getLastCacheStats,
    },
    debug: runtime.debug,
    dump: runtime.dump,
    logger,
    // Per-location trackers; never the process-wide ones.
    trackers: {
      health: new HealthScoreTracker(),
      token: new TokenBucketTracker(),
    },
    classifyAccessError: extractAccountAccessErrorDetails,
    onRouting: (sessionId, entry) => input.routes.record(sessionId, entry),
  })
  return {
    execute: createGaJobExecutor(executor),
    async dispose() {
      executor.dispose()
      if (input.accounts.current === manager) {
        input.accounts.current = null
        input.accounts.quotaLogger = null
      }
      await runtime.replaceAccounts(null)
      await manager.flushSaveToDisk()
    },
  }
}

/**
 * Builds a `GaLocationServicesFactory` over explicit bindings. Every
 * resource acquired during construction or `start` is released if that step
 * fails; `dispose` releases the pipeline, then the repository.
 */
export function createGaLocationServicesFactory(
  bindings: GaLocationServicesBindings,
): GaLocationServicesFactory {
  return async ({ directory, overrides }): Promise<GaLocationServices> => {
    const opened = await openLocationRepository(directory, bindings, overrides)
    const repository = opened.repository
    let runtime: GaRuntimeCollaborators
    try {
      runtime = bindings.runtime({ directory, repository, overrides })
    } catch (error) {
      await repository.dispose().catch(() => {
        // The construction error is the one the host needs to see.
      })
      throw error
    }
    const registry = createGaSelectorRegistry(bindings.createSelector)
    let pipeline: GaRequestPipeline | null = null
    let disposed: Promise<void> | null = null

    return {
      runtime,
      async start(input) {
        if (disposed) throw new Error('The location services are disposed')
        await assertServingAdmission(opened, bindings.now)
        const location = input.runtime
        const routes = createGaRouteBook()
        pipeline = await bindings.createPipeline({
          repository,
          runtime: location,
          send: input.send,
          generation: input.generation,
          overrides,
          routes,
        })
        const state = createGaAccountStateSource({
          repository,
          registry,
          generation: input.generation,
          settings: () =>
            gaSettingsOf(location.operatorSettings.get(), location.dump),
          status: () => ({
            checkedAt: null,
            quotaBackoffUntil: null,
            routingAuthoritative: true,
          }),
          route: (scope) => routes.route(scope),
          ...(overrides.observeAccountSnapshot
            ? { observe: overrides.observeAccountSnapshot }
            : {}),
        })
        const commands = createGaCommandService({
          repository,
          registry,
          settings: location.operatorSettings,
          dump: location.dump,
          applyLogLevel: () => location.applyOperatorSettings(),
          refreshQuota: () => repository.settled(),
        })
        return { state, commands, execute: pipeline.execute }
      },
      dispose() {
        disposed ??= (async () => {
          const active = pipeline
          pipeline = null
          try {
            if (active) await active.dispose()
          } finally {
            await repository.dispose()
          }
        })()
        return disposed
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

/**
 * One activation's account manager, shared by its request pipeline and its
 * runtime's proactive token refresher. Each activation has its own slot.
 */
export interface GaAccountSlot {
  current: AccountManager | null
  /** The activation's quota logger, from its location runtime once built. */
  quotaLogger: Pick<Logger, 'debug'> | null
}

/**
 * The runtime collaborators of a repository-backed GA location: quota
 * snapshots kept in memory (a GA location writes no sidebar file), the
 * ref-attributed quota fetcher, and a token refresher that refreshes the
 * account it is handed through this activation's manager.
 */
export function createGaRuntimeCollaborators(input: {
  readonly repository: AccountRepository
  readonly overrides: GaPluginOverrides
  readonly accounts: GaAccountSlot
  readonly now: () => number
}): GaRuntimeCollaborators {
  return {
    quotaSnapshots: createMemoryQuotaSnapshots(),
    fetchAccountQuota: createGaFetchAccountQuota({
      repository: input.repository,
      now: input.now,
      overrides: input.overrides,
      // The location logger exists only once the runtime is built; until
      // then (no check can run before start) records are dropped.
      logger: {
        debug: (...args) => input.accounts.quotaLogger?.debug(...args),
      },
    }),
    refreshToken: async (_auth, account) => {
      const manager = input.accounts.current
      if (manager === null || !manager.getAccounts().includes(account))
        return undefined
      const outcome = await manager.refreshAccount(account)
      return outcome.status === 'rotated'
        ? manager.toAuthDetails(account)
        : undefined
    },
  }
}

/**
 * The production GA location services: the embedded common-auth store,
 * the system clock, the repository-backed request pipeline and the
 * collaborators above. Every activation gets its own repository, account
 * slot and pipeline.
 */
export const createGaLocationServices: GaLocationServicesFactory = (input) => {
  const accounts: GaAccountSlot = { current: null, quotaLogger: null }
  return createGaLocationServicesFactory({
    loadStoreModules: loadCommonAuthStoreModules,
    now: Date.now,
    runtime: ({ repository, overrides }) =>
      createGaRuntimeCollaborators({
        repository,
        overrides,
        accounts,
        now: Date.now,
      }),
    createPipeline: (pipeline) =>
      createGaLocalRequestPipeline({ ...pipeline, accounts }),
  })(input)
}
