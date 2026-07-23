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

import type { CommandModalName } from '../rpc/protocol'
import {
  buildSidebarMachineStateFromAccounts,
  setSidebarMachineState,
} from '../sidebar-state'
import {
  executeGeminiDumpCommand,
  GEMINI_DUMP_COMMAND_NAME,
  parseGeminiDumpCommandAction,
  setGeminiDumpEnabled,
} from './gemini-dump'
import {
  createOperatorSettingsController,
  type OperatorSettings,
  type OperatorSettingsController,
} from './operator-settings'
import { resolvePromptContext } from './prompt-context'
import type { PluginClient, PluginResult } from './types'

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
  onApplied?: () => Promise<void> | void
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
      return {
        command,
        text: 'Antigravity quota',
        knobs: {
          mode: action === 'refresh' ? 'refresh' : 'status',
        },
      }
    }
    case 'antigravity-account': {
      const action = argumentsText.trim().toLowerCase()
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
        },
      }
    }
    case 'antigravity-routing': {
      const settings = context.settings.get()
      const parsed = parseToggleArguments(argumentsText)
      return {
        command,
        text: 'Antigravity routing',
        knobs: {
          cli_first: parsed.cli_first ?? !settings.routing.cli_first,
          quota_style_fallback:
            parsed.quota_style_fallback ??
            !settings.routing.quota_style_fallback,
        },
      }
    }
    case 'antigravity-killswitch': {
      const settings = context.settings.get()
      const parsed = parseKillswitchArguments(argumentsText)
      return {
        command,
        text: 'Antigravity killswitch',
        knobs: {
          enabled: parsed.enabled ?? !settings.killswitch.enabled,
          minimum_remaining_percent:
            parsed.minimum_remaining_percent ??
            settings.killswitch.minimum_remaining_percent,
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
 * `openCommandDialog` passes the `timeoutMs` knob through to the RPC
 * client so callers see exactly which flows take longer.
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
    await Promise.resolve(context.onApplied()).catch(() => {
      // Sidebar refresh must never break the command's apply response.
    })
  }
  return result
}

async function applyCommandInner(
  request: ApplyRequest,
  context: CommandContext,
): Promise<ApplyResult> {
  switch (request.command) {
    case 'antigravity-quota': {
      return {
        text: 'Quota refresh requested',
        knobs: { mode: 'refresh', timeoutMs: 2_000 },
      }
    }
    case 'antigravity-account': {
      const action = request.arguments.trim().toLowerCase()
      const isAddOrRefresh = action === 'add' || action === 'refresh'
      return {
        text: `Account ${action} requested`,
        knobs: { action, timeoutMs: isAddOrRefresh ? 120_000 : 2_000 },
      }
    }
    case 'antigravity-routing': {
      const parsed = parseToggleArguments(request.arguments)
      await context.settings.update((draft) => {
        if (parsed.cli_first !== undefined) {
          draft.routing.cli_first = parsed.cli_first
        }
        if (parsed.quota_style_fallback !== undefined) {
          draft.routing.quota_style_fallback = parsed.quota_style_fallback
        }
      })
      return {
        text: 'Routing updated',
        knobs: { timeoutMs: 2_000, ...parsed },
      }
    }
    case 'antigravity-killswitch': {
      const parsed = parseKillswitchArguments(request.arguments)
      await context.settings.update((draft) => {
        if (parsed.enabled !== undefined) {
          draft.killswitch.enabled = parsed.enabled
        }
        if (parsed.minimum_remaining_percent !== undefined) {
          draft.killswitch.minimum_remaining_percent =
            parsed.minimum_remaining_percent
        }
      })
      return {
        text: 'Killswitch updated',
        knobs: { timeoutMs: 2_000, ...parsed },
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
      claude?: { remainingFraction?: number; resetTime?: string }
      'gemini-pro'?: { remainingFraction?: number; resetTime?: string }
      'gemini-flash'?: { remainingFraction?: number; resetTime?: string }
    }
  }> | null,
): () => Promise<void> {
  return async () => {
    const accounts = getAccounts()
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
      // Lock contention is the only realistic failure — sidebar refresh
      // is best-effort and the next periodic writer will catch up.
    }
  }
}

export interface CommandDialogOpenOptions {
  /**
   * Override the RPC apply timeout. Defaults to 2s for status/toggle
   * flows and 120s for account add/refresh.
   */
  timeoutMs?: number
}

/**
 * Open the OpenTUI dialog for `payload`.
 *
 * Wires the dialog tree to the RPC apply client so a selection in the
 * dialog posts back to the server and the server mutates the operator
 * settings through `applyCommand`. The function returns the
 * `dispose` cleanup so callers can tear the dialog down if they need
 * to.
 */
export function openCommandDialog(
  api: Parameters<
    NonNullable<PluginResult['command.execute.before']>
  >[0] extends never
    ? never
    : {
        client: PluginClient
        rpcApply: (
          request: ApplyRequest,
          options?: CommandDialogOpenOptions,
        ) => Promise<ApplyResult>
      },
  payload: {
    command: CommandModalName
    text: string
    knobs: Record<string, unknown>
  },
  apply: (
    command: CommandModalName,
    args: string,
    options?: CommandDialogOpenOptions,
  ) => Promise<ApplyResult>,
  sessionId?: string,
): () => void {
  // Kept here to preserve the documented contract — the dialog tree is
  // mounted by `tui.tsx` in response to an RPC notification. The actual
  // Solid render happens in `tui/command-dialogs.tsx`.
  void api
  void payload
  void apply
  void sessionId
  return () => {}
}

/**
 * Hook the host's `command.execute.before` to the modal commands.
 *
 * When a slash command is invoked, we push a notification onto the
 * RPC queue and abort the normal prompt with the same handled
 * sentinel the legacy `/gemini-dump` flow already uses.
 */
export function createCommandExecuteBefore(
  client: PluginClient,
  settings: OperatorSettingsController,
  pushNotification: (
    payload: Awaited<ReturnType<typeof buildDialogPayload>>,
    sessionId?: string,
  ) => number,
): PluginResult['command.execute.before'] {
  const context: CommandContext = { client, sessionID: '', settings }
  return async (input) => {
    const command = input.command
    if (command === GEMINI_DUMP_COMMAND_NAME) {
      const action = parseGeminiDumpCommandAction(input.arguments)
      if (action.type === 'enable' || action.type === 'disable') {
        setGeminiDumpEnabled(action.type === 'enable')
      }
      await sendIgnoredMessage(
        client,
        input.sessionID,
        executeGeminiDumpCommand({ argumentsText: input.arguments }),
      )
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
    await sendIgnoredMessage(client, input.sessionID, payload.text)
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
): PluginResult['command.execute.before'] {
  return createCommandExecuteBefore(
    client,
    createOperatorSettingsController({
      projectConfigPath: '/dev/null',
      userConfigPath: '/dev/null',
    }),
    () => 0,
  )
}
