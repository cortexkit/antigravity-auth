/**
 * Slash-command wiring for the antigravity plugin.
 *
 * Three places must agree on the set of modal commands — keeping
 * them in lockstep is a hard invariant:
 *
 *   1. `MODAL_COMMANDS` — the canonical list of `CommandModalName`s.
 *   2. `registerAntigravityCommands` (in `./catalog.ts`) — what we
 *      register in the host `config.command.*` map so OpenCode
 *      recognises them.
 *   3. `buildDialogPayload` (here) — the per-command dialog payload
 *      builder the TUI renders when a notification arrives.
 *
 * If any one drifts, a future slash command will be discoverable in
 * the host palette but invisible to the dialog flow (or vice versa).
 * The bidirectional three-wiring test pins this invariant.
 *
 * `/gemini-dump` remains a backward-compatibility alias: the host
 * already registers the command under that name in `OpenCode` and
 * long-running sessions may still call it. The modal name
 * `antigravity-dump` is the canonical name; both stay registered.
 */

import { isTuiConnected as defaultIsTuiConnected } from '../rpc/notifications'
import type { CommandModalName } from '../rpc/protocol'
import {
  buildSidebarMachineStateFromAccounts,
  setSidebarMachineState,
} from '../sidebar-state'
import type { AccountCommandOAuthService } from './account-command-oauth'
import type { CommandAccountRow, CommandDataService } from './command-data'
import {
  executeGeminiDumpCommand,
  GEMINI_DUMP_COMMAND_NAME,
  parseGeminiDumpCommandAction,
  setGeminiDumpEnabled,
} from './gemini-dump'
import { createLogger } from './logger'
import {
  createOperatorSettingsController,
  type OperatorSettings,
  type OperatorSettingsController,
} from './operator-settings'
import { resolvePromptContext } from './prompt-context'
import { AccountStorageUnreadableError } from './storage'
import type { PluginClient, PluginResult } from './types'

const log = createLogger('commands')

export const ANTIGRAVITY_QUOTA_COMMAND_NAME = 'antigravity-quota'
export const ANTIGRAVITY_ACCOUNT_COMMAND_NAME = 'antigravity-account'
export const ANTIGRAVITY_ROUTING_COMMAND_NAME = 'antigravity-routing'
export const ANTIGRAVITY_KILLSWITCH_COMMAND_NAME = 'antigravity-killswitch'
export const ANTIGRAVITY_DUMP_COMMAND_NAME = 'antigravity-dump'
export const ANTIGRAVITY_LOGGING_COMMAND_NAME = 'antigravity-logging'

export const MODAL_COMMANDS: readonly CommandModalName[] = [
  ANTIGRAVITY_QUOTA_COMMAND_NAME,
  ANTIGRAVITY_ACCOUNT_COMMAND_NAME,
  ANTIGRAVITY_ROUTING_COMMAND_NAME,
  ANTIGRAVITY_KILLSWITCH_COMMAND_NAME,
  ANTIGRAVITY_DUMP_COMMAND_NAME,
  ANTIGRAVITY_LOGGING_COMMAND_NAME,
]

const HANDLED_COMMAND_SENTINEL = 'ANTIGRAVITY_COMMAND_HANDLED'

async function sendIgnoredMessage(
  client: PluginClient,
  sessionID: string,
  text: string,
): Promise<void> {
  const session = client.session as
    | {
        promptAsync?: (input: unknown) => Promise<unknown>
        prompt?: (input: unknown) => Promise<unknown> | unknown
      }
    | undefined
  const promptContext = await resolvePromptContext(client, sessionID)
  const request = {
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: 'text', text, ignored: true }],
      ...(promptContext?.agent ? { agent: promptContext.agent } : {}),
      ...(promptContext?.model ? { model: promptContext.model } : {}),
      ...(promptContext?.variant ? { variant: promptContext.variant } : {}),
    },
  }

  if (typeof session?.promptAsync === 'function') {
    await session.promptAsync(request)
    return
  }

  if (typeof session?.prompt === 'function') {
    await Promise.resolve(session.prompt(request))
    return
  }

  throw new Error(
    'OpenCode session prompt API is unavailable for ignored replies.',
  )
}

