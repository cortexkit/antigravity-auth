/**
 * The `/antigravity` command menu, shared by every host adapter.
 *
 * The menu itself (payloads, confirmation, redaction, per-invocation
 * isolation and action dispatch) is common-auth's public `./commands` entry;
 * this module only supplies Antigravity's section bodies. The Accounts,
 * Quota, Routing and Limits slots replace the library's store-backed
 * built-ins, because the built-ins would put each account's row id and
 * recorded identity (its email) into the payload a renderer receives.
 *
 * Accounts are shown by position ("Account 2") and carry an opaque item id:
 * a random string bound for the life of the menu to one exact credential
 * (row id, credential epoch and recorded identity). An action runs against
 * the credential captured in the read that built it, and the repository
 * refuses it if that credential has since changed. Item ids are never reused
 * for another credential and positions are never accepted as targets.
 *
 * Nothing here imports a host SDK; the commands module, the account source
 * and the settings arrive from the caller.
 */

import { randomBytes } from 'node:crypto'

import { rowRefKey } from './account-identity.ts'
import type {
  AccountRepository,
  AccountRepositoryRead,
  AccountRow,
  RoutingTarget,
  RowRef,
} from './account-repository-types.ts'
import type { CommonAuthCommandsModule } from './common-auth-runtime.ts'

type Commands = CommonAuthCommandsModule
type CommandMenu = ReturnType<Commands['createCommandMenu']>
type CommandMenuOptions = Parameters<Commands['createCommandMenu']>[0]
type PluginSection = NonNullable<CommandMenuOptions['cache']>
type PluginExtraSection = NonNullable<CommandMenuOptions['extras']>[number]
type SectionContent = Awaited<ReturnType<PluginSection['build']>>
type ItemDefinition = NonNullable<SectionContent['items']>[number]
type ActionDefinition = NonNullable<ItemDefinition['actions']>[number]
type ActionOutcome = Exclude<
  Awaited<ReturnType<ActionDefinition['run']>>,
  string
>
type CommandInvocation = Parameters<PluginSection['build']>[0]

/** The slash command's name, without the slash. */
export const ANTIGRAVITY_MENU_COMMAND = 'antigravity'
export const ANTIGRAVITY_MENU_TITLE = 'Antigravity'

/** `disabledReason` recorded when the user disables an account from the menu. */
export const ANTIGRAVITY_MENU_DISABLED_REASON = 'disabled from the command menu'

/** The account operations the menu reads and writes. */
export type AntigravityMenuAccounts = Pick<
  AccountRepository,
  'read' | 'setEnabled' | 'remove' | 'selectAccount'
>

/** Routing and killswitch values the Routing and Limits sections show. */
export interface AntigravityMenuSettings {
  readonly routing: {
    readonly cliFirst: boolean
    readonly quotaStyleFallback: boolean
  }
  readonly killswitch: {
    readonly enabled: boolean
    readonly minimumRemainingPercent: number
  }
}

/**
 * The location's operator settings. `read` is called for every section
 * build, so the menu always shows the current values; only the two update
 * methods write.
 */
export interface AntigravityMenuSettingsSource {
  read(): AntigravityMenuSettings | Promise<AntigravityMenuSettings>
  updateRouting(next: AntigravityMenuSettings['routing']): Promise<void>
  updateKillswitch(next: AntigravityMenuSettings['killswitch']): Promise<void>
}

/**
 * The outcome of one quota check over the menu's accounts. `checked` counts
 * readings taken and recorded for exactly the credential they were asked
 * for; `notChecked` counts the rest (refused because the credential changed
 * or is unusable, or failed).
 */
export interface AntigravityQuotaCheckReport {
  readonly checked: number
  readonly notChecked: number
}

