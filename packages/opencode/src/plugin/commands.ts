/**
 * The single `/antigravity` slash command of OpenCode 1.
 *
 * The command opens the shared Antigravity menu built by the core
 * `createAntigravityCommandMenu` over the location's account store: the
 * server pushes the menu payload to the TUI over the private RPC queue, and
 * the TUI sends each chosen action back to the RPC server, which hands it to
 * the same menu's `apply`. The menu (common-auth's public `./commands`
 * entry) owns confirmation, redaction, per-invocation isolation and action
 * dispatch; this module supplies the OpenCode-specific sections (settings,
 * diagnostics, sign-in) and the host hook.
 */

import {
  ANTIGRAVITY_MENU_COMMAND,
  type AntigravityMenuAccounts,
  type AntigravityRepositoryMenuOptions,
  type CommonAuthCommandsModule,
  createAntigravityCommandMenu,
  loadCommonAuthCommands,
} from '@cortexkit/antigravity-auth-core'
import { isTuiConnected as defaultIsTuiConnected } from '../rpc/notifications'
import type { NotifyKind, RpcNotificationPayload } from '../rpc/protocol'
import type { AccountCommandOAuthService } from './account-command-oauth'
import { diagnosticsMenuSection, operatorMenuSettings } from './command-apply'
import type {
  OperatorSettings,
  OperatorSettingsController,
} from './operator-settings'
import { resolvePromptContext } from './prompt-context'
import type { PluginClient, PluginResult } from './types'

/** The one slash command this plugin registers. */
export { ANTIGRAVITY_MENU_COMMAND }

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

/** Queues one RPC notification for a session (or every session). */
export type PushMenuNotification = (
  payload: RpcNotificationPayload,
  sessionId?: string,
) => void

/**
 * The menu invocation for one session: the menu's notifications become
 * toast notifications for that session. common-auth copies these fields
 * when a call starts, so later work reports to the session that began it.
 */
export function menuInvocation(
  push: PushMenuNotification,
  sessionId: string | undefined,
): { sessionId?: string; notify(message: string, kind?: NotifyKind): void } {
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    notify(message, kind) {
      push(
        {
          command: ANTIGRAVITY_MENU_COMMAND,
          notify: { message, kind: kind ?? 'info' },
        },
        sessionId,
      )
    },
  }
}

/**
 * What opening the menu yields for a session: the menu payload, or the
 * reason the menu cannot be shown (for example a location whose accounts
 * have not been migrated to the account store yet).
 */
export type MenuOpening =
  | { readonly kind: 'menu'; readonly payload: RpcNotificationPayload }
  | { readonly kind: 'unavailable'; readonly message: string }

export interface CommandConnectionState {
  isTuiConnected(sessionId?: string): boolean
}

/**
 * The host's `command.execute.before` for `/antigravity`: open the menu,
 * queue its payload for the TUI, and stop the host from sending the command
 * text as a prompt. Without a TUI listening, the outcome is written into the
 * session as an ignored message instead. Every other command is left alone.
 */
export function createAntigravityCommandExecuteBefore(options: {
  readonly client: PluginClient
  readonly open: (sessionId: string) => Promise<MenuOpening>
  readonly push: PushMenuNotification
  readonly connection?: CommandConnectionState
}): PluginResult['command.execute.before'] {
  const connection = options.connection ?? {
    isTuiConnected: defaultIsTuiConnected,
  }
  return async (input) => {
    if (input.command !== ANTIGRAVITY_MENU_COMMAND) return
    const opening = await options.open(input.sessionID)
    if (opening.kind === 'menu') {
      options.push(opening.payload, input.sessionID)
    } else {
      options.push(
        {
          command: ANTIGRAVITY_MENU_COMMAND,
          notify: { message: opening.message, kind: 'warning' },
        },
        input.sessionID,
      )
    }
    if (!connection.isTuiConnected(input.sessionID)) {
      await sendIgnoredMessage(
        options.client,
        input.sessionID,
        opening.kind === 'menu'
          ? 'The Antigravity menu opens in the OpenCode terminal interface.'
          : opening.message,
      )
    }
    throwHandledCommandSentinel()
  }
}