function throwHandledCommandSentinel(): never {
  throw new Error(HANDLED_COMMAND_SENTINEL)
}

interface CommandContext {
  sessionID: string
  client: PluginClient
  settings: OperatorSettingsController
  /**
   * Optional callback invoked AFTER `applyCommand` mutates persistent
   * state. The plugin entry injects a callback that pushes the current
   * account pool into the sidebar so the TUI sees a fresh snapshot.
   * Commands that need to chain side effects (e.g. account add which
   * triggers an OAuth flow) hook their own refresh.
   */
  onApplied?: (accounts?: CommandAccountRow[]) => Promise<void> | void
  /**
   * Privacy-safe data service that backs the data-first dialogs. The
   * production wiring injects one that reads from the live AccountManager
   * + storage and refreshes through the shared quota manager; tests
   * (and any context that does not care about quota UI) leave this
   * undefined and the dialog falls back to the legacy placeholder.
   */
  commandData?: CommandDataService
  accountOAuth?: AccountCommandOAuthService
}

/**
 * Build the dialog payload the TUI renders for `command`.
 *
 * Each branch produces a self-contained payload the OpenTUI dialog tree
 * can mount without further RPC chatter. The knobs object is the
 * payload-specific metadata (current toggle state, available actions,
 * default values) — knobs are intentionally stringly-typed to keep the
 * dialog code free of per-command schema definitions.
 */
export async function buildDialogPayload(
  command: CommandModalName,
  argumentsText: string,
  context: CommandContext,
): Promise<{
  command: CommandModalName
  text: string
  knobs: Record<string, unknown>
}> {
  switch (command) {
    case 'antigravity-quota': {
      const action = argumentsText.trim().toLowerCase()
      const accounts = context.commandData
        ? await context.commandData.listAccounts()
        : []
      // Render the cached snapshot immediately while the shared manager
      // refreshes all accounts; the mounted panel polls the fenced state file.
      if (context.commandData) {
        void context.commandData.refreshQuota().catch(() => {})
      }
      return {
        command,
        text: 'Antigravity quota',
        knobs: {
          mode: action === 'refresh' ? 'refresh' : 'status',
          accounts,
        },
      }
    }
    case 'antigravity-account': {
      const action = argumentsText.trim().toLowerCase()
      const accounts = context.commandData
        ? await context.commandData.listAccounts()
        : []
      return {
        command,
        text: 'Antigravity accounts',
        knobs: {
          action:
            action === 'add' ||
            action === 'refresh' ||
            action === 'remove' ||
            action === 'list'
              ? action
              : 'list',
          accounts,
        },
      }
    }
    case 'antigravity-routing': {
      const settings = context.settings.get()
      const parsed = parseToggleArguments(argumentsText)
      // State-first: the opening payload reports the CURRENT persisted
      // values (no `!` inversion). Argument overrides still flow through
      // so the slash-command-direct path can pre-stage a value, but the
      // fallback when no argument is provided is the actual current
      // state, not its negation. The apply handler returns the complete
      // post-mutation state in `knobs` so the dialog re-renders from
      // the same shape it was opened with.
      return {
        command,
        text: 'Antigravity routing',
        knobs: {
          cli_first: parsed.cli_first ?? settings.routing.cli_first,
          quota_style_fallback:
            parsed.quota_style_fallback ??
            settings.routing.quota_style_fallback,
          timeoutMs: 2_000,
        },
      }
    }
    case 'antigravity-killswitch': {
      const settings = context.settings.get()
      const parsed = parseKillswitchArguments(argumentsText)
      // State-first: opening reports the current killswitch shape
      // (`enabled`, `minimum_remaining_percent`, plus the full
      // per-account override map if any keys exist). Argument overrides
      // are honored so the slash-command-direct path stays explicit.
      return {
        command,
        text: 'Antigravity killswitch',
        knobs: {
          enabled: parsed.enabled ?? settings.killswitch.enabled,
          minimum_remaining_percent:
            parsed.minimum_remaining_percent ??
            settings.killswitch.minimum_remaining_percent,
          accounts: settings.killswitch.accounts ?? {},
          timeoutMs: 2_000,
        },
      }
    }
    case 'antigravity-dump': {
      const action = parseGeminiDumpCommandAction(argumentsText)
      return {
        command,
        text: 'Antigravity wire dump',
        knobs: {
          mode: action.type === 'usage' ? 'status' : action.type,
        },
      }
    }
    case 'antigravity-logging': {
      const level = parseLoggingLevel(argumentsText)
      return {
        command,
        text: 'Antigravity logging',
        knobs: { log_level: level },
      }
    }
    default: {
      const exhaustiveCheck: never = command
      throw new Error(`Unknown command ${exhaustiveCheck as string}`)
    }
  }
}