/** Options both menu modes share; the host's sections and the menu plumbing. */
interface AntigravityMenuSharedOptions {
  /** common-auth's public `./commands` entry, as `loadCommonAuthCommands` returns it. */
  readonly commands: Commands
  readonly cache?: PluginSection
  readonly diagnostics?: PluginSection
  readonly extras?: readonly PluginExtraSection[]
  readonly logger?: CommandMenuOptions['logger']
  readonly redaction?: CommandMenuOptions['redaction']
  readonly now?: () => number
}

/**
 * A menu over an account repository (OpenCode): this module builds the
 * Accounts, Quota, Routing and Limits sections from the repository and the
 * location's operator settings.
 */
export interface AntigravityRepositoryMenuOptions
  extends AntigravityMenuSharedOptions {
  readonly source: 'repository'
  readonly accounts: AntigravityMenuAccounts
  readonly settings: AntigravityMenuSettingsSource
  /**
   * Checks quota now for exactly the given account credentials and reports
   * how many readings were taken. Without it the Quota section offers no
   * check action.
   */
  readonly refreshQuota?: (
    refs: readonly RowRef[],
    invocation: CommandInvocation,
  ) => Promise<AntigravityQuotaCheckReport>
  /**
   * The host's login. It returns the text to show; the host owns the OAuth
   * flow (browser, callback, manual paste) and adds the account itself.
   */
  readonly login?: {
    readonly label?: string
    run(invocation: CommandInvocation): Promise<string | ActionOutcome>
  }
  /**
   * Per-account quota floors the host keeps. Without it the account items
   * offer no floor action.
   */
  readonly accountLimits?: AntigravityAccountLimitSource
  /**
   * The host's re-authentication of one account: a fresh sign-in that
   * replaces exactly the credential named by the captured reference. It may
   * finish later (a browser sign-in); it reports through the invocation.
   * Without it the account items offer no Reauthorize action.
   */
  readonly reauthorize?: {
    readonly label?: string
    run(
      ref: RowRef,
      invocation: CommandInvocation,
    ): Promise<string | ActionOutcome>
  }
  /** Item id source; defaults to 128 random bits. */
  readonly createItemId?: () => string
}

/**
 * A per-account minimum remaining quota, kept by the host. The menu hands it
 * the exact credential reference captured for the item, never a position,
 * an id shown to the user or a value derived from a token; how the floor is
 * stored stays private to the host. `write` answers `stale` (or throws the
 * repository's attribution failure) when that credential is no longer the
 * row's current one, and then writes nothing.
 */
export interface AntigravityAccountLimitSource {
  /** The account's own floor, or null when it follows the global floor. */
  read(ref: RowRef): number | null | Promise<number | null>
  /** Sets the floor; null returns the account to the global floor. */
  write(
    ref: RowRef,
    minimumRemainingPercent: number | null,
  ): Promise<'applied' | 'stale'>
}

/** The four account slots, each supplied by the host. */
export interface AntigravityMenuSections {
  readonly accounts: PluginSection
  readonly quota: PluginSection
  readonly routing: PluginSection
  readonly limits: PluginSection
}

/**
 * A menu whose account slots the host builds itself (a single login or a
 * vault-held account, with no account rows to expose). No repository is
 * read or written; the host's items and actions run through the same
 * library dispatcher.
 */
export interface AntigravitySectionsMenuOptions
  extends AntigravityMenuSharedOptions {
  readonly source: 'sections'
  readonly sections: AntigravityMenuSections
}

export type AntigravityCommandMenuOptions =
  | AntigravityRepositoryMenuOptions
  | AntigravitySectionsMenuOptions

// ---------------------------------------------------------------------------
// Item ids
// ---------------------------------------------------------------------------

/**
 * Opaque item ids, one per exact credential for the life of the menu. A
 * credential that changes gets a new id; the old one is never reissued.
 */
interface ItemIds {
  idFor(ref: RowRef): string
}

