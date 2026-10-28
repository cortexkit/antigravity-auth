/**
 * The OpenCode 2 (GA host) location services: account state for the
 * `antigravity-auth` RPC `state` method, the shared `/antigravity` menu
 * behind `apply`, and `createGaLocationServicesFactory`, which builds a
 * location's services from the bound account repository and the shared
 * request pipeline.
 *
 * Accounts come from the location's account repository, read once per
 * `state` call. Each account in a state answer carries an opaque selector: a
 * random string issued for one exact credential (row id, credential epoch
 * and recorded identity), kept across reads and reorders and retired when
 * that credential is replaced, re-identified or removed. Account actions run
 * through the shared menu, whose own opaque item ids are bound the same way;
 * an account position is never accepted as a target.
 *
 * Everything a location needs (repository, settings controller, dump switch,
 * logger) arrives explicitly; nothing here reads a process-global binding.
 * The GA server module is imported for types only, so it can import this
 * module's factory without a cycle.
 */

import { randomBytes } from 'node:crypto'
import {
  type AccountManager,
  type AccountMetadataV3,
  type AccountMigrationModules,
  type AccountRepository,
  type AccountRepositoryRead,
  type AccountRow,
  type AccountStoreBinding,
  type AccountStoreModules,
  type AccountTokenExchange,
  ANTIGRAVITY_MENU_COMMAND,
  type AntigravityMenuAccounts,
  type AntigravityQuotaCheckReport,
  type AntigravityRepositoryMenuOptions,
  type AntigravityVaultAccountSource,
  antigravitySettingsSections,
  authorizeAntigravity,
  type CommonAuthCommandsModule,
  createAccountRepositoryFactory,
  createAntigravityCommandMenu,
  ensureProjectContext,
  exchangeAntigravity,
  type FetchAccountQuota,
  fetchWithAgyCliTransport,
  formatRefreshParts,
  loadCommonAuthCommands,
  loadCommonAuthStoreModules,
  type ManagedAccount,
  type OAuthAuthDetails,
  parseRefreshParts,
  type QuotaCheckPurpose,
  type RowRef,
  readAccountStoreAdmission,
  readAccountStoreBinding,
  refreshAntigravityToken,
  rowRefKey,
  sameRowRef,
  VAULT_ACCOUNT_REMEDY,
  type VaultProviderStateFile,
  type VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'
import type {
  AntigravityRpcScope,
  AntigravitySettingsDto,
  AntigravityStatusDto,
} from '../ga/rpc/protocol.ts'
import type {
  GaCommandService,
  GaJobExecutor,
  GaLocationServices,
  GaLocationServicesFactory,
  GaPluginOverrides,
  GaRpcActivation,
  GaRuntimeCollaborators,
  GaStateRead,
  GaStateSource,
  HarnessAccessBlock,
  HarnessAccountObservation,
  HarnessMetadataStatus,
  ObserveAccountSnapshot,
} from '../ga/server/index.ts'
import type {
  SidebarAccountRedactionInput,
  SidebarRoutingEntry,
} from '../sidebar-state.ts'
import { currentVaultFolder } from '../vault-folder.ts'
import {
  createRepositoryAccountAccessService,
  extractAccountAccessErrorDetails,
} from './account-access.ts'
import {
  createLocalAccountCredentials,
  loadAccountManagerFromRepository,
} from './accounts.ts'
import {
  createStoreAccountLimits,
  diagnosticsMenuSection,
  operatorMenuSettings,
} from './command-apply.ts'
import {
  acquireGaVaultCustody,
  type GaVaultQuotaPolling,
  type GaVaultQuotaProducerOptions,
} from './ga-shared-vault-custody.ts'
import type { GeminiDumpState } from './gemini-dump.ts'
import type { Logger } from './logger.ts'
import type { OperatorSettings } from './operator-settings.ts'
import { commitLogins } from './persist-account-pool.ts'
import {
  createAuthorizedFetchAccountQuota,
  createStoreQuotaService,
  fetchVaultAccountQuota,
} from './quota.ts'
import {
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from './request.ts'
import { type OAuthListener, startOAuthListener } from './server.ts'
import { AgySessionRegistry } from './session-context.ts'
import { createAdvisoryRepositoryOwner } from './shared/advisory-repository.ts'
import {
  type AntigravityRequestExecutor,
  createLocalQuotaRefresh,
  createRequestExecutor,
  type LocalRequestCredentials,
  type RequestRoutingEntry,
  retiredModelResponse,
} from './shared/request-services.ts'
import {
  createMemoryQuotaSnapshots,
  type LocationRuntime,
} from './shared/runtime.ts'
import { createVaultAccountMenuSections } from './shared/vault-menu'
import {
  cachedQuotaOf,
  checkVaultQuota,
  VAULT_REFRESH_STALL_MS,
  type VaultAccountPool,
  type VaultAccountRow,
  type VaultQuotaAnswer,
  type VaultRequestSource,
  type VaultStateSource,
  vaultAccountRowKey,
} from './shared/vault-request-credentials.ts'
import {
  getStoragePath,
  initializeFreshAccountStoreFor,
  prepareLocalAccountStore,
} from './storage'
import {
  createOpenCodeVaultAccountPool,
  createOpenCodeVaultCustody,
  type OpenCodeVaultCustody,
  type OpenCodeVaultCustodyOptions,
} from './vault-custody.ts'
import { quotaReadingForVaultRoute } from './vault-sidebar-projection.ts'

/** Accounts one `state` answer may carry (`ANTIGRAVITY_RPC_LIMITS.accounts`). */
const ACCOUNT_LIMIT = 64

/**
 * How many retired selectors are remembered so a late action on one is
 * answered `stale-target` rather than `unknown-target`. Older ones are
 * forgotten and then answered `unknown-target`; neither outcome writes.
 */
const RETIRED_SELECTOR_MEMORY = 256

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

/**
 * 192 random bits as `sel-` plus 32 URL-safe characters, the selector shape
 * the RPC contract accepts; carries no account data.
 */
function defaultSelector(): string {
  return `sel-${randomBytes(24).toString('base64url')}`
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
    ...(row.quota.status === 'present' &&
    typeof row.quota.quota.cachedQuotaUpdatedAt === 'number'
      ? { cachedQuotaUpdatedAt: row.quota.quota.cachedQuotaUpdatedAt }
      : {}),
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
  selectionStrategy: AntigravitySettingsDto['selectionStrategy'],
): AntigravitySettingsDto {
  return {
    selectionStrategy,
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
  readonly nextReadSeq?: () => number
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

/** A stored quota reading time, or `null` when it is missing or not a usable time. */
function readingTime(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

/**
 * The status `checkedAt`: the newest of the rows' own quota reading times,
 * or `null` when no row has a dated reading. It is never the time of the
 * state read itself.
 */
function newestReadingTime(
  times: Iterable<number | null | undefined>,
): number | null {
  let newest: number | null = null
  for (const value of times) {
    const at = readingTime(value)
    if (at !== null && (newest === null || at > newest)) newest = at
  }
  return newest
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
    readSeq = options.nextReadSeq?.() ?? readSeq + 1
    // The rows' stored readings say when quota was last checked; the
    // location's own status has no such time of its own.
    const checkedAt = newestReadingTime([
      status.checkedAt,
      ...(read.status === 'ready'
        ? read.rows.map((row) =>
            row.quota.status === 'present'
              ? row.quota.quota.cachedQuotaUpdatedAt
              : undefined,
          )
        : []),
    ])
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
      status: { ...status, checkedAt },
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
// Menu
// ---------------------------------------------------------------------------

type GaMenuOptions = Parameters<
  CommonAuthCommandsModule['createCommandMenu']
>[0]
type GaMenuExtraSection = NonNullable<GaMenuOptions['extras']>[number]

/** The shared `/antigravity` menu, as the core factory builds it. */
export type GaCommandMenu = ReturnType<
  CommonAuthCommandsModule['createCommandMenu']
>

/**
 * The location's `/antigravity` menu: the shared core menu in repository
 * mode over this activation's repository and runtime. Accounts are acted on
 * by the menu's own opaque item ids, each bound to one exact credential;
 * Routing, Limits and Diagnostics read and write this location's settings
 * controller and dump switch. `commands` must be the module whose
 * `parseApplyRequest` the RPC activation uses.
 */
export function createGaLocationMenu(input: {
  readonly commands: CommonAuthCommandsModule
  readonly repository: AntigravityMenuAccounts &
    Pick<AccountRepository, 'updateMetadata'>
  readonly runtime: Pick<
    LocationRuntime,
    'operatorSettings' | 'dump' | 'applyOperatorSettings' | 'config'
  >
  readonly refreshQuota?: AntigravityRepositoryMenuOptions['refreshQuota']
  readonly reauthorize?: AntigravityRepositoryMenuOptions['reauthorize']
  /** The Vault section, when the location has vault custody available. */
  readonly vault?: GaMenuExtraSection
}): GaCommandMenu {
  const runtime = input.runtime
  return createAntigravityCommandMenu({
    source: 'repository',
    commands: input.commands,
    accounts: input.repository,
    settings: operatorMenuSettings(
      runtime.operatorSettings,
      () => runtime.config.config.account_selection_strategy,
    ),
    diagnostics: diagnosticsMenuSection({
      settings: runtime.operatorSettings,
      dump: runtime.dump,
      applyLogLevel: () => runtime.applyOperatorSettings(),
    }),
    accountLimits: createStoreAccountLimits({
      repository: input.repository,
      settings: runtime.operatorSettings,
    }),
    ...(input.refreshQuota ? { refreshQuota: input.refreshQuota } : {}),
    ...(input.reauthorize ? { reauthorize: input.reauthorize } : {}),
    ...(input.vault ? { extras: [input.vault] } : {}),
  })
}

/** The menu invocation for one RPC scope; its notices are queued there. */
function scopeInvocation(
  scope: AntigravityRpcScope,
  notify: GaRpcActivation['notify'],
): Parameters<GaCommandMenu['open']>[0] {
  return {
    ...(scope.kind === 'session' ? { sessionId: scope.sessionID } : {}),
    notify(message, kind) {
      notify(scope, {
        command: ANTIGRAVITY_MENU_COMMAND,
        notify: { message, kind: kind ?? 'info' },
      })
    },
  }
}

/**
 * The location's menu service: `apply` for the RPC `apply` method, and
 * `open` for the native `/antigravity` command, which queues the menu that
 * opens the drawer in the invoking session's scope.
 */
export interface GaMenuCommandService extends GaCommandService {
  open(input: {
    readonly scope: AntigravityRpcScope
    readonly signal: AbortSignal
  }): Promise<void>
}

/**
 * The menu service over the location's menu. Each request (already accepted
 * by the library's own parser) runs through the menu with an invocation for
 * its scope, whose notices are queued for that scope; once the activation's
 * signal aborts, no new action starts. After every apply, `afterApply`
 * brings the routing state up to date with what the action wrote; its
 * failure is reported to the scope but does not change the menu's answer.
 */
export function createGaMenuCommandService(input: {
  readonly menu: GaCommandMenu
  readonly notify: GaRpcActivation['notify']
  readonly afterApply?: () => Promise<void>
}): GaMenuCommandService {
  return {
    async apply({ request, scope, signal }) {
      if (signal.aborted) throw abortError(signal)
      const result = await input.menu.apply(
        request,
        scopeInvocation(scope, input.notify),
      )
      if (input.afterApply) {
        try {
          await input.afterApply()
        } catch {
          input.notify(scope, {
            command: ANTIGRAVITY_MENU_COMMAND,
            notify: {
              message:
                'The change was saved, but routing has not picked it up yet.',
              kind: 'warning',
            },
          })
        }
      }
      return result
    },
    async open({ scope, signal }) {
      if (signal.aborted) throw abortError(signal)
      const payload = await input.menu.open(
        scopeInvocation(scope, input.notify),
      )
      if (signal.aborted) throw abortError(signal)
      input.notify(scope, payload)
    },
  }
}

// ---------------------------------------------------------------------------
// Reauthorization
// ---------------------------------------------------------------------------

/** The menu's reauthorize option, as the shared core menu takes it. */
type GaReauthorize = NonNullable<
  AntigravityRepositoryMenuOptions['reauthorize']
>

/**
 * The account items' Reauthorize action for a GA location: a browser
 * sign-in whose result replaces exactly the credential the item was opened
 * for (through the account adapters' repository access service, which also
 * refuses a sign-in to a different Google account and clears the row's
 * access blocks). The action answers once the sign-in has started and the
 * callback listener is waiting; the rest finishes in the background and is
 * reported to the invoking session. `afterChange` brings routing up to date
 * with the new credential.
 *
 * Without an override, the redirect is received by this package's own
 * callback listener on the registered redirect address, which accepts only
 * the state of the sign-in it was started for.
 */
export function createGaReauthorize(input: {
  readonly assertAdmission?: () => Promise<void>
  readonly repository: AccountRepository
  readonly overrides: GaPluginOverrides
  readonly afterChange: () => Promise<void>
}): GaReauthorize & { dispose(): Promise<void> } {
  const authorize = input.overrides.oauth?.authorize ?? authorizeAntigravity
  const exchange = input.overrides.oauth?.exchange ?? exchangeAntigravity
  const waitForCode = input.overrides.oauth?.waitForCode
  const access = createRepositoryAccountAccessService({
    repository: input.repository,
    // A GA location has no terminal: it opens no browser itself and asks
    // no account question; the sign-in link is shown in the menu instead.
    openBrowser: async () => false,
    prompt: {
      selectAccount: async () => undefined,
      confirmOpenVerificationUrl: async () => false,
    },
  })
  const listeners = new Set<OAuthListener>()
  const continuations = new Set<Promise<void>>()
  const shutdown = new AbortController()
  let disposed = false

  const waitForRedirect = (code: Promise<string>): Promise<string> =>
    new Promise((resolve, reject) => {
      const detach = () => shutdown.signal.removeEventListener('abort', abort)
      const abort = () => {
        detach()
        reject(shutdown.signal.reason)
      }
      if (shutdown.signal.aborted) reject(shutdown.signal.reason)
      else shutdown.signal.addEventListener('abort', abort, { once: true })
      void code.then(
        (value) => {
          detach()
          resolve(value)
        },
        (error) => {
          detach()
          reject(error)
        },
      )
    })

  /** Return the callback promise inside an object so setup can finish before the browser login. */
  const startWaiting = async (
    expectedState: string,
  ): Promise<{ code: Promise<string> }> => {
    if (waitForCode) return { code: waitForCode(expectedState) }
    const listener = await startOAuthListener()
    if (disposed) {
      await listener.close()
      throw shutdown.signal.reason
    }
    listeners.add(listener)
    const code = (async () => {
      try {
        const url = await listener.waitForCallback()
        if (url.searchParams.get('state') !== expectedState)
          throw new Error('The sign-in answered for a different request')
        const code = url.searchParams.get('code')
        if (!code) throw new Error('The sign-in returned no code')
        return code
      } finally {
        listeners.delete(listener)
        await listener.close()
      }
    })()
    return { code }
  }

  return {
    async run(ref, invocation) {
      if (disposed)
        return {
          ok: false,
          text: 'The location is shutting down.',
          code: 'refused',
        }
      await input.assertAdmission?.()
      const authorization = await authorize()
      if (disposed) throw shutdown.signal.reason
      const state = new URL(authorization.url).searchParams.get('state')
      if (!state)
        return {
          ok: false,
          text: 'The sign-in could not be started.',
          code: 'action-failed',
        }
      const waiting = await startWaiting(state)
      const continuation = (async () => {
        try {
          const code = await waitForRedirect(waiting.code)
          await input.assertAdmission?.()
          if (disposed) throw shutdown.signal.reason
          const result = await exchange(code, state)
          if (result.type !== 'success') {
            invocation.notify('The sign-in was not completed.', 'error')
            return
          }
          await access.reauthorizeAccount(ref, result)
          await input.afterChange()
          invocation.notify('Account reauthorized.', 'info')
        } catch {
          if (!disposed)
            invocation.notify('The account could not be reauthorized.', 'error')
        }
      })()
      continuations.add(continuation)
      void continuation.then(
        () => continuations.delete(continuation),
        () => continuations.delete(continuation),
      )
      return `Sign in with the browser to reauthorize this account:\n${authorization.url}\nWaiting for the browser…`
    },
    async dispose() {
      disposed = true
      shutdown.abort(new Error('The location is shutting down.'))
      const open = [...listeners]
      listeners.clear()
      const results = await Promise.allSettled(
        open.map((listener) => listener.close()),
      )
      while (continuations.size > 0)
        await Promise.allSettled([...continuations])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
  }
}

// ---------------------------------------------------------------------------
// Host auth slot (OpenCode 2)
// ---------------------------------------------------------------------------

/**
 * The parts of the host's integration API (`context.integration.connection`
 * in the OpenCode 2 plugin SDK) that read the active credential of one
 * integration. Declared without the SDK so this module stays SDK-free.
 */
export interface GaIntegrationConnections<C> {
  active(integrationID: string): Promise<C | undefined>
  resolve(connection: C): Promise<unknown>
}

/**
 * Reads the OpenCode 2 host's own sign-in for `integrationID` in the shape
 * the vault library classifies: an OAuth credential as
 * `{ type: 'oauth', refresh, access, expires }`, a key credential as
 * `{ type: 'api', key }`, and no active connection as `undefined` (empty).
 * An active connection whose credential cannot be resolved, or a credential
 * of another shape, rejects: custody is then refused, never decided on a
 * slot read as empty by mistake.
 */
export function createGaHostSlotReader<C>(
  connections: GaIntegrationConnections<C>,
  integrationID: string,
): () => Promise<unknown> {
  return async () => {
    const connection = await connections.active(integrationID)
    if (connection === undefined) return undefined
    const credential = await connections.resolve(connection)
    if (typeof credential !== 'object' || credential === null)
      throw new Error('The host sign-in could not be resolved')
    if (
      'type' in credential &&
      credential.type === 'oauth' &&
      'refresh' in credential &&
      typeof credential.refresh === 'string' &&
      'access' in credential &&
      typeof credential.access === 'string' &&
      'expires' in credential &&
      typeof credential.expires === 'number'
    )
      return {
        type: 'oauth',
        refresh: credential.refresh,
        access: credential.access,
        expires: credential.expires,
      }
    if (
      'type' in credential &&
      credential.type === 'key' &&
      'key' in credential &&
      typeof credential.key === 'string'
    )
      return { type: 'api', key: credential.key }
    throw new Error('The host sign-in has an unknown shape')
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
  readonly assertAdmission?: () => Promise<void>
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
  /**
   * The menu's manual quota check over this pipeline's accounts; absent
   * when the pipeline's custody has no such check.
   */
  readonly refreshQuota?: (
    refs: readonly RowRef[],
  ) => Promise<AntigravityQuotaCheckReport>
  /** Brings the routing accounts up to date with the account store. */
  refreshAccounts(): Promise<void>
  dispose(): Promise<void>
}

type GaStartInput = Parameters<GaLocationServices['start']>[0]

export interface GaLocationServicesBindings {
  /** The common-auth `./store` and `./fs` modules the repository is built on. */
  readonly loadStoreModules: () => Promise<
    AccountStoreModules & AccountMigrationModules
  >
  /** Resolve the shared pool; a new workspace must not create a separate account store. */
  readonly resolveAccountFile: (directory: string) => string
  /** A deferred start chooses its store only after local authority is checked. */
  readonly prepareAccountStore?: () => Promise<void>
  readonly now: () => number
  readonly createSelector?: () => string
  /** The location runtime's collaborators (sidebar file, quota, refresh). */
  readonly runtime: (input: {
    readonly directory: string
    readonly getRepository: () => Promise<AccountRepository>
    readonly assertAdmission: () => Promise<void>
    readonly overrides: GaPluginOverrides
  }) => GaRuntimeCollaborators
  /** Builds the shared request engine over the location's repository. */
  readonly createPipeline: (
    input: GaRequestPipelineInput,
  ) => Promise<GaRequestPipeline>
  /**
   * The location's vault custody, for the account file the location
   * resolves. Without it the location serves its local account store only.
   */
  readonly custody?: (input: {
    readonly accountFile: string
    readonly overrides: GaPluginOverrides
  }) => GaLocationCustody
  /**
   * One vault account's quota check through the vault (the shared vault
   * quota helper). Without it a vault location offers no quota check.
   */
  readonly fetchVaultQuota?: (input: {
    readonly source: Pick<AntigravityVaultAccountSource, 'send' | 'attribution'>
    readonly ref: VaultRouteRef
    readonly signal: AbortSignal
    readonly logger: Pick<Logger, 'debug'>
    readonly transport?: NonNullable<GaPluginOverrides['quotaFetch']>
  }) => Promise<VaultQuotaAnswer>
}

/** The vault source operations a GA vault location uses. */
export type GaVaultCustodySource = VaultRequestSource &
  VaultStateSource &
  Pick<AntigravityVaultAccountSource, 'send'>

/** The vault custody operations a GA location uses. */
export interface GaLocationCustody
  extends Pick<
    OpenCodeVaultCustody,
    'readMode' | 'menuSection' | 'dispose' | 'readState'
  > {
  startObservation?(): Promise<void>
  /** The enrollment name a request's no-account message names; see `OpenCodeVaultCustody`. */
  grantPrincipal?(): string
  custodySource(): Promise<GaVaultCustodySource>
  /** See `OpenCodeVaultCustody.recycleStalledSource`. */
  recycleStalledSource?(maxMs: number): Promise<boolean>
  /**
   * The source custody serves now, without I/O. Vault services built over
   * another source are rebuilt, since custody has replaced that one.
   */
  currentSource?(): unknown
  /**
   * The started location's background vault quota settings. Custody forgets
   * them when this location's custody is disposed.
   */
  pollVaultQuota?(settings: GaVaultQuotaPolling): void
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
 * Opens the account store published by initialization or migration. Management
 * may open that store to recover an unfinished account clear or replacement;
 * serving requires a separate `assertServingAdmission` check before using
 * credentials. Activation never initializes or migrates storage. An explicit
 * pool login may initialize a fresh store, but cannot resume a migration.
 */
async function openLocationRepository(
  directory: string,
  bindings: GaLocationServicesBindings,
  overrides: GaPluginOverrides,
  login?: { readonly admit: () => Promise<void> },
): Promise<LocationRepository> {
  await bindings.prepareAccountStore?.()
  const legacyPath = bindings.resolveAccountFile(directory)
  const modules = await bindings.loadStoreModules()
  await login?.admit()
  let binding = await readAccountStoreBinding(legacyPath, modules, bindings.now)
  await login?.admit()
  if (login && binding.status === 'initialization-required') {
    await initializeFreshAccountStoreFor(modules, {
      legacyPath,
      now: bindings.now,
    })
    await login.admit()
    binding = await readAccountStoreBinding(legacyPath, modules, bindings.now)
    await login.admit()
  }
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
    /** Supplies the manager's account rows and current credential checks. */
    readonly repository: Pick<AccountRepository, 'read'>
    readonly overrides: GaPluginOverrides
    readonly refreshQuotaAfterSuccess?: LocalRequestCredentials<ManagedAccount>['refreshQuotaAfterSuccess']
  },
): LocalRequestCredentials<ManagedAccount> {
  const local = createLocalAccountCredentials(manager, {
    repository: options.repository,
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
    // Checking and resolution use the captured row ID, epoch and identity,
    // never whichever replacement the account object might later refer to.
    captureGrant: (grant) => local.captureGrant(grant),
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
  | { readonly status: 'skipped'; readonly reason: 'refresh-needed' }
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
 * checked on its successor. Required checks refresh an expired token through
 * the repository. Explicit advisory checks skip instead of owning credential writes.
 */
export async function authorizeGaQuotaCheck(
  repository: Pick<AccountRepository, 'read' | 'refresh'>,
  target: GaQuotaTarget,
  now: () => number,
  purpose: QuotaCheckPurpose = 'required',
): Promise<GaQuotaAuthorization> {
  const ref = target.rowRef
  if (ref === undefined) return { status: 'refused', reason: 'unattributed' }
  const read = await repository.read()
  if (read.status !== 'ready') return { status: 'refused', reason: 'not-ready' }
  const row = read.rows.find((candidate) => sameRowRef(candidate.ref, ref))
  if (
    row === undefined ||
    row.credential === undefined ||
    !row.enabled ||
    !row.usable ||
    row.metadata.status !== 'present'
  )
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
  if (purpose === 'advisory')
    return { status: 'skipped', reason: 'refresh-needed' }
  const outcome = await repository.refresh(ref)
  if (outcome.status !== 'rotated')
    return { status: 'refused', reason: 'refresh-refused' }
  const after = await repository.read()
  const successor =
    after.status === 'ready'
      ? after.rows.find((candidate) => sameRowRef(candidate.ref, outcome.ref))
      : undefined
  if (
    successor?.credential === undefined ||
    !successor.enabled ||
    !successor.usable ||
    successor.metadata.status !== 'present'
  )
    return { status: 'refused', reason: 'stale' }
  return {
    status: 'authorized',
    ref: outcome.ref,
    auth: {
      type: 'oauth',
      refresh: formatRefreshParts({
        refreshToken: successor.credential.refreshToken,
        ...(successor.metadata.metadata.projectId
          ? { projectId: successor.metadata.metadata.projectId }
          : {}),
        ...(successor.metadata.metadata.managedProjectId
          ? { managedProjectId: successor.metadata.metadata.managedProjectId }
          : {}),
      }),
      access: outcome.accessToken,
      expires: outcome.expiresAt,
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
  readonly assertAdmission?: () => Promise<void>
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
    async authorize(account, _signal, purpose = 'required') {
      // Captured before any await: the ref of exactly this target.
      const rowRef = rowRefOfTarget(account)
      await options.assertAdmission?.()
      const authorization = await authorizeGaQuotaCheck(
        options.repository,
        { rowRef },
        options.now,
        purpose,
      )
      if (authorization.status !== 'authorized') return authorization
      const ref = authorization.ref
      const accessToken = authorization.auth.access ?? ''
      await options.assertAdmission?.()
      const storedProjects = parseRefreshParts(authorization.auth.refresh)
      const storedProject =
        storedProjects.managedProjectId ?? storedProjects.projectId
      if (purpose === 'advisory' && !storedProject)
        return { status: 'skipped', reason: 'project-needed' }
      const project =
        purpose === 'advisory'
          ? {
              auth: authorization.auth,
              effectiveProjectId: storedProject ?? '',
            }
          : await ensureProject(authorization.auth)
      await options.assertAdmission?.()
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
          await options.assertAdmission?.()
          const read = await options.repository.read()
          const row =
            read.status === 'ready'
              ? read.rows.find((candidate) => sameRowRef(candidate.ref, ref))
              : undefined
          if (
            row === undefined ||
            !row.enabled ||
            !row.usable ||
            row.metadata.status !== 'present'
          )
            return { status: 'stale', reason: 'credential changed' }
          if (row.credential?.accessToken !== accessToken)
            return { status: 'stale', reason: 'access token changed' }
          await options.assertAdmission?.()
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
  overrides: Pick<GaPluginOverrides, 'send'> = {},
): GaJobExecutor {
  const send = overrides.send
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
        kind: job.kind,
        variant: job.variant ?? undefined,
        ...(context.onResponseHandoff
          ? { onResponseHandoff: context.onResponseHandoff }
          : {}),
        session: {
          sessionId: job.sessionID,
          parentSessionId: job.parentSessionID,
        },
        ...(send
          ? {
              transport: async (url, init, options) => {
                const signal = options?.signal
                const authorization = new Headers(init?.headers).get(
                  'authorization',
                )
                if (
                  typeof init?.body !== 'string' ||
                  !authorization?.startsWith('Bearer ') ||
                  !signal
                ) {
                  throw new Error('The prepared Antigravity send is incomplete')
                }
                // The engine has prepared the body and bearer for this send,
                // whether it is a warmup probe or the main request.
                signal.throwIfAborted()
                return send({
                  envelope: JSON.parse(init.body),
                  auth: { access: authorization.slice('Bearer '.length) },
                  endpoint: new URL(url).origin,
                  signal,
                  kind: job.kind,
                })
              },
            }
          : {}),
      },
    )
}

/**
 * The shared request engine's collaborators that do not depend on where the
 * accounts' credentials live: this location's config, session registry,
 * operator settings, wire, debug log, dump switch and route book, and the
 * AGY transport with the GA raw sender's idle timeout and signal observer.
 */
function gaEngineCollaborators(input: {
  readonly runtime: GaStartInput['runtime']
  readonly overrides: GaPluginOverrides
  readonly routes: GaRouteBook
  readonly logger: Logger
}) {
  const runtime = input.runtime
  const observe = input.overrides.observeRawSenderSignal
  return {
    config: runtime.config.config,
    sessions: new AgySessionRegistry(runtime.directory),
    operatorSettings: runtime.operatorSettings,
    transport: (
      url: string,
      init?: RequestInit,
      options?: Parameters<typeof fetchWithAgyCliTransport>[2],
    ) => {
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
    wire: {
      prepare: prepareAntigravityRequest,
      transformResponse: transformAntigravityResponse,
      buildThinkingWarmupBody,
      getImageModelLocalTitle,
      getLastCacheStats,
    },
    debug: runtime.debug,
    dump: runtime.dump,
    logger: input.logger,
    classifyAccessError: extractAccountAccessErrorDetails,
    onRouting: (sessionId: string, entry: RequestRoutingEntry) =>
      input.routes.record(sessionId, entry),
  }
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
  await input.assertAdmission?.()
  const logger = runtime.logger.createLogger('request')
  const advisory = createAdvisoryRepositoryOwner(input.repository, logger)
  const manager = await loadAccountManagerFromRepository(advisory.repository, {
    onWriteError: advisory.owns,
  })
  input.accounts.current = manager
  input.accounts.quotaLogger = runtime.logger.createLogger('quota')
  await runtime.replaceAccounts(manager)
  const executor = createRequestExecutor({
    ...gaEngineCollaborators({
      runtime,
      overrides: input.overrides,
      routes: input.routes,
      logger,
    }),
    accounts: manager,
    ...(input.assertAdmission
      ? { assertAdmission: input.assertAdmission }
      : {}),
    credentials: createGaLocalCredentials(manager, {
      repository: input.repository,
      overrides: input.overrides,
      refreshQuotaAfterSuccess: createLocalQuotaRefresh(
        manager,
        runtime.quotaManager,
        logger,
      ),
    }),
    // The trackers the manager selects with, so recorded outcomes steer
    // the next selection.
    trackers: {
      health: manager.healthTracker,
      token: manager.tokenTracker,
    },
  })
  // Local custody: the same store quota service the OpenCode 1 menu uses,
  // over this activation's manager and repository.
  const quotaFetch = input.overrides.quotaFetch
  const storeQuota = createStoreQuotaService({
    manager,
    repository: input.repository,
    ...(input.assertAdmission
      ? {
          mayRun: async () => {
            await input.assertAdmission?.()
            return true
          },
        }
      : {}),
    logger: runtime.logger.createLogger('store-quota'),
    ...(quotaFetch ? { transport: () => quotaFetch } : {}),
  })
  return {
    execute: createGaJobExecutor(executor, input.overrides),
    refreshQuota: (refs) => storeQuota.checkStoreQuota(refs),
    refreshAccounts: () => manager.refreshFromRepository(),
    async dispose() {
      await executor.dispose()
      await storeQuota.dispose()
      await advisory.drain()
      if (input.accounts.current === manager) {
        input.accounts.current = null
        input.accounts.quotaLogger = null
      }
      await runtime.replaceAccounts(null)
      await manager.dispose()
    },
  }
}

/**
 * The shared request engine for a location whose accounts are held by the
 * vault. Selection runs on the shared `AccountSelector` over the vault's
 * selectable routes (metadata rows, no credential); every physical send
 * takes a fresh receipt for the selected route through
 * `createVaultRequestCredentials`. Nothing is refreshed or cached locally.
 * `refreshAccounts` re-reads the vault roster and keeps each route's
 * selection state while its route, credential and asserted account stay
 * the same. With `state`, a route's selection state is restored from and
 * saved to the vault's provider-state file, attributed to the receipt that
 * last served it.
 */
export async function createGaVaultRequestPipeline(input: {
  readonly assertAdmission?: () => Promise<void>
  readonly pool: VaultAccountPool
  readonly runtime: GaStartInput['runtime']
  readonly overrides: GaPluginOverrides
  readonly routes: GaRouteBook
}): Promise<GaRequestPipeline & { rows(): readonly VaultAccountRow[] }> {
  const { pool } = input
  await input.assertAdmission?.()
  await pool.sync()
  const logger = input.runtime.logger.createLogger('request')
  const executor = createRequestExecutor<VaultAccountRow>({
    ...gaEngineCollaborators({
      runtime: input.runtime,
      overrides: input.overrides,
      routes: input.routes,
      logger,
    }),
    accounts: pool.selector,
    ...(input.assertAdmission
      ? { assertAdmission: input.assertAdmission }
      : {}),
    credentials: pool.credentials,
    trackers: {
      health: pool.selector.healthTracker,
      token: pool.selector.tokenTracker,
    },
  })
  return {
    execute: async (job, context) => {
      await input.assertAdmission?.()
      await pool.sync()
      return createGaJobExecutor(executor, input.overrides)(job, context)
    },
    rows: () => pool.selector.rows,
    refreshAccounts: async () => {
      await input.assertAdmission?.()
      await pool.refresh()
    },
    async dispose() {
      await executor.dispose()
      await pool.flush()
    },
  }
}

// ---------------------------------------------------------------------------
// Vault custody location
// ---------------------------------------------------------------------------

/**
 * Opaque item and state selectors for vault routes, one per route,
 * credential and asserted account for the life of the activation.
 */
function vaultSelectors(createSelector: () => string) {
  const byKey = new Map<string, string>()
  return (row: VaultAccountRow): string => {
    const key = vaultAccountRowKey(row)
    let selector = byKey.get(key)
    if (selector === undefined) {
      selector = createSelector()
      byKey.set(key, selector)
    }
    return selector
  }
}

/**
 * The `state` source of a vault custody location: the vault's selectable
 * accounts as redaction rows with opaque selectors, read one at a time.
 * Vault rows carry no metadata or access blocks of this plugin's own.
 */
function createGaVaultStateSource(input: {
  /** The pipeline's current selection rows. */
  readonly rows: () => readonly VaultAccountRow[]
  /**
   * The vault's stored provider state. Read on each state read, so quota
   * recorded after a row was listed (by any process) reaches that row.
   */
  readonly readState?: () => Promise<VaultProviderStateFile>
  readonly selectorOf: (row: VaultAccountRow) => string
  readonly nextReadSeq?: () => number
  readonly generation: string
  readonly settings: () => AntigravitySettingsDto
  readonly route: (scope: AntigravityRpcScope) => SidebarRoutingEntry | null
  readonly observe?: ObserveAccountSnapshot
}): GaStateSource {
  let readSeq = 0
  let queue: Promise<unknown> = Promise.resolve()
  const readOnce = async (scope: AntigravityRpcScope, signal: AbortSignal) => {
    if (signal.aborted) throw abortError(signal)
    // An unreadable state file leaves each row with the quota it was listed with.
    const stored = await input.readState?.().catch(() => undefined)
    if (signal.aborted) throw abortError(signal)
    const rows = input.rows()
    const settings = input.settings()
    const route = input.route(scope)
    if (signal.aborted) throw abortError(signal)
    readSeq = input.nextReadSeq?.() ?? readSeq + 1
    const overLimit = rows.length > ACCOUNT_LIMIT
    // Each row's quota travels with the time that same reading was taken.
    // A stored reading for the row's current route and credential wins over
    // the quota the row was listed with; a reading without a time stays
    // undated rather than borrowing the listed quota's time.
    const quotaOf = (
      row: VaultAccountRow,
    ): Pick<
      SidebarAccountRedactionInput,
      'cachedQuota' | 'cachedQuotaUpdatedAt'
    > => {
      const reading = stored
        ? quotaReadingForVaultRoute(row.route, stored)
        : undefined
      const storedQuota = reading ? cachedQuotaOf(reading) : undefined
      const [cachedQuota, updatedAt] =
        storedQuota !== undefined
          ? [storedQuota, reading?.cachedQuotaUpdatedAt]
          : [row.cachedQuota, row.cachedQuotaUpdatedAt]
      if (cachedQuota === undefined) return {}
      const at = readingTime(updatedAt)
      return {
        cachedQuota,
        ...(at !== null ? { cachedQuotaUpdatedAt: at } : {}),
      }
    }
    const quotas = rows.map(quotaOf)
    const answer: GaStateRead = {
      readSeq,
      accounts: overLimit
        ? { kind: 'over-limit', count: rows.length }
        : {
            kind: 'complete',
            rows: rows.map((row, position) => ({
              selector: input.selectorOf(row),
              row: {
                index: position,
                enabled: row.enabled,
                current: false,
                ...(row.coolingDownUntil !== undefined
                  ? { coolingDownUntil: row.coolingDownUntil }
                  : {}),
                ...quotas[position],
              },
            })),
          },
      route,
      status: {
        checkedAt: newestReadingTime(
          quotas.map((quota) => quota.cachedQuotaUpdatedAt),
        ),
        quotaBackoffUntil: null,
        routingAuthoritative: true,
      },
      settings,
    }
    if (input.observe) {
      try {
        input.observe({
          generation: input.generation,
          readSeq,
          status: 'ready',
          accountsStatus: overLimit ? 'over-limit' : 'complete',
          accounts: overLimit
            ? []
            : rows.map((row, position) => ({
                selector: input.selectorOf(row),
                position,
                enabled: row.enabled,
                usable: row.enabled,
                metadataStatus: 'absent',
                accessBlock: { kind: 'unknown' },
                currentFor: [],
                cooldownUntil: row.coolingDownUntil ?? null,
              })),
          retiredSelectors: [],
        })
      } catch {
        // A diagnostic observer cannot change the answer.
      }
    }
    return answer
  }
  return {
    read({ scope, signal }) {
      const next = queue.then(
        () => readOnce(scope, signal),
        () => readOnce(scope, signal),
      )
      queue = next.catch(() => undefined)
      return next
    },
  }
}

/**
 * A GA location whose accounts are held by the vault. No local account
 * store is opened. Saved Google logins stay dormant on disk. The vault
 * source is taken from custody, and requests go through
 * `createGaVaultRequestPipeline`, and the menu shows the vault's accounts,
 * this location's settings and the Vault section. The runtime keeps quota
 * snapshots in memory; it gets no account view, so its quota poller and
 * token refresh queue do not run for vault accounts.
 */
async function createGaVaultLocationServices(input: {
  readonly afterApply?: () => Promise<void>
  readonly bindRefresh?: (refresh: (() => Promise<void>) | undefined) => void
  readonly nextReadSeq?: () => number
  readonly assertAdmission?: () => Promise<void>
  readonly custody: GaLocationCustody
  readonly overrides: GaPluginOverrides
  readonly bindings: Pick<
    GaLocationServicesBindings,
    'createSelector' | 'fetchVaultQuota'
  >
}): Promise<GaLocationServices & { readonly source: GaVaultCustodySource }> {
  const { custody, overrides } = input
  await input.assertAdmission?.()
  const source = await custody.custodySource()
  const selectorOf = vaultSelectors(
    input.bindings.createSelector ?? defaultSelector,
  )
  let pipeline: Awaited<
    ReturnType<typeof createGaVaultRequestPipeline>
  > | null = null
  let disposed: Promise<void> | null = null
  return {
    source,
    runtime: {
      quotaSnapshots: createMemoryQuotaSnapshots(),
      // Never called: the runtime is given no account view for vault rows,
      // so neither its quota poller nor its refresh queue runs.
      fetchAccountQuota: async (account) => ({
        index: 0,
        email: account.email,
        status: 'error',
        disabled: false,
        error: 'vault accounts are not checked by this location',
      }),
      refreshToken: async () => undefined,
    },
    async start(start) {
      if (disposed) throw new Error('The location services are disposed')
      const location = start.runtime
      const routes = createGaRouteBook()
      const vaultLogger = location.logger.createLogger('vault-state')
      const pool = createOpenCodeVaultAccountPool({
        source,
        durable: {
          source,
          readState: () => custody.readState(),
          onError: (error) =>
            vaultLogger.debug('vault-state-write-dropped', {
              error: error instanceof Error ? error.name : 'unknown',
            }),
        },
        grantPrincipal: () => custody.grantPrincipal?.(),
      })
      pipeline = await createGaVaultRequestPipeline({
        ...(input.assertAdmission
          ? { assertAdmission: input.assertAdmission }
          : {}),
        pool,
        runtime: location,
        overrides,
        routes,
      })
      const fetchVaultQuota = input.bindings.fetchVaultQuota
      const quotaLogger = location.logger.createLogger('vault-quota')
      const checkQuota = fetchVaultQuota
        ? (signal: AbortSignal) =>
            checkVaultQuota({
              pool,
              fetchReading: async (ref, check) => {
                await input.assertAdmission?.()
                return fetchVaultQuota({
                  source,
                  ref,
                  signal: check,
                  logger: quotaLogger,
                  ...(overrides.quotaFetch
                    ? { transport: overrides.quotaFetch }
                    : {}),
                })
              },
              signal,
              onError: (error) =>
                quotaLogger.debug('vault-quota-not-recorded', {
                  error: error instanceof Error ? error.name : 'unknown',
                }),
            })
        : undefined
      const started = pipeline
      const settings = operatorMenuSettings(
        location.operatorSettings,
        () => 'vault',
      )
      const menu = createAntigravityCommandMenu({
        source: 'sections',
        commands: await loadCommonAuthCommands(),
        sections: {
          ...createVaultAccountMenuSections(pool, selectorOf, checkQuota),
          ...antigravitySettingsSections(settings),
        },
        diagnostics: diagnosticsMenuSection({
          settings: location.operatorSettings,
          dump: location.dump,
          applyLogLevel: () => location.applyOperatorSettings(),
        }),
        extras: [custody.menuSection()],
      })
      input.bindRefresh?.(() => started.refreshAccounts())
      return {
        execute: started.execute,
        state: createGaVaultStateSource({
          rows: () => started.rows(),
          readState: () => custody.readState(),
          selectorOf,
          ...(input.nextReadSeq ? { nextReadSeq: input.nextReadSeq } : {}),
          generation: start.generation,
          settings: () =>
            gaSettingsOf(
              location.operatorSettings.get(),
              location.dump,
              'vault',
            ),
          route: (scope) => routes.route(scope),
          ...(overrides.observeAccountSnapshot
            ? { observe: overrides.observeAccountSnapshot }
            : {}),
        }),
        commands: createGaMenuCommandService({
          menu,
          notify: start.notify,
          afterApply: () =>
            input.afterApply ? input.afterApply() : started.refreshAccounts(),
        }),
      }
    },
    dispose() {
      disposed ??= (async () => {
        const active = pipeline
        pipeline = null
        input.bindRefresh?.(undefined)
        if (active) await active.dispose()
      })()
      return disposed
    },
  }
}

export function createGaLocationServicesFactory(
  bindings: GaLocationServicesBindings,
): GaLocationServicesFactory {
  return async ({ directory, overrides }): Promise<GaLocationServices> => {
    const custody = bindings.custody?.({
      accountFile: bindings.resolveAccountFile(directory),
      overrides,
    })
    type Serving = Awaited<ReturnType<GaLocationServices['start']>>
    let closing = false
    let started = false
    let disposal: Promise<void> | undefined
    // Enrollment selects a binding, not its lifetime. Local files stay unopened
    // until a locally authorized operation needs them, and failures can retry.
    let repositoryPromise: Promise<LocationRepository> | undefined
    let servingRepository: AccountRepository | undefined
    let localPromise: Promise<Serving> | undefined
    let vaultPromise: Promise<Serving> | undefined
    let vaultServices: GaLocationServices | undefined
    // The custody source `vaultServices` was built over.
    let vaultSource: unknown
    // The disposal of vault services retired because their source was replaced.
    let retiredVault: Promise<void> | undefined
    let localPipeline: GaRequestPipeline | undefined
    let reauthorize: ReturnType<typeof createGaReauthorize> | undefined
    let readSeq = 0
    const inFlight = new Set<Promise<unknown>>()
    const run = <T>(work: () => Promise<T>): Promise<T> => {
      if (closing)
        return Promise.reject(new Error('The location services are disposed'))
      const pending = Promise.resolve().then(work)
      inFlight.add(pending)
      void pending.then(
        () => inFlight.delete(pending),
        () => inFlight.delete(pending),
      )
      return pending
    }
    const nextReadSeq = () => ++readSeq
    const registry = createGaSelectorRegistry(bindings.createSelector)
    // Why no account source may serve, from the last mode read: custody's
    // own reason when it cannot read the mode (an unsettled vault folder
    // names its cause and what to do there, with no enrollment advice),
    // else the vault remedy.
    let unavailableReason = VAULT_ACCOUNT_REMEDY
    const authority = async (): Promise<'local' | 'vault' | 'unreadable'> => {
      if (!custody) return 'local'
      const mode = await custody.readMode()
      unavailableReason = mode.ok ? VAULT_ACCOUNT_REMEDY : mode.reason
      return mode.ok
        ? mode.record.mode === 'custody'
          ? 'vault'
          : 'local'
        : 'unreadable'
    }
    const assertLocal = async () => {
      if (closing) throw new Error('The location services are disposed')
      const selected = await authority()
      if (closing) throw new Error('The location services are disposed')
      if (selected !== 'local') throw new Error(unavailableReason)
    }
    let refreshVaultBinding: (() => Promise<void>) | undefined
    const refreshSelectedSource = async (): Promise<void> => {
      const selected = await authority()
      if (closing) throw new Error('The location services are disposed')
      if (selected === 'unreadable') throw new Error(unavailableReason)
      // A menu action may change sources. Refresh only the newly selected
      // account view, keeping both runtime bindings and their generation intact.
      if (selected === 'local') {
        await assertLocal()
        await localPipeline?.refreshAccounts()
      } else {
        if (vaultPromise) await vaultPromise
        await refreshVaultBinding?.()
      }
    }
    const getRepository = async (login?: {
      readonly admit: () => Promise<void>
    }): Promise<AccountRepository> => {
      await assertLocal()
      repositoryPromise ??= openLocationRepository(
        directory,
        bindings,
        overrides,
        login,
      ).catch((error) => {
        repositoryPromise = undefined
        throw error
      })
      const repository = (await repositoryPromise).repository
      if (!servingRepository) {
        const methods = new Map<PropertyKey, unknown>()
        const pendingAdmissions = new Set<Promise<unknown>>()
        const refusedWrites: unknown[] = []
        servingRepository = new Proxy(repository, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target)
            if (typeof value !== 'function') return value
            if (!methods.has(key)) {
              methods.set(key, (...args: unknown[]) => {
                if (key === 'flush' || key === 'settled' || key === 'dispose') {
                  return (async () => {
                    // Calls still awaiting the local-source check have not entered
                    // the repository's queue. Wait for them before flushing it.
                    await Promise.allSettled([...pendingAdmissions])
                    const result: unknown = await Reflect.apply(
                      value,
                      target,
                      args,
                    )
                    if (key !== 'settled' && refusedWrites.length > 0) {
                      const failures = refusedWrites.splice(0)
                      throw new AggregateError(
                        failures,
                        'Local writes were refused by source authority',
                        { cause: result },
                      )
                    }
                    return result
                  })()
                }
                const pending = (async () => {
                  // A refresh that passed the local-source check saves its new
                  // credentials inside this call. Later operations check again.
                  try {
                    await assertLocal()
                  } catch (error) {
                    if (key !== 'read') refusedWrites.push(error)
                    throw error
                  }
                  return Reflect.apply(value, target, args)
                })()
                pendingAdmissions.add(pending)
                void pending.then(
                  () => pendingAdmissions.delete(pending),
                  () => pendingAdmissions.delete(pending),
                )
                return pending
              })
            }
            return methods.get(key)
          },
        })
      }
      return servingRepository
    }
    let runtime: GaRuntimeCollaborators
    try {
      const collaborators = bindings.runtime({
        directory,
        getRepository,
        assertAdmission: assertLocal,
        overrides,
      })
      const previousMayRun = collaborators.mayRun
      runtime = {
        ...collaborators,
        mayRun: async () =>
          !closing &&
          (await authority()) === 'local' &&
          (!previousMayRun || (await previousMayRun())),
      }
      await custody?.startObservation?.()
    } catch (error) {
      await custody?.dispose().catch(() => {})
      throw error
    }
    return {
      runtime,
      localLogin: {
        assertAdmission: assertLocal,
        async persist(result, admit) {
          await assertLocal()
          await admit()
          const repository = await getRepository({ admit })
          await admit()
          const opened = await repositoryPromise
          await admit()
          if (!opened)
            throw new Error('The local repository was not constructed')
          await assertServingAdmission(opened, bindings.now)
          await admit()
          const committed = await commitLogins(repository, [result])
          await admit()
          if (committed.length !== 1 || committed[0]?.status !== 'committed')
            throw new Error(
              'The Antigravity pool login could not be completed.',
            )
          await localPipeline?.refreshAccounts()
          await admit()
        },
      },
      async start(input) {
        if (closing) throw new Error('The location services are disposed')
        if (started) throw new Error('The location services already started')
        started = true
        const location = input.runtime
        // The process's one background vault quota producer follows the
        // settings of the started locations sharing this custody.
        custody?.pollVaultQuota?.({
          enabled: location.config.config.background_quota_refresh,
          intervalMinutes:
            location.config.config.background_quota_refresh_interval_minutes,
          logger: location.logger.createLogger('vault-quota'),
        })
        const settings = operatorMenuSettings(
          location.operatorSettings,
          () => location.config.config.account_selection_strategy,
        )
        const recoveryMenu = createAntigravityCommandMenu({
          source: 'sections',
          commands: await loadCommonAuthCommands(),
          sections: {
            accounts: {
              title: 'Accounts',
              build: async () => {
                await authority().catch(() => {})
                return {
                  lines: [
                    unavailableReason === VAULT_ACCOUNT_REMEDY
                      ? 'Account access is unavailable. Open Vault to inspect or recover enrollment.'
                      : unavailableReason,
                  ],
                  items: [],
                  actions: [],
                }
              },
            },
            quota: {
              title: 'Quota',
              build: async () => ({
                lines: ['No quota reading is available.'],
                items: [],
                actions: [],
              }),
            },
            ...antigravitySettingsSections(settings),
          },
          diagnostics: diagnosticsMenuSection({
            settings: location.operatorSettings,
            dump: location.dump,
            applyLogLevel: () => location.applyOperatorSettings(),
          }),
          ...(custody ? { extras: [custody.menuSection()] } : {}),
        })
        const recovery: Serving = {
          execute: async () => {
            throw new Error(unavailableReason)
          },
          state: {
            read: async ({ signal }) => {
              if (signal.aborted) throw abortError(signal)
              return {
                readSeq: nextReadSeq(),
                accounts: { kind: 'complete', rows: [] },
                route: null,
                status: {
                  checkedAt: null,
                  quotaBackoffUntil: null,
                  routingAuthoritative: false,
                },
                settings: gaSettingsOf(
                  location.operatorSettings.get(),
                  location.dump,
                  location.config.config.account_selection_strategy,
                ),
              }
            },
          },
          commands: createGaMenuCommandService({
            menu: recoveryMenu,
            notify: input.notify,
          }),
        }
        const local = (): Promise<Serving> => {
          localPromise ??= (async () => {
            const repository = await getRepository()
            const opened = await repositoryPromise
            if (!opened)
              throw new Error('The local repository was not constructed')
            await assertServingAdmission(opened, bindings.now)
            await assertLocal()
            let pipeline: GaRequestPipeline | undefined
            let pendingReauthorization:
              | ReturnType<typeof createGaReauthorize>
              | undefined
            try {
              const routes = createGaRouteBook()
              pipeline = await bindings.createPipeline({
                repository,
                runtime: location,
                send: input.send,
                generation: input.generation,
                overrides,
                routes,
                assertAdmission: assertLocal,
              })
              const started = pipeline
              const refreshAccounts = async () => {
                await assertLocal()
                await started.refreshAccounts()
              }
              pendingReauthorization = createGaReauthorize({
                repository,
                assertAdmission: assertLocal,
                overrides,
                afterChange: refreshAccounts,
              })
              const checkQuota = started.refreshQuota
              const menu = createGaLocationMenu({
                commands: await loadCommonAuthCommands(),
                repository,
                runtime: location,
                reauthorize: pendingReauthorization,
                ...(custody ? { vault: custody.menuSection() } : {}),
                ...(checkQuota
                  ? {
                      refreshQuota: async (refs) => {
                        await assertLocal()
                        return checkQuota(refs)
                      },
                    }
                  : {}),
              })
              localPipeline = started
              reauthorize = pendingReauthorization
              return {
                state: createGaAccountStateSource({
                  repository,
                  registry,
                  generation: input.generation,
                  nextReadSeq,
                  settings: () =>
                    gaSettingsOf(
                      location.operatorSettings.get(),
                      location.dump,
                      location.config.config.account_selection_strategy,
                    ),
                  status: () => ({
                    checkedAt: null,
                    quotaBackoffUntil: null,
                    routingAuthoritative: true,
                  }),
                  route: (scope) => routes.route(scope),
                  ...(overrides.observeAccountSnapshot
                    ? { observe: overrides.observeAccountSnapshot }
                    : {}),
                }),
                commands: createGaMenuCommandService({
                  menu,
                  notify: input.notify,
                  afterApply: () => refreshSelectedSource(),
                }),
                execute: started.execute,
              }
            } catch (error) {
              await pendingReauthorization?.dispose().catch(() => {})
              await pipeline?.dispose().catch(() => {})
              await location.replaceAccounts(null).catch(() => {})
              throw error
            }
          })().catch((error) => {
            localPromise = undefined
            throw error
          })
          return localPromise
        }
        const vault = (): Promise<Serving> => {
          if (!custody)
            return Promise.reject(new Error('Vault custody is unavailable'))
          // Custody replaces a source whose refresh stalled, possibly while
          // another location sharing it waited. Services built over the old
          // source would serve nothing, so they are rebuilt over the new one.
          if (
            vaultServices &&
            custody.currentSource &&
            custody.currentSource() !== vaultSource
          ) {
            const stale = vaultServices
            vaultServices = undefined
            vaultSource = undefined
            vaultPromise = undefined
            retiredVault = stale.dispose().catch(() => {})
          }
          vaultPromise ??= (async () => {
            await retiredVault
            const created = await createGaVaultLocationServices({
              custody,
              overrides,
              bindings,
              nextReadSeq,
              afterApply: refreshSelectedSource,
              bindRefresh: (refresh) => {
                refreshVaultBinding = refresh
              },
              assertAdmission: async () => {
                const selected = await authority()
                if (closing || selected !== 'vault')
                  throw new Error(unavailableReason)
              },
            })
            try {
              const serving = await created.start(input)
              vaultServices = created
              vaultSource = created.source
              return serving
            } catch (error) {
              await created.dispose().catch(() => {})
              throw error
            }
          })().catch(async (error) => {
            // A first roster read that timed out may be waiting on a vault
            // refresh that never settles. Once it has waited past the stall
            // bound, custody replaces that source, so a later request
            // connects again instead of joining the stalled refresh.
            await custody
              .recycleStalledSource?.(VAULT_REFRESH_STALL_MS)
              .catch(() => false)
            vaultPromise = undefined
            throw error
          })
          return vaultPromise
        }
        /**
         * Picks the services for the current account authority. A caller that
         * has just read the authority passes it in, so it is not read again.
         */
        const choose = async (
          purpose: 'execute' | 'view',
          known?: 'local' | 'vault' | 'unreadable',
        ): Promise<Serving> => {
          if (closing) throw new Error('The location services are disposed')
          const selected = known ?? (await authority())
          if (closing) throw new Error('The location services are disposed')
          if (selected === 'local') return local()
          if (selected === 'unreadable') {
            if (purpose === 'execute') throw new Error(unavailableReason)
            return recovery
          }
          try {
            return await vault()
          } catch (error) {
            if (purpose === 'execute') throw error
            return recovery
          }
        }
        let reads: Promise<unknown> = Promise.resolve()
        return {
          execute: (job, context) =>
            run(async () => {
              if (context.signal.aborted) throw context.signal.reason
              if (closing) throw new Error('The location services are disposed')
              // The shared engine replaces retired title models before checking
              // retirement; leave that routing ahead of this early rejection.
              if (job.kind !== 'title') {
                const retired = retiredModelResponse(job.url)
                if (retired) return retired
              }
              return (await choose('execute')).execute(job, context)
            }),
          commands: {
            apply: (request) =>
              run(async () => {
                if (request.signal.aborted) throw request.signal.reason
                return (await choose('view')).commands.apply(request)
              }),
            open: (request) =>
              run(async () => {
                if (request.signal.aborted) throw request.signal.reason
                return (await choose('view')).commands.open(request)
              }),
          },
          state: {
            read(request) {
              return run(() => {
                const pending = reads.then(async () => {
                  if (closing)
                    throw new Error('The location services are disposed')
                  if (request.signal.aborted) throw request.signal.reason
                  for (let attempt = 0; attempt < 2; attempt++) {
                    // The authority read before the state read also selects
                    // the services; the read after it confirms nothing changed.
                    const before = await authority()
                    const answer = await (
                      await choose('view', before)
                    ).state.read(request)
                    if (before === (await authority())) return answer
                  }
                  throw new Error(
                    'Account authority changed while reading state',
                  )
                })
                reads = pending.catch(() => undefined)
                return pending
              })
            },
          },
        }
      },
      dispose() {
        closing = true
        disposal ??= (async () => {
          await Promise.allSettled([
            localPromise,
            vaultPromise,
            retiredVault,
            repositoryPromise,
          ])
          try {
            const resources = Promise.allSettled([
              reauthorize?.dispose(),
              localPipeline?.dispose(),
              vaultServices?.dispose(),
            ])
            await Promise.allSettled([...inFlight])
            const results = await resources
            while (inFlight.size > 0) await Promise.allSettled([...inFlight])
            const failure = results.find(
              (result) => result.status === 'rejected',
            )
            if (failure?.status === 'rejected') throw failure.reason
          } finally {
            try {
              await custody?.dispose()
            } finally {
              const opened = await repositoryPromise?.catch(() => undefined)
              await opened?.repository.dispose()
            }
          }
        })()
        return disposal
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
  readonly assertAdmission?: () => Promise<void>
  readonly getRepository: () => Promise<AccountRepository>
  readonly overrides: GaPluginOverrides
  readonly accounts: GaAccountSlot
  readonly now: () => number
}): GaRuntimeCollaborators {
  return {
    quotaSnapshots: createMemoryQuotaSnapshots(),
    fetchAccountQuota: async (account, signal, purpose) => {
      const repository = await input.getRepository()
      return createGaFetchAccountQuota({
        repository,
        ...(input.assertAdmission
          ? { assertAdmission: input.assertAdmission }
          : {}),
        now: input.now,
        overrides: input.overrides,
        logger: {
          debug: (...args) => input.accounts.quotaLogger?.debug(...args),
        },
      })(account, signal, purpose)
    },
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

/** What the OpenCode 2 host supplies for vault custody of its locations. */
export interface GaVaultHost {
  /**
   * The host's own Google sign-in, read through its public integration API
   * (see `createGaHostSlotReader`); rejects when it cannot be read.
   */
  readonly readHostSlot: () => Promise<unknown>
  /**
   * The vault's connection file; defaults to the vault client library's
   * own resolution of it.
   */
  readonly connectionFile?: () => string | Promise<string>
  /**
   * Test seams of the shared custody: its vault client, library loader,
   * clock and observation interval. Production passes none.
   */
  readonly custody?: Pick<
    OpenCodeVaultCustodyOptions,
    'connect' | 'connectEnrollment' | 'loadClaustrum' | 'now' | 'pollIntervalMs'
  >
  /** Test seams of the shared background vault quota producer. */
  readonly quota?: GaVaultQuotaProducerOptions
}

/**
 * The production GA location services: the embedded common-auth store,
 * the system clock, the repository-backed request pipeline and the
 * collaborators above. Every activation gets its own repository, account
 * slot and pipeline. With `vault`, a location can also serve the vault's
 * accounts: each operation re-reads the enrollment files. An approved host
 * uses the vault; an unenrolled host uses its local store. Locations that
 * resolve the same vault folder share one vault custody and so one vault
 * connection at a time; custody replaces a source whose refresh stalled. The
 * shared background vault quota producer runs only while a started location
 * has background refresh on (`acquireGaVaultCustody`).
 */
export function createGaLocationServicesForHost(
  vault?: GaVaultHost,
): GaLocationServicesFactory {
  return (input) => {
    const accounts: GaAccountSlot = { current: null, quotaLogger: null }
    return createGaLocationServicesFactory({
      loadStoreModules: loadCommonAuthStoreModules,
      resolveAccountFile: getStoragePath,
      prepareAccountStore: prepareLocalAccountStore,
      now: Date.now,
      runtime: ({ getRepository, assertAdmission, overrides }) =>
        createGaRuntimeCollaborators({
          getRepository,
          assertAdmission,
          overrides,
          accounts,
          now: Date.now,
        }),
      createPipeline: (pipeline) =>
        createGaLocalRequestPipeline({ ...pipeline, accounts }),
      ...(vault
        ? {
            custody: ({ accountFile }) => {
              // The folder the activation settled before building services
              // (`setupGaActivation`), or why it could not.
              const folder = currentVaultFolder(accountFile)
              return acquireGaVaultCustody({
                vaultDir: folder.vaultDir,
                accountFile,
                ...(folder.refusal
                  ? { layoutRefusal: folder.refusal.message }
                  : {}),
                readHostSlot: vault.readHostSlot,
                create: ({
                  vaultDir,
                  accountFile: file,
                  layoutRefusal,
                  readHostSlot,
                }) =>
                  createOpenCodeVaultCustody({
                    ...vault.custody,
                    vaultDir,
                    accountFile: file,
                    ...(layoutRefusal === undefined ? {} : { layoutRefusal }),
                    readHostSlot,
                    ...(vault.connectionFile
                      ? { connectionFile: vault.connectionFile }
                      : {}),
                    // The engine reads each send's HTTP status itself.
                    reporterSource: 'direct',
                  }),
                ...(vault.quota ? { quota: vault.quota } : {}),
              })
            },
            fetchVaultQuota: fetchVaultAccountQuota,
          }
        : {}),
    })(input)
  }
}

/** The connection API belongs to this setup context, not a module-wide host. */
export const createGaLocationServices: GaLocationServicesFactory = (input) => {
  const readHostSlot = input.connections
    ? createGaHostSlotReader(input.connections, 'google')
    : async () => {
        throw new Error('The host integration connection API is unavailable')
      }
  return createGaLocationServicesForHost({ readHostSlot })(input)
}
