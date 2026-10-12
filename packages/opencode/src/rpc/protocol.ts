/**
 * Wire shapes of the OpenCode 1 RPC between this plugin's server and the TUI
 * running in the same OpenCode process. The RPC is private to that process:
 * the server listens only on 127.0.0.1 and accepts only requests that carry
 * the bearer token from the owner-only port file it writes for its own
 * process ID.
 *
 * The RPC carries the shared `/antigravity` command menu of common-auth's
 * public `./commands` entry: the TUI sends back a `CommandApplyRequest` on
 * `/rpc/apply` and receives a `CommandApplyResult`; queued notifications carry
 * either the menu that opens the drawer (`CommandDialogPayload`) or a toast
 * (`MenuNotifyPayload`).
 *
 * Every library type here is a type-only import, so it disappears from the
 * compiled JavaScript: the TUI may import this module without loading the
 * commands module or anything it depends on (store, logger, credentials).
 */
import type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  NotifyKind,
} from '../common-auth-embedded/commands/index.js'

export type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  NotifyKind,
}

/**
 * A message for the user that does not open the drawer. `command` names the
 * slash command that sent it; the TUI shows `notify` as a toast.
 */
export interface MenuNotifyPayload {
  command: string
  notify: {
    message: string
    kind: NotifyKind
  }
}

/**
 * The payload of one queued notification: the menu that opens the drawer
 * (`CommandDialogPayload`) or a message shown as a toast
 * (`MenuNotifyPayload`).
 */
export type RpcNotificationPayload = CommandDialogPayload | MenuNotifyPayload

/**
 * The envelope `{id, payload, sessionId?}` of one queued notification, as
 * `/rpc/pending-notifications` returns it inside `{ messages: [...] }`.
 *
 * `id` comes from one counter shared by every session of this server
 * process: it starts at 1 and grows by one per notification. The TUI sends
 * the last `id` it received back as `lastReceivedId` and then receives only
 * notifications with a larger `id`. A notification with `sessionId` goes
 * only to that session; one without it is a broadcast that every session
 * receives.
 */
export interface RpcNotification {
  id: number
  payload: RpcNotificationPayload
  sessionId?: string
}