function createItemIds(create: () => string): ItemIds {
  const byRef = new Map<string, string>()
  const issued = new Set<string>()
  return {
    idFor(ref) {
      const key = rowRefKey(ref)
      const existing = byRef.get(key)
      if (existing !== undefined) return existing
      let id = create()
      while (issued.has(id)) id = create()
      issued.add(id)
      byRef.set(key, id)
      return id
    },
  }
}

function randomItemId(): string {
  return `acct-${randomBytes(16).toString('base64url')}`
}

// ---------------------------------------------------------------------------
// Row text
// ---------------------------------------------------------------------------

type ReadyRead = Extract<AccountRepositoryRead, { status: 'ready' }>

function notReadyLines(read: AccountRepositoryRead): string[] {
  switch (read.status) {
    case 'ready':
      return []
    case 'pending-migration':
      return [
        'The account store is waiting for migration. Run `antigravity-auth migrate --offline`.',
      ]
    case 'management-pending':
      return ['An account operation is still finishing; try again shortly.']
    case 'error':
      return [`The account store could not be read (${read.file} file).`]
  }
}

function isActive(read: ReadyRead, ref: RowRef): boolean {
  const active = read.routing?.activeRow
  return (
    active !== undefined &&
    active !== null &&
    rowRefKey(active) === rowRefKey(ref)
  )
}

/** What blocks the row, from its metadata; never its email or reason text. */
function blockOf(row: AccountRow): string | undefined {
  if (row.metadata.status !== 'present') return 'metadata unavailable'
  const metadata = row.metadata.metadata
  if (metadata.verificationRequired === true) return 'verification required'
  if (metadata.accountIneligible === true) return 'ineligible'
  return undefined
}

function statusOf(row: AccountRow, now: number): string {
  if (!row.enabled) return 'disabled'
  const block = blockOf(row)
  if (block) return block
  if (row.metadata.status === 'present') {
    const until = row.metadata.metadata.coolingDownUntil
    if (typeof until === 'number' && until > now) return 'cooling down'
  }
  return row.usable ? 'ready' : 'unusable'
}

function percent(fraction: number | null | undefined): string {
  return typeof fraction === 'number' ? `${Math.round(fraction * 100)}%` : '–'
}

function quotaLine(row: AccountRow, position: number): string {
  const label = `Account ${position + 1}`
  if (row.quota.status !== 'present') return `${label}: no quota reading`
  const groups = row.quota.quota.cachedQuota
  if (!groups || Object.keys(groups).length === 0)
    return `${label}: no quota reading`
  const parts = Object.entries(groups).map(
    ([name, group]) => `${name} ${percent(group.remainingFraction)}`,
  )
  return `${label}: ${parts.join(' · ')}`
}

function failure(text: string, code: string): ActionOutcome {
  return { ok: false, text, code }
}

/** Repository failures that mean the captured credential has changed. */
const STALE_KINDS = new Set(['attribution', 'unknown-row', 'id-removed'])