// ---------------------------------------------------------------------------
// Menu sections
// ---------------------------------------------------------------------------

type CommonAuthMenuOptions = Parameters<
  CommonAuthCommandsModule['createCommandMenu']
>[0]
type MenuPluginExtraSection = NonNullable<
  CommonAuthMenuOptions['extras']
>[number]

/**
 * The Sign in section: the OpenCode 1 OAuth add flow. Starting returns the
 * authorization URL for this session; finishing takes the redirect URL (or
 * its code) the browser ends on, and the account service admits the login
 * into the account store.
 */
export function signInMenuSection(
  oauth: Pick<AccountCommandOAuthService, 'start' | 'finish'>,
): MenuPluginExtraSection {
  return {
    id: 'sign-in',
    title: 'Sign in',
    build() {
      return {
        lines: [
          'Start a sign-in, open the link, then paste the address the browser ends on.',
        ],
        actions: [
          {
            id: 'start',
            label: 'Start sign-in',
            run: async ({ invocation }) => {
              const sessionId = invocation.sessionId
              if (sessionId === undefined)
                return {
                  ok: false,
                  text: 'Sign-in needs a session; run /antigravity from one.',
                  code: 'refused',
                }
              const started = await oauth.start(sessionId)
              return `Open this link to sign in, then choose Finish sign-in:\n${started.url}`
            },
          },
          {
            id: 'finish',
            label: 'Finish sign-in',
            knobs: [
              {
                kind: 'text',
                id: 'callback',
                label: 'Address or code from the browser',
                masked: true,
                required: true,
              },
              { kind: 'text', id: 'label', label: 'Label (optional)' },
            ],
            run: async ({ values, invocation }) => {
              const sessionId = invocation.sessionId
              const callback = values.callback
              if (sessionId === undefined || typeof callback !== 'string')
                return {
                  ok: false,
                  text: 'Paste the address the browser ended on.',
                  code: 'invalid-input',
                }
              const label =
                typeof values.label === 'string' && values.label.trim() !== ''
                  ? values.label.trim()
                  : undefined
              const finished =
                label === undefined
                  ? await oauth.finish(sessionId, callback)
                  : await oauth.finish(sessionId, callback, label)
              return finished.text
            },
          },
        ],
      }
    },
  }
}

/**
 * The OpenCode 1 `/antigravity` menu over the account store, built with
 * the shared core factory in repository mode. The host registers it as
 * its one slash command and carries its payloads over its own RPC.
 */
export async function createOpenCodeAntigravityMenu(options: {
  readonly accounts: AntigravityMenuAccounts
  readonly settings: Pick<OperatorSettingsController, 'get' | 'update'>
  readonly dump: { isEnabled(): boolean; setEnabled(enabled: boolean): void }
  readonly applyLogLevel: (level: OperatorSettings['log_level']) => void
  readonly refreshQuota?: AntigravityRepositoryMenuOptions['refreshQuota']
  readonly login?: AntigravityRepositoryMenuOptions['login']
  /** The OAuth add flow, shown as the Sign in section. */
  readonly signIn?: Pick<AccountCommandOAuthService, 'start' | 'finish'>
  readonly commands?: CommonAuthCommandsModule
}): Promise<ReturnType<typeof createAntigravityCommandMenu>> {
  return createAntigravityCommandMenu({
    source: 'repository',
    commands: options.commands ?? (await loadCommonAuthCommands()),
    accounts: options.accounts,
    settings: operatorMenuSettings(options.settings),
    diagnostics: diagnosticsMenuSection(options),
    ...(options.refreshQuota ? { refreshQuota: options.refreshQuota } : {}),
    ...(options.login ? { login: options.login } : {}),
    ...(options.signIn ? { extras: [signInMenuSection(options.signIn)] } : {}),
  })
}