function parseToggleArguments(input: string): {
  cli_first?: boolean
  quota_style_fallback?: boolean
} {
  const result: { cli_first?: boolean; quota_style_fallback?: boolean } = {}
  for (const part of input.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part
      .slice(eq + 1)
      .trim()
      .toLowerCase()
    if (key === 'cli_first' || key === 'cli-first') {
      result.cli_first = value === 'true' || value === '1' || value === 'on'
    } else if (
      key === 'quota_style_fallback' ||
      key === 'quota-style-fallback'
    ) {
      result.quota_style_fallback =
        value === 'true' || value === '1' || value === 'on'
    }
  }
  return result
}

function parseKillswitchArguments(input: string): {
  enabled?: boolean
  minimum_remaining_percent?: number
} {
  const result: {
    enabled?: boolean
    minimum_remaining_percent?: number
  } = {}
  for (const part of input.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part
      .slice(eq + 1)
      .trim()
      .toLowerCase()
    if (key === 'enabled') {
      result.enabled = value === 'true' || value === '1' || value === 'on'
    } else if (
      key === 'minimum_remaining_percent' ||
      key === 'minimum-remaining-percent'
    ) {
      const n = Number.parseFloat(value)
      if (!Number.isNaN(n) && n >= 0 && n <= 100) {
        result.minimum_remaining_percent = n
      }
    }
  }
  return result
}

function parseLoggingLevel(input: string): OperatorSettings['log_level'] {
  const trimmed = input.trim().toLowerCase()
  if (
    trimmed === 'error' ||
    trimmed === 'warn' ||
    trimmed === 'info' ||
    trimmed === 'debug' ||
    trimmed === 'trace'
  ) {
    return trimmed
  }
  return 'info'
}

type AccountAction =
  | { kind: 'add' }
  | { kind: 'add-oauth-start' }
  | { kind: 'add-oauth-finish'; code: string; label?: string }
  | { kind: 'refresh' }
  | { kind: 'current'; index: number }
  | { kind: 'toggle'; index: number }
  | { kind: 'remove'; index: number }

/**
 * Parse the slash-command apply argument for `/antigravity-account`.
 *
 * Recognized forms:
 *   `<empty>`        → `{ kind: 'refresh' }` (keeps the original
 *                      "manage → refresh" placeholder semantics)
 *   `add`            → `{ kind: 'add' }`
 *   `refresh`        → `{ kind: 'refresh' }`
 *   `current <n>`    → `{ kind: 'current', index: n }`
 *   `toggle <n>`     → `{ kind: 'toggle', index: n }`
 *   `remove <n>`     → `{ kind: 'remove', index: n }`
 *
 * `n` is the transient `acct-<index>` position the dialog renders.
 * Negative or non-integer values are rejected; out-of-range indices
 * are accepted here and rejected by the data service so the dialog
 * can surface the error text.
 */
function parseAccountAction(input: string): AccountAction | undefined {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'refresh' }
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const head = parts[0]?.toLowerCase()
  if (head === 'add') return { kind: 'add' }
  if (head === 'add-oauth-start' && parts.length === 1) {
    return { kind: 'add-oauth-start' }
  }
  if (head === 'add-oauth-finish') {
    const code = parts[1]
    if (!code) return undefined
    const labelAt = parts.indexOf('--label')
    const label =
      labelAt === -1
        ? undefined
        : parts
            .slice(labelAt + 1)
            .join(' ')
            .trim()
    return { kind: 'add-oauth-finish', code, label: label || undefined }
  }
  if (head === 'refresh') return { kind: 'refresh' }
  if (head === 'current' || head === 'toggle' || head === 'remove') {
    const raw = parts[1]
    if (raw === undefined) return undefined
    const index = Number.parseInt(raw, 10)
    if (!Number.isInteger(index) || index < 0) return undefined
    return { kind: head, index }
  }
  return undefined
}

