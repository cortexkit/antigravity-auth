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
import { join } from 'node:path'
import {
  type AccountManager,
  type AccountMetadataV3,
  type AccountRepository,
  type AccountRepositoryRead,
  type AccountRow,
  AccountSelector,
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
  type RowRef,
  readAccountStoreAdmission,
  readAccountStoreBinding,
  refreshAntigravityToken,
  rowRefKey,
  type SelectableAccount,
  sameRowRef,
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
import type { GeminiDumpState } from './gemini-dump.ts'
import type { Logger } from './logger.ts'
import type { OperatorSettings } from './operator-settings.ts'
import {
  createAuthorizedFetchAccountQuota,
  createStoreQuotaService,
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
import {
  type AntigravityRequestExecutor,
  createLocalQuotaRefresh,
  createRequestExecutor,
  type LocalRequestCredentials,
  type RequestRoutingEntry,
  type VaultRequestCredentials,
} from './shared/request-services.ts'
import {
  createMemoryQuotaSnapshots,
  type LocationRuntime,
} from './shared/runtime.ts'
import {
  createOpenCodeVaultCustody,
  type OpenCodeVaultCustody,
} from './vault-custody.ts'

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
// Menu
// ---------------------------------------------------------------------------

type GaMenuOptions = Parameters<
  CommonAuthCommandsModule['createCommandMenu']
>[0]
type GaMenuSection = NonNullable<GaMenuOptions['cache']>
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
    'operatorSettings' | 'dump' | 'applyOperatorSettings'
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
    settings: operatorMenuSettings(runtime.operatorSettings),
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
  let disposed = false

  /** Starts waiting for the redirect; resolves with the waiting promise. */
  const startWaiting = async (
    expectedState: string,
  ): Promise<Promise<string>> => {
    if (waitForCode) return waitForCode(expectedState)
    const listener = await startOAuthListener()
    listeners.add(listener)
    return (async () => {
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
  }

  return {
    async run(ref, invocation) {
      if (disposed)
        return {
          ok: false,
          text: 'The location is shutting down.',
          code: 'refused',
        }
      const authorization = await authorize()
      const state = new URL(authorization.url).searchParams.get('state')
      if (!state)
        return {
          ok: false,
          text: 'The sign-in could not be started.',
          code: 'action-failed',
        }
      const waiting = await startWaiting(state)
      void (async () => {
        try {
          const code = await waiting
          const result = await exchange(code, state)
          if (result.type !== 'success') {
            invocation.notify('The sign-in was not completed.', 'error')
            return
          }
          await access.reauthorizeAccount(ref, result)
          await input.afterChange()
          invocation.notify('Account reauthorized.', 'info')
        } catch {
          invocation.notify(
            'The account could not be reauthorized; nothing was changed.',
            'error',
          )
        }
      })()
      return `Sign in with the browser to reauthorize this account:\n${authorization.url}\nWaiting for the browser…`
    },
    async dispose() {
      disposed = true
      const open = [...listeners]
      listeners.clear()
      await Promise.all(open.map((listener) => listener.close()))
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
  /**
   * The location's vault custody, for the account file the location
   * resolves. Without it the location serves its local account store only.
   */
  readonly custody?: (input: {
    readonly accountFile: string
    readonly overrides: GaPluginOverrides
  }) => GaLocationCustody
}

/** The vault custody operations a GA location uses. */
export interface GaLocationCustody
  extends Pick<OpenCodeVaultCustody, 'readMode' | 'menuSection' | 'dispose'> {
  custodySource(): Promise<GaVaultSource>
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
export type GaVaultAccountRow = SelectableAccount & {
  route: VaultRouteRef
}

/**
 * Keeps a vault row's in-memory selection state across a roster re-read and
 * takes only the route's display fields from the fresh roster; the vault
 * keeps no cooldown, rate-limit or usage state for the plugin to reload.
 */
export function refreshGaVaultRow(
  prior: GaVaultAccountRow,
  fresh: GaVaultAccountRow,
): void {
  prior.route = fresh.route
  if (fresh.email === undefined) delete prior.email
  else prior.email = fresh.email
}

/** A vault row's identity: its route, credential and asserted account. */
export function gaVaultRowKey(row: GaVaultAccountRow): string {
  return JSON.stringify([
    row.route.routeId,
    row.route.credentialId,
    row.route.accountIdentity,
  ])
}

/**
 * Selection rows for the vault's selectable routes, in roster order. A row
 * holds the route and selection bookkeeping only: no token, refresh token,
 * project or local reference.
 */
export function gaVaultRows(
  routes: readonly VaultRouteRef[],
): GaVaultAccountRow[] {
  return routes.map((route, index) => ({
    index,
    enabled: true,
    lastUsed: 0,
    rateLimitResetTimes: {},
    touchedForQuota: {},
    route,
    ...(route.email !== undefined ? { email: route.email } : {}),
  }))
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
    fetchImpl: (request: RequestInfo | URL, init?: RequestInit) =>
      fetch(request, init),
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
  const manager = await loadAccountManagerFromRepository(input.repository)
  input.accounts.current = manager
  input.accounts.quotaLogger = runtime.logger.createLogger('quota')
  await runtime.replaceAccounts(manager)
  const logger = runtime.logger.createLogger('request')
  const executor = createRequestExecutor({
    ...gaEngineCollaborators({
      runtime,
      overrides: input.overrides,
      routes: input.routes,
      logger,
    }),
    accounts: manager,
    credentials: createGaLocalCredentials(manager, {
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
    logger: runtime.logger.createLogger('store-quota'),
    ...(quotaFetch ? { transport: () => quotaFetch } : {}),
  })
  return {
    execute: createGaJobExecutor(executor),
    refreshQuota: (refs) => storeQuota.checkStoreQuota(refs),
    refreshAccounts: () => manager.refreshFromRepository(),
    async dispose() {
      executor.dispose()
      await storeQuota.dispose()
      if (input.accounts.current === manager) {
        input.accounts.current = null
        input.accounts.quotaLogger = null
      }
      await runtime.replaceAccounts(null)
      await manager.flushSaveToDisk()
    },
  }
}

/** The vault account source operations a vault request pipeline uses. */
export type GaVaultSource = Pick<
  AntigravityVaultAccountSource,
  'refresh' | 'routes' | 'admit' | 'reportServedStatus'
>

/**
 * The shared request engine for a location whose accounts are held by the
 * vault. Selection runs on the shared `AccountSelector` over the vault's
 * selectable routes (metadata rows, no credential); every physical send
 * takes a fresh receipt for the selected route through
 * `createGaVaultCredentials`. Nothing is refreshed or cached locally.
 * `refreshAccounts` re-reads the vault roster and keeps each route's
 * selection state while its route, credential and asserted account stay
 * the same. Selection state is in memory only.
 */
export async function createGaVaultRequestPipeline(input: {
  readonly source: GaVaultSource
  readonly runtime: GaStartInput['runtime']
  readonly overrides: GaPluginOverrides
  readonly routes: GaRouteBook
  readonly now?: () => number
}): Promise<GaRequestPipeline> {
  const selector = new AccountSelector<GaVaultAccountRow>({
    ...(input.now ? { now: input.now } : {}),
  })
  await input.source.refresh()
  selector.resetAccounts(gaVaultRows(input.source.routes()))
  const logger = input.runtime.logger.createLogger('request')
  const executor = createRequestExecutor<GaVaultAccountRow>({
    ...gaEngineCollaborators({
      runtime: input.runtime,
      overrides: input.overrides,
      routes: input.routes,
      logger,
    }),
    accounts: selector,
    credentials: createGaVaultCredentials(input.source),
    trackers: {
      health: selector.healthTracker,
      token: selector.tokenTracker,
    },
  })
  return {
    execute: createGaJobExecutor(executor),
    async refreshAccounts() {
      await input.source.refresh()
      selector.replaceAccounts(gaVaultRows(input.source.routes()), {
        keyOf: gaVaultRowKey,
        refresh: refreshGaVaultRow,
      })
    },
    async dispose() {
      executor.dispose()
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
  return (row: GaVaultAccountRow): string => {
    const key = gaVaultRowKey(row)
    let selector = byKey.get(key)
    if (selector === undefined) {
      selector = createSelector()
      byKey.set(key, selector)
    }
    return selector
  }
}

/**
 * The Accounts and Quota sections of a vault custody location. Accounts
 * lists the vault's selectable accounts by position; the vault, not this
 * plugin, adds and removes them. Quota checks for vault accounts are not
 * offered.
 */
function gaVaultAccountSections(
  source: GaVaultSource,
  selectorOf: (row: GaVaultAccountRow) => string,
): { accounts: GaMenuSection; quota: GaMenuSection } {
  return {
    accounts: {
      title: 'Accounts',
      build: () => {
        const rows = gaVaultRows(source.routes())
        return {
          lines: [
            rows.length === 0
              ? 'The vault serves no accounts to this computer yet.'
              : `${rows.length} accounts served from the vault`,
          ],
          items: rows.map((row, position) => ({
            id: selectorOf(row),
            label: `Account ${position + 1}`,
            detail: 'served from the vault',
          })),
        }
      },
    },
    quota: {
      title: 'Quota',
      build: () => ({
        lines: ['Quota checks are not available for vault accounts.'],
      }),
    },
  }
}

/**
 * The `state` source of a vault custody location: the vault's selectable
 * accounts as redaction rows with opaque selectors, read one at a time.
 * Vault rows carry no metadata or access blocks of this plugin's own.
 */
function createGaVaultStateSource(input: {
  readonly source: GaVaultSource
  readonly selectorOf: (row: GaVaultAccountRow) => string
  readonly generation: string
  readonly settings: () => AntigravitySettingsDto
  readonly route: (scope: AntigravityRpcScope) => SidebarRoutingEntry | null
  readonly observe?: ObserveAccountSnapshot
}): GaStateSource {
  let readSeq = 0
  let queue: Promise<unknown> = Promise.resolve()
  const readOnce = async (scope: AntigravityRpcScope, signal: AbortSignal) => {
    if (signal.aborted) throw abortError(signal)
    const rows = gaVaultRows(input.source.routes())
    const settings = input.settings()
    const route = input.route(scope)
    if (signal.aborted) throw abortError(signal)
    readSeq += 1
    const overLimit = rows.length > ACCOUNT_LIMIT
    const answer: GaStateRead = {
      readSeq,
      accounts: overLimit
        ? { kind: 'over-limit', count: rows.length }
        : {
            kind: 'complete',
            rows: rows.map((row, position) => ({
              selector: input.selectorOf(row),
              row: { index: position, enabled: row.enabled, current: false },
            })),
          },
      route,
      status: {
        checkedAt: null,
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
                cooldownUntil: null,
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
 * store is opened. The vault source is taken from custody (which refuses
 * while OpenCode holds its own Google login), requests go through
 * `createGaVaultRequestPipeline`, and the menu shows the vault's accounts,
 * this location's settings and the Vault section. The runtime keeps quota
 * snapshots in memory; it gets no account view, so its quota poller and
 * token refresh queue do not run for vault accounts.
 */
async function createGaVaultLocationServices(input: {
  readonly custody: GaLocationCustody
  readonly overrides: GaPluginOverrides
  readonly bindings: Pick<GaLocationServicesBindings, 'createSelector'>
}): Promise<GaLocationServices> {
  const { custody, overrides } = input
  let source: GaVaultSource
  try {
    source = await custody.custodySource()
  } catch (error) {
    await custody.dispose()
    throw error
  }
  const selectorOf = vaultSelectors(
    input.bindings.createSelector ?? defaultSelector,
  )
  let pipeline: GaRequestPipeline | null = null
  let disposed: Promise<void> | null = null
  return {
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
      pipeline = await createGaVaultRequestPipeline({
        source,
        runtime: location,
        overrides,
        routes,
      })
      const started = pipeline
      const settings = operatorMenuSettings(location.operatorSettings)
      const menu = createAntigravityCommandMenu({
        source: 'sections',
        commands: await loadCommonAuthCommands(),
        sections: {
          ...gaVaultAccountSections(source, selectorOf),
          ...antigravitySettingsSections(settings),
        },
        diagnostics: diagnosticsMenuSection({
          settings: location.operatorSettings,
          dump: location.dump,
          applyLogLevel: () => location.applyOperatorSettings(),
        }),
        extras: [custody.menuSection()],
      })
      return {
        execute: started.execute,
        state: createGaVaultStateSource({
          source,
          selectorOf,
          generation: start.generation,
          settings: () =>
            gaSettingsOf(location.operatorSettings.get(), location.dump),
          route: (scope) => routes.route(scope),
          ...(overrides.observeAccountSnapshot
            ? { observe: overrides.observeAccountSnapshot }
            : {}),
        }),
        commands: createGaMenuCommandService({
          menu,
          notify: start.notify,
          afterApply: () => started.refreshAccounts(),
        }),
      }
    },
    dispose() {
      disposed ??= (async () => {
        const active = pipeline
        pipeline = null
        try {
          if (active) await active.dispose()
        } finally {
          await custody.dispose()
        }
      })()
      return disposed
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
    const custody = bindings.custody?.({
      accountFile: join(directory, GA_ACCOUNTS_FILE),
      overrides,
    })
    if (custody) {
      const mode = await custody.readMode()
      if (!mode.ok) {
        await custody.dispose()
        throw new Error(
          `The Antigravity vault mode is unclear (${mode.reason}); choose a mode in the Vault section of the Antigravity menu.`,
        )
      }
      if (mode.record.mode === 'custody')
        return createGaVaultLocationServices({ custody, overrides, bindings })
    }
    let opened: LocationRepository
    try {
      opened = await openLocationRepository(directory, bindings, overrides)
    } catch (error) {
      await custody?.dispose()
      throw error
    }
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
    let reauthorize: ReturnType<typeof createGaReauthorize> | null = null
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
        const started = pipeline
        const refreshAccounts = () => started.refreshAccounts()
        reauthorize = createGaReauthorize({
          repository,
          overrides,
          afterChange: refreshAccounts,
        })
        const checkQuota = started.refreshQuota
        const menu = createGaLocationMenu({
          commands: await loadCommonAuthCommands(),
          repository,
          runtime: location,
          reauthorize,
          ...(custody ? { vault: custody.menuSection() } : {}),
          ...(checkQuota ? { refreshQuota: (refs) => checkQuota(refs) } : {}),
        })
        const commands = createGaMenuCommandService({
          menu,
          notify: input.notify,
          afterApply: refreshAccounts,
        })
        return { state, commands, execute: started.execute }
      },
      dispose() {
        disposed ??= (async () => {
          const active = pipeline
          pipeline = null
          try {
            await reauthorize?.dispose()
            if (active) await active.dispose()
          } finally {
            await custody?.dispose()
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

/** What the OpenCode 2 host supplies for vault custody of its locations. */
export interface GaVaultHost {
  /**
   * The host's own Google sign-in, read through its public integration API
   * (see `createGaHostSlotReader`); rejects when it cannot be read.
   */
  readonly readHostSlot: () => Promise<unknown>
  /** The vault client library's resolution of its connection file. */
  readonly connectionFile: () => string | Promise<string>
}

/**
 * The production GA location services: the embedded common-auth store,
 * the system clock, the repository-backed request pipeline and the
 * collaborators above. Every activation gets its own repository, account
 * slot and pipeline. With `vault`, a location can also serve the vault's
 * accounts: its mode file decides, and the menu's Vault section switches.
 */
export function createGaLocationServicesForHost(
  vault?: GaVaultHost,
): GaLocationServicesFactory {
  return (input) => {
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
      ...(vault
        ? {
            custody: ({ accountFile }) =>
              createOpenCodeVaultCustody({
                accountFile,
                readHostSlot: vault.readHostSlot,
                connectionFile: vault.connectionFile,
                // The engine reads each send's HTTP status itself.
                reporterSource: 'direct',
              }),
          }
        : {}),
    })(input)
  }
}

/** The GA location services of a host that offers no vault custody. */
export const createGaLocationServices: GaLocationServicesFactory =
  createGaLocationServicesForHost()
