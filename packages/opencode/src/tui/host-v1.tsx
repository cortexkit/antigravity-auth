/** @jsxImportSource @opentui/solid */

/**
 * OpenCode 1 adapter for the shared `/antigravity` drawer.
 *
 * Two jobs, both specific to OpenCode 1:
 *
 * - Transport: the plugin's own OpenCode 1 RPC client (`rpc/rpc-client`),
 *   which talks only to the loopback server published for this process's
 *   PID and checks each queued notification's envelope (`id`, `payload`,
 *   `sessionId`). The payloads and every apply answer are still unchecked
 *   JSON there; this adapter validates them with the host-api parsers before
 *   the drawer sees anything.
 * - Dialogs: `MenuUi` over the host's `DialogSelect`, `DialogPrompt`,
 *   `DialogConfirm` and `DialogAlert`, mounted through `dialog.replace`.
 *
 * The sidebar keeps reading the redacted sidebar snapshot file in
 * `tui.tsx`; nothing here reads account storage, tokens or OAuth state.
 */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { createRpcClient, type RpcClient } from '../rpc/rpc-client'
import { MenuRefusedError, openAntigravityMenu } from './command-dialogs'
import type { TuiLogger } from './file-logger'
import {
  type MenuApplyRequest,
  type MenuApplyResult,
  type MenuUi,
  parseMenuApplyResult,
  parseMenuDialogPayload,
  parseMenuNotifyPayload,
} from './host-api'

/**
 * An apply can start an OAuth sign-in or check quota for every account, so
 * it gets the long timeout the account-add flow always had.
 */
export const V1_APPLY_TIMEOUT_MS = 120_000

/** One queued notification as the OpenCode 1 RPC returns it. */
export interface V1Notification {
  readonly id: number
  readonly payload: unknown
  readonly sessionId?: string
}

export interface V1MenuTransport {
  pending(
    cursor: number,
    sessionId: string | undefined,
  ): Promise<V1Notification[]>
  apply(
    request: MenuApplyRequest,
    sessionId: string | undefined,
  ): Promise<MenuApplyResult>
}

/**
 * Raised when an apply got no answer object: no server for this process,
 * a refusal or other non-2xx status, a timeout, or a body that is not JSON.
 */
export class V1TransportError extends Error {
  constructor() {
    super('Antigravity RPC gave no answer')
    this.name = 'V1TransportError'
  }
}

/**
 * The drawer's transport over the OpenCode 1 RPC client for the server in
 * `dir` belonging to process `pid` (exact PID; no fallback to another
 * process's server). Tests pass a client of their own.
 */
export function createV1MenuTransport(
  dir: string,
  pid: number,
  client: RpcClient = createRpcClient(dir, pid),
): V1MenuTransport {
  return {
    pending: (cursor, sessionId) =>
      client.pendingNotifications(cursor, sessionId),
    async apply(request, sessionId) {
      const raw = await client.apply(
        { ...request, ...(sessionId === undefined ? {} : { sessionId }) },
        { timeoutMs: V1_APPLY_TIMEOUT_MS },
      )
      if (raw === undefined) throw new V1TransportError()
      const parsed = parseMenuApplyResult(raw)
      if (!parsed.ok) throw new MenuRefusedError(parsed.issues)
      return parsed.value
    },
  }
}

/** `MenuUi` over the OpenCode 1 dialog components. */
export function createV1MenuUi(api: TuiPluginApi): MenuUi {
  return {
    select(input) {
      return new Promise((resolve) => {
        const DialogSelect = api.ui.DialogSelect<string>
        let settled = false
        const settle = (value: string | undefined) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(
          () => (
            <DialogSelect
              title={input.title}
              options={input.options.map((option) => ({ ...option }))}
              {...(input.current === undefined
                ? {}
                : { current: input.current })}
              onSelect={(option) => settle(String(option.value))}
            />
          ),
          () => settle(undefined),
        )
      })
    },
    prompt(input) {
      return new Promise((resolve) => {
        const DialogPrompt = api.ui.DialogPrompt
        let settled = false
        const settle = (value: string | undefined) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const description = input.description
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(
          () => (
            <DialogPrompt
              title={input.title}
              {...(description
                ? { description: () => <text>{description}</text> }
                : {})}
              placeholder={input.placeholder ?? ''}
              value={input.value ?? ''}
              onConfirm={(value: string) => settle(value)}
              onCancel={() => settle(undefined)}
            />
          ),
          () => settle(undefined),
        )
      })
    },
    confirm(input) {
      return new Promise((resolve) => {
        const DialogConfirm = api.ui.DialogConfirm
        let settled = false
        const settle = (value: boolean) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(
          () => (
            <DialogConfirm
              title={input.title}
              message={input.message}
              onConfirm={() => settle(true)}
              onCancel={() => settle(false)}
            />
          ),
          () => settle(false),
        )
      })
    },
    alert(input) {
      return new Promise((resolve) => {
        const DialogAlert = api.ui.DialogAlert
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          resolve()
        }
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(
          () => (
            <DialogAlert
              title={input.title}
              message={input.message}
              onConfirm={settle}
            />
          ),
          settle,
        )
      })
    },
    toast(message, kind = 'info') {
      api.ui.toast({ message, variant: kind })
    },
    clear() {
      api.ui.dialog.clear()
    },
  }
}

/**
 * Handles one notification: a menu payload opens the drawer, a notify
 * payload is a toast, anything else (including the retired per-command
 * dialog payloads) is refused with a visible toast and a log line naming
 * only the failing fields.
 */
export function dispatchV1Notification(
  api: TuiPluginApi,
  transport: V1MenuTransport,
  notification: V1Notification,
  logger: TuiLogger,
): void {
  const menu = parseMenuDialogPayload(notification.payload)
  if (menu.ok) {
    const sessionId = notification.sessionId
    void openAntigravityMenu(
      {
        ui: createV1MenuUi(api),
        apply: (request) => transport.apply(request, sessionId),
        copy: (text) => api.renderer.copyToClipboardOSC52(text),
        onError: (message, detail) => logger.warn(message, detail),
      },
      menu.value,
    ).catch((error: unknown) => {
      logger.warn('menu-drawer-failed', {
        error: error instanceof Error ? error.name : typeof error,
      })
    })
    return
  }
  const notify = parseMenuNotifyPayload(notification.payload)
  if (notify.ok) {
    api.ui.toast({
      message: notify.value.notify.message,
      variant: notify.value.notify.kind,
    })
    return
  }
  logger.warn('menu-payload-refused', { issues: menu.issues })
  api.ui.toast({
    message:
      'Antigravity sent a dialog this TUI does not understand; update the plugin so server and TUI match.',
    variant: 'error',
  })
}