export interface ApplyRequest {
  command: CommandModalName
  arguments: string
  sessionId?: string
}

export interface ApplyResult {
  text: string
  knobs: Record<string, unknown>
}

/**
 * Apply the result of a TUI dialog back to the plugin runtime.
 *
 * Most commands mutate persistent operator settings (routing toggles,
 * killswitch thresholds, log level). Account add/refresh kicks off the
 * OAuth flow which can take up to two minutes on a fresh login — that
 * path opts into a 120s RPC timeout. Status / toggle paths keep the
 * default 2s timeout.
 *
 * The TUI's imperative dispatcher (`tui/command-dialogs.openCommandDialog`)
 * forwards the apply `options.timeoutMs` knob into the RPC apply call
 * so a long-running path (account add / refresh) can opt in without the
 * dialog layer having to special-case it.
 */
export async function applyCommand(
  request: ApplyRequest,
  context: CommandContext,
): Promise<ApplyResult> {
  const result = await applyCommandInner(request, context)
  // Push a sidebar refresh after every mutation so the TUI's next poll
  // sees a fresh `checkedAt`. The refresher is optional; tests and
  // read-only contexts leave it undefined and skip the write entirely.
  if (context.onApplied) {
    const accounts = result.knobs.accounts
    await Promise.resolve(
      context.onApplied(
        Array.isArray(accounts) ? (accounts as CommandAccountRow[]) : undefined,
      ),
    ).catch(() => {
      // Sidebar refresh must never break the command's apply response.
    })
  }
  return result
}

/**
 * Run a single account-mutation call against the data service and
 * normalize the result for the apply layer.
 *
 * Returns a tagged union so the apply layer can distinguish:
 *   - `{ kind: 'rows', rows }` — the mutation succeeded; the dialog
 *     re-renders with the freshly-projected rows.
 *   - `{ kind: 'not-found' }` — the index was out of range (the
 *     service returned `null`); the apply layer reports a friendly
 *     "account N not found" toast.
 *   - `{ kind: 'error', text }` — the locked-storage write rejected
 *     (AccountStorageUnreadableError, lock contention, I/O); the
 *     apply layer surfaces the message as the dialog's `text` so the
 *     user knows the mutation did NOT land.
 */
type AccountMutationResult =
  | { kind: 'rows'; rows: CommandAccountRow[] }
  | { kind: 'not-found' }
  | { kind: 'error'; text: string }