function staleOrRethrow(error: unknown): ActionOutcome {
  const kind =
    typeof error === 'object' &&
    error !== null &&
    'failure' in error &&
    typeof error.failure === 'object' &&
    error.failure !== null &&
    'kind' in error.failure
      ? error.failure.kind
      : undefined
  if (typeof kind === 'string' && STALE_KINDS.has(kind))
    return failure(
      'That account changed since the menu was opened; nothing was changed.',
      'stale-account',
    )
  throw error
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const ROUTING_TARGETS: readonly { value: RoutingTarget; label: string }[] = [
  { value: 'active', label: 'All models' },
  { value: 'claude', label: 'Claude models' },
  { value: 'gemini', label: 'Gemini models' },
]

function isRoutingTarget(value: unknown): value is RoutingTarget {
  return ROUTING_TARGETS.some((target) => target.value === value)
}

/** The account item's re-authentication action, over the host's sign-in. */
function reauthorizeAction(
  reauthorize: NonNullable<AntigravityRepositoryMenuOptions['reauthorize']>,
  ref: RowRef,
): ActionDefinition {
  return {
    id: 'reauthorize',
    label: reauthorize.label ?? 'Reauthorize',
    description: "Sign in again to replace this account's saved login.",
    run: ({ invocation }) => reauthorize.run(ref, invocation),
  }
}

/** The account item's quota floor action, over the host's floor source. */
function floorAction(
  source: AntigravityAccountLimitSource,
  ref: RowRef,
  position: number,
  floor: number | null,
): ActionDefinition {
  return {
    id: 'limit',
    label: 'Set quota floor',
    description:
      'Stop using this account below this remaining quota; leave empty to follow the global floor.',
    knobs: [
      {
        kind: 'number',
        id: 'minimumRemainingPercent',
        label: 'Minimum remaining percent',
        ...(floor !== null ? { value: floor } : {}),
        min: 0,
        max: 100,
      },
    ],
    run: async ({ values }) => {
      const value = values.minimumRemainingPercent
      const next = typeof value === 'number' ? value : null
      let outcome: 'applied' | 'stale'
      try {
        outcome = await source.write(ref, next)
      } catch (error) {
        return staleOrRethrow(error)
      }
      if (outcome === 'stale')
        return failure(
          'That account changed since the menu was opened; nothing was changed.',
          'stale-account',
        )
      return next === null
        ? `Account ${position + 1} follows the global quota floor`
        : `Account ${position + 1} quota floor set to ${next}%`
    },
  }
}

function accountsSection(
  options: AntigravityRepositoryMenuOptions,
  ids: ItemIds,
  now: () => number,
): PluginSection {
  const accounts = options.accounts
  return {
    title: 'Accounts',
    async build() {
      const read = await accounts.read()
      const sectionActions: ActionDefinition[] = options.login
        ? [
            {
              id: 'add',
              label: options.login.label ?? 'Add account',
              run: ({ invocation }) =>
                options.login
                  ? options.login.run(invocation)
                  : Promise.resolve(
                      failure('Login is unavailable.', 'refused'),
                    ),
            },
          ]
        : []
      if (read.status !== 'ready')
        return { lines: notReadyLines(read), actions: sectionActions }
      const at = now()
      const limitSource = options.accountLimits
      const floors = limitSource
        ? await Promise.all(read.rows.map((row) => limitSource.read(row.ref)))
        : []
      const items: ItemDefinition[] = read.rows.map((row, position) => {
        const floor = floors[position] ?? null
        const ref = row.ref
        const active = isActive(read, ref)
        const actions: ActionDefinition[] = [
          row.enabled
            ? {
                id: 'disable',
                label: 'Disable',
                run: async () => {
                  try {
                    await accounts.setEnabled(ref, {
                      enabled: false,
                      actor: 'user',
                      reason: ANTIGRAVITY_MENU_DISABLED_REASON,
                    })
                  } catch (error) {
                    return staleOrRethrow(error)
                  }
                  return `Account ${position + 1} disabled`
                },
              }
            : {
                id: 'enable',
                label: 'Enable',
                run: async () => {
                  try {
                    await accounts.setEnabled(ref, {
                      enabled: true,
                      actor: 'user',
                    })
                  } catch (error) {
                    return staleOrRethrow(error)
                  }
                  return `Account ${position + 1} enabled`
                },
              },
          {
            id: 'select',
            label: 'Use this account',
            knobs: [
              {
                kind: 'choice',
                id: 'target',
                label: 'For',
                choices: ROUTING_TARGETS.map((target) => ({
                  value: target.value,
                  label: target.label,
                })),
                value: 'active',
              },
            ],
            run: async ({ values }) => {
              const target = values.target ?? 'active'
              if (!isRoutingTarget(target))
                return failure('Choose which models to route.', 'invalid-input')
              try {
                await accounts.selectAccount(target, ref)
              } catch (error) {
                return staleOrRethrow(error)
              }
              return `Account ${position + 1} selected`
            },
          },
          {
            id: 'remove',
            label: 'Remove',
            irreversible: true,
            confirm: `Remove account ${position + 1}? Its saved login is deleted.`,
            run: async () => {
              try {
                await accounts.remove(ref)
              } catch (error) {
                return staleOrRethrow(error)
              }
              return `Account ${position + 1} removed`
            },
          },
          ...(limitSource
            ? [floorAction(limitSource, ref, position, floor)]
            : []),
          ...(options.reauthorize
            ? [reauthorizeAction(options.reauthorize, ref)]
            : []),
        ]
        return {
          id: ids.idFor(ref),
          label: `Account ${position + 1}`,
          detail: `${statusOf(row, at)}${active ? ' · active' : ''}${floor !== null ? ` · floor ${floor}%` : ''}`,
          facts: {
            status: statusOf(row, at),
            active,
            ...(floor !== null ? { quotaFloorPercent: floor } : {}),
          },
          actions,
        }
      })
      return {
        lines:
          items.length === 0
            ? ['No accounts yet.']
            : [`${items.length} accounts`],
        items,
        actions: sectionActions,
      }
    },
  }
}

function quotaSection(
  options: AntigravityRepositoryMenuOptions,
): PluginSection {
  return {
    title: 'Quota',
    async build() {
      const read = await options.accounts.read()
      if (read.status !== 'ready') return { lines: notReadyLines(read) }
      const refs = read.rows.map((row) => row.ref)
      const refresh = options.refreshQuota
      return {
        lines:
          read.rows.length === 0
            ? ['No accounts yet.']
            : read.rows.map((row, position) => quotaLine(row, position)),
        actions: refresh
          ? [
              {
                id: 'refresh',
                label: 'Check quota now',
                run: async ({ invocation }) => {
                  const report = await refresh(refs, invocation)
                  return quotaCheckOutcome(report)
                },
              },
            ]
          : [],
      }
    },
  }
}

/** What a quota check shows: never success when no reading was taken. */
function quotaCheckOutcome(
  report: AntigravityQuotaCheckReport,
): string | ActionOutcome {
  const total = report.checked + report.notChecked
  if (total === 0) return 'No accounts to check'
  if (report.checked === 0)
    return failure(
      `Quota could not be checked for any of the ${total} accounts.`,
      'quota-unavailable',
    )
  if (report.notChecked === 0)
    return `Quota checked for ${report.checked} of ${total} accounts`
  return `Quota checked for ${report.checked} of ${total} accounts; ${report.notChecked} could not be checked`
}

/**
 * The Routing and Limits sections over a settings source, for a host that
 * supplies its own account slots (sections mode) but keeps the same
 * operator settings as the repository-mode menu.
 */
export function antigravitySettingsSections(
  settings: AntigravityMenuSettingsSource,
): Pick<AntigravityMenuSections, 'routing' | 'limits'> {
  return {
    routing: routingSection({ settings }),
    limits: limitsSection({ settings }),
  }
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off'
}

function routingSection(options: {
  readonly settings: AntigravityMenuSettingsSource
}): PluginSection {
  return {
    title: 'Routing',
    async build() {
      const current = (await options.settings.read()).routing
      return {
        lines: [
          `Gemini CLI headers first: ${onOff(current.cliFirst)}`,
          `Fall back to the other header style on quota: ${onOff(current.quotaStyleFallback)}`,
        ],
        actions: [
          {
            id: 'set',
            label: 'Change routing',
            knobs: [
              {
                kind: 'toggle',
                id: 'cliFirst',
                label: 'Gemini CLI headers first',
                value: current.cliFirst,
              },
              {
                kind: 'toggle',
                id: 'quotaStyleFallback',
                label: 'Header-style fallback on quota',
                value: current.quotaStyleFallback,
              },
            ],
            run: async ({ values }) => {
              const latest = (await options.settings.read()).routing
              await options.settings.updateRouting({
                cliFirst:
                  typeof values.cliFirst === 'boolean'
                    ? values.cliFirst
                    : latest.cliFirst,
                quotaStyleFallback:
                  typeof values.quotaStyleFallback === 'boolean'
                    ? values.quotaStyleFallback
                    : latest.quotaStyleFallback,
              })
              return 'Routing updated'
            },
          },
        ],
      }
    },
  }
}

function limitsSection(options: {
  readonly settings: AntigravityMenuSettingsSource
}): PluginSection {
  return {
    title: 'Limits',
    async build() {
      const current = (await options.settings.read()).killswitch
      return {
        lines: [
          `Quota killswitch: ${onOff(current.enabled)}`,
          `Stop using an account below: ${current.minimumRemainingPercent}% remaining`,
        ],
        actions: [
          {
            id: 'set',
            label: 'Change limits',
            knobs: [
              {
                kind: 'toggle',
                id: 'enabled',
                label: 'Quota killswitch',
                value: current.enabled,
              },
              {
                kind: 'number',
                id: 'minimumRemainingPercent',
                label: 'Minimum remaining percent',
                value: current.minimumRemainingPercent,
                min: 0,
                max: 100,
              },
            ],
            run: async ({ values }) => {
              const latest = (await options.settings.read()).killswitch
              await options.settings.updateKillswitch({
                enabled:
                  typeof values.enabled === 'boolean'
                    ? values.enabled
                    : latest.enabled,
                minimumRemainingPercent:
                  typeof values.minimumRemainingPercent === 'number'
                    ? values.minimumRemainingPercent
                    : latest.minimumRemainingPercent,
              })
              return 'Limits updated'
            },
          },
        ],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const SECTION_SLOTS = ['accounts', 'quota', 'routing', 'limits'] as const

function isPluginSection(value: unknown): value is PluginSection {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    typeof value.title === 'string' &&
    'build' in value &&
    typeof value.build === 'function'
  )
}

/** The four account slots for the chosen mode; refuses an incomplete mode. */
function accountSlots(
  options: AntigravityCommandMenuOptions,
): AntigravityMenuSections {
  switch (options.source) {
    case 'repository': {
      if (
        typeof options.accounts?.read !== 'function' ||
        typeof options.settings?.read !== 'function'
      ) {
        throw new TypeError(
          'repository menu mode needs an account repository and a settings source',
        )
      }
      const ids = createItemIds(options.createItemId ?? randomItemId)
      const now = options.now ?? Date.now
      return {
        accounts: accountsSection(options, ids, now),
        quota: quotaSection(options),
        routing: routingSection(options),
        limits: limitsSection(options),
      }
    }
    case 'sections': {
      const sections = options.sections
      for (const slot of SECTION_SLOTS) {
        if (!isPluginSection(sections?.[slot])) {
          throw new TypeError(`sections menu mode needs a ${slot} section`)
        }
      }
      return sections
    }
    default: {
      const unsupported: never = options
      void unsupported
      throw new TypeError('the menu source must be repository or sections')
    }
  }
}

/**
 * Builds the `/antigravity` menu on common-auth's `createCommandMenu`. The
 * four account slots replace the library's store-backed built-ins in both
 * modes, so no pool store is passed; Cache, Diagnostics and extras are the
 * host's.
 */
export function createAntigravityCommandMenu(
  options: AntigravityCommandMenuOptions,
): CommandMenu {
  const replace = accountSlots(options)
  return options.commands.createCommandMenu({
    command: ANTIGRAVITY_MENU_COMMAND,
    title: ANTIGRAVITY_MENU_TITLE,
    replace: {
      accounts: replace.accounts,
      quota: replace.quota,
      routing: replace.routing,
      limits: replace.limits,
    },
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.extras ? { extras: options.extras } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.redaction ? { redaction: options.redaction } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
}
