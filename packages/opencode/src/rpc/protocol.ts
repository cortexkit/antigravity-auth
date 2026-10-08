/**
 * Wire shapes of the private OpenCode 1 RPC between this plugin's server and
 * the TUI running in the same OpenCode process.
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

/** What one queued notification carries. */
export type RpcNotificationPayload = CommandDialogPayload | MenuNotifyPayload

/**
 * One queued notification as `/rpc/pending-notifications` returns it inside
 * `{ messages: [...] }`. `id` grows by one per notification and is the
 * cursor the TUI sends back as `lastReceivedId`. A notification without
 * `sessionId` is a broadcast that every session receives.
 */
export interface RpcNotification {
  id: number
  payload: RpcNotificationPayload
  sessionId?: string
}