async function runAccountMutation(
  context: CommandContext,
  call: () => Promise<CommandAccountRow[] | null> | undefined,
): Promise<AccountMutationResult> {
  if (!context.commandData) {
    return {
      kind: 'error',
      text: 'Command data service is not wired; account mutations are disabled.',
    }
  }
  try {
    const rows = await call()
    if (rows == null) return { kind: 'not-found' }
    return { kind: 'rows', rows }
  } catch (error) {
    if (error instanceof AccountStorageUnreadableError) {
      log.warn('account mutation: locked storage is unreadable', {
        error: error.message,
      })
      return {
        kind: 'error',
        text: `Account storage is unreadable: ${error.details.reason}. The mutation was not applied.`,
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    log.warn('account mutation failed', { error: message })
    return {
      kind: 'error',
      text: `Account mutation failed: ${message}`,
    }
  }
}

function notFoundResult(verb: string, index: number): ApplyResult {
  return {
    text: `Cannot ${verb}: account ${index} not found`,
    knobs: { action: verb, timeoutMs: 2_000 },
  }
}

function errorResult(verb: string, text: string): ApplyResult {
  return {
    text,
    knobs: { action: verb, timeoutMs: 2_000, error: true },
  }
}

async function applyCommandInner(
  request: ApplyRequest,
  context: CommandContext,
): Promise<ApplyResult> {
  switch (request.command) {
    case 'antigravity-quota': {
      // `refresh` is the only quota apply path; opening is cache-only
      // via `listAccounts`. The data service forces the refresh and
      // returns the freshly persisted rows so the dialog can re-render
      // in place without a second RPC round-trip.
      const accounts = context.commandData
        ? await context.commandData.refreshQuota()
        : ([] as CommandAccountRow[])
      return {
        text: 'Quota refreshed',
        knobs: { accounts, timeoutMs: 2_000 },
      }
    }
    case 'antigravity-account': {
      const args = request.arguments.trim()
      const parsed = parseAccountAction(args)
      if (!parsed) {
        return {
          text: `Unknown account action: ${args}`,
          knobs: { action: 'unknown', timeoutMs: 2_000 },
        }
      }

      if (parsed.kind === 'add-oauth-start') {
        if (!context.accountOAuth) {
          return {
            text: 'OAuth account add is unavailable.',
            knobs: { timeoutMs: 120_000, error: true },
          }
        }
        const result = await context.accountOAuth.start(context.sessionID)
        return {
          text: `Open this URL in your browser:\n${result.url}`,
          knobs: {
            oauthUrl: result.url,
            accounts: result.accounts,
            timeoutMs: 120_000,
          },
        }
      }

      if (parsed.kind === 'add-oauth-finish') {
        if (!context.accountOAuth) {
          return {
            text: 'OAuth account add is unavailable.',
            knobs: { timeoutMs: 120_000, error: true },
          }
        }
        const result = parsed.label
          ? await context.accountOAuth.finish(
              context.sessionID,
              parsed.code,
              parsed.label,
            )
          : await context.accountOAuth.finish(context.sessionID, parsed.code)
        return {
          text: result.text,
          knobs: { accounts: result.accounts, timeoutMs: 120_000 },
        }
      }

      // The data service drives the locked-storage mutator for the
      // three CRUD mutations. The locked-storage write is awaited FIRST so a
      // failed disk write never leaves the runtime ahead of disk. When
      // that await throws — AccountStorageUnreadableError, lock
      // contention, I/O — we catch here and surface the message as the
      // apply's `text`. The dialog toasts that text and stays mounted
      // (the `clear()` is gated on `apply returning rows`).
      if (parsed.kind === 'current') {
        const result = await runAccountMutation(context, () =>
          context.commandData?.setCurrentAccount(parsed.index),
        )
        if (result.kind === 'not-found') {
          return notFoundResult('set current', parsed.index)
        }
        if (result.kind === 'error') {
          return errorResult('current', result.text)
        }
        return {
          text: 'Current account updated',
          knobs: {
            accounts: result.rows,
            action: 'current',
            timeoutMs: 2_000,
          },
        }
      }

      if (parsed.kind === 'toggle') {
        const result = await runAccountMutation(context, () =>
          context.commandData?.toggleAccountEnabled(parsed.index),
        )
        if (result.kind === 'not-found') {
          return notFoundResult('toggle', parsed.index)
        }
        if (result.kind === 'error') {
          return errorResult('toggle', result.text)
        }
        return {
          text: 'Account enabled state updated',
          knobs: {
            accounts: result.rows,
            action: 'toggle',
            timeoutMs: 2_000,
          },
        }
      }

      if (parsed.kind === 'remove') {
        const result = await runAccountMutation(context, () =>
          context.commandData?.removeAccount(parsed.index),
        )
        if (result.kind === 'not-found') {
          return notFoundResult('remove', parsed.index)
        }
        if (result.kind === 'error') {
          return errorResult('remove', result.text)
        }
        return {
          text: 'Account removed',
          knobs: {
            accounts: result.rows,
            action: 'remove',
            timeoutMs: 2_000,
          },
        }
      }

      // `add` (and `refresh`) — backwards-compatible no-op response
      // that keeps the 120s RPC timeout for the future OAuth path.
      return {
        text: `Account ${parsed.kind} requested`,
        knobs: { action: parsed.kind, timeoutMs: 120_000 },
      }
    }
    case 'antigravity-routing': {
      const parsed = parseToggleArguments(request.arguments)
      try {
        await context.settings.update((draft) => {
          if (parsed.cli_first !== undefined) {
            draft.routing.cli_first = parsed.cli_first
          }
          if (parsed.quota_style_fallback !== undefined) {
            draft.routing.quota_style_fallback = parsed.quota_style_fallback
          }
        })
      } catch (error) {
        // Lock contention / unreadable config — surface the writer's
        // message so the dialog can toast the real cause and stay
        // mounted (T8/T10 pattern). The runtime view is left untouched
        // because the writer either landed or threw.
        const message = error instanceof Error ? error.message : String(error)
        log.warn('routing update failed', { error: message })
        return {
          text: `Routing update failed: ${message}`,
          knobs: { timeoutMs: 2_000, error: true },
        }
      }
      // Complete persisted state — the dialog re-renders from the same
      // shape `buildDialogPayload` produced on open.
      const after = context.settings.get()
      return {
        text: 'Routing updated',
        knobs: {
          cli_first: after.routing.cli_first,
          quota_style_fallback: after.routing.quota_style_fallback,
          timeoutMs: 2_000,
        },
      }
    }
    case 'antigravity-killswitch': {
      const parsed = parseKillswitchArguments(request.arguments)
      try {
        await context.settings.update((draft) => {
          if (parsed.enabled !== undefined) {
            draft.killswitch.enabled = parsed.enabled
          }
          if (parsed.minimum_remaining_percent !== undefined) {
            draft.killswitch.minimum_remaining_percent =
              parsed.minimum_remaining_percent
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('killswitch update failed', { error: message })
        return {
          text: `Killswitch update failed: ${message}`,
          knobs: { timeoutMs: 2_000, error: true },
        }
      }
      // Complete persisted state — the dialog re-renders the full
      // killswitch shape (enabled, threshold, per-account overrides).
      const after = context.settings.get()
      return {
        text: 'Killswitch updated',
        knobs: {
          enabled: after.killswitch.enabled,
          minimum_remaining_percent: after.killswitch.minimum_remaining_percent,
          accounts: after.killswitch.accounts ?? {},
          timeoutMs: 2_000,
        },
      }
    }
    case 'antigravity-dump': {
      const action = parseGeminiDumpCommandAction(request.arguments)
      if (action.type === 'enable') setGeminiDumpEnabled(true)
      else if (action.type === 'disable') setGeminiDumpEnabled(false)
      return {
        text: executeGeminiDumpCommand({
          argumentsText: request.arguments,
        }),
        knobs: { timeoutMs: 2_000 },
      }
    }
    case 'antigravity-logging': {
      const level = parseLoggingLevel(request.arguments)
      await context.settings.update((draft) => {
        draft.log_level = level
      })
      return {
        text: `Logging level set to ${level}`,
        knobs: { log_level: level, timeoutMs: 2_000 },
      }
    }
    default: {
      const exhaustiveCheck: never = request.command
      throw new Error(`Unknown command ${exhaustiveCheck as string}`)
    }
  }
}

/**
 * Build a sidebar refresher bound to the supplied account-snapshot provider.
 * The plugin entry passes `lifecycle.getAccountManager()`'s snapshot getter so
 * every `/antigravity-*` apply that mutates persistent state also bumps the
 * sidebar's `checkedAt`. The refresher is best-effort: a lock-contention
 * error or missing manager is swallowed by the caller.
 */
export function createSidebarRefresher(
  getAccounts: () => Array<{
    index: number
    label?: string
    enabled?: boolean
    coolingDownUntil?: number
    cachedQuota?: {
      gemini?: { remainingFraction?: number; resetTime?: string }
      'non-gemini'?: { remainingFraction?: number; resetTime?: string }
    }
  }> | null,
): (accounts?: CommandAccountRow[]) => Promise<void> {
  return async (dialogAccounts) => {
    const accounts = dialogAccounts
      ? dialogAccounts.map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          coolingDownUntil: undefined,
          cachedQuota: Object.fromEntries(
            entry.quota.flatMap((group) => {
              if (group.remainingPercent == null) return []
              return [
                [
                  group.key,
                  {
                    remainingFraction: group.remainingPercent / 100,
                    ...(group.resetAt === undefined
                      ? {}
                      : { resetTime: new Date(group.resetAt).toISOString() }),
                  },
                ],
              ]
            }),
          ),
        }))
      : getAccounts()
    if (!accounts || accounts.length === 0) return
    try {
      await setSidebarMachineState(
        buildSidebarMachineStateFromAccounts(
          accounts.map((entry) => ({
            index: entry.index,
            label: entry.label,
            enabled: entry.enabled,
            coolingDownUntil: entry.coolingDownUntil,
            cachedQuota: entry.cachedQuota,
          })),
        ),
      )
    } catch {
      // Sidebar refresh is best-effort; the next command or quota refresh
      // will publish the current account snapshot.
    }
  }
}

/**
 * Optional handle for the host connection state. Tests inject a stub
 * to force the connected/disconnected branch; production callers let
 * the default fall through to the singleton `isTuiConnected` from
 * `rpc/notifications`, which reports "disconnected" until a TUI drain
 * has landed in the last `CONNECTION_TTL_MS` window.
 */
export interface CommandConnectionState {
  isTuiConnected(sessionId?: string): boolean
}

/**
 * Hook the host's `command.execute.before` to the modal commands.
 *
 * When a slash command is invoked, we push a notification onto the
 * RPC queue and abort the normal prompt with the same handled
 * sentinel the legacy `/gemini-dump` flow already uses.
 *
 * The `sendIgnoredMessage` fallback only fires when no TUI is
 * listening — the only path that actually consumes the queued
 * message. With a live TUI, push alone is enough; double-sending
 * would otherwise render the command text as a visible chat message
 * alongside the dialog the TUI renders.
 */
export function createCommandExecuteBefore(
  client: PluginClient,
  settings: OperatorSettingsController,
  pushNotification: (
    payload: Awaited<ReturnType<typeof buildDialogPayload>>,
    sessionId?: string,
  ) => void,
  commandData?: CommandDataService,
  connectionState: CommandConnectionState = {
    isTuiConnected: defaultIsTuiConnected,
  },
): PluginResult['command.execute.before'] {
  const context: CommandContext = {
    client,
    sessionID: '',
    settings,
    commandData,
  }
  return async (input) => {
    const command = input.command
    if (command === GEMINI_DUMP_COMMAND_NAME) {
      const action = parseGeminiDumpCommandAction(input.arguments)
      if (action.type === 'enable' || action.type === 'disable') {
        setGeminiDumpEnabled(action.type === 'enable')
      }
      if (!connectionState.isTuiConnected(input.sessionID)) {
        await sendIgnoredMessage(
          client,
          input.sessionID,
          executeGeminiDumpCommand({ argumentsText: input.arguments }),
        )
      }
      throwHandledCommandSentinel()
    }
    if (
      command !== ANTIGRAVITY_QUOTA_COMMAND_NAME &&
      command !== ANTIGRAVITY_ACCOUNT_COMMAND_NAME &&
      command !== ANTIGRAVITY_ROUTING_COMMAND_NAME &&
      command !== ANTIGRAVITY_KILLSWITCH_COMMAND_NAME &&
      command !== ANTIGRAVITY_DUMP_COMMAND_NAME &&
      command !== ANTIGRAVITY_LOGGING_COMMAND_NAME
    ) {
      return
    }
    const payload = await buildDialogPayload(command, input.arguments, {
      ...context,
      sessionID: input.sessionID,
    })
    pushNotification(payload, input.sessionID)
    if (!connectionState.isTuiConnected(input.sessionID)) {
      await sendIgnoredMessage(client, input.sessionID, payload.text)
    }
    throwHandledCommandSentinel()
  }
}

/**
 * Backward-compat wrapper that constructs a no-settings `command.execute.before`
 * for tests that don't care about the operator settings controller. Production
 * code wires the real controller via `createAntigravityPlugin`.
 */
export function createCommandExecuteBeforeForClient(
  client: PluginClient,
  commandData?: CommandDataService,
): PluginResult['command.execute.before'] {
  return createCommandExecuteBefore(
    client,
    createOperatorSettingsController({
      projectConfigPath: '/dev/null',
      userConfigPath: '/dev/null',
    }),
    () => undefined,
    commandData,
  )
}
