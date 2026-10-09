// This client-only public entry point keeps server and writer modules out of
// the TUI's dependency graph. This file imports nothing else, not even types:
// the TUI build copies every relative module a file imports, type-only ones
// included, so importing `./protocol` here would bring the commands, store
// and fs modules into the TUI. The client is a raw JSON transport; the
// renderer builds and validates the menu shapes, and the server parses every
// apply request with the commands module before acting on it.
import { createRpcClient as createPublicRpcClient } from '../common-auth-embedded/rpc/client.js'

const DEFAULT_TIMEOUT_MS = 2_000

const PENDING_FALLBACK: ReceivedNotification[] = []

// The public client sends the fields of any object as the request body, but
// types `apply`'s request as the older per-command dialog request
// `{command, arguments, sessionId?}`.
type PublicApplyRequest = Parameters<
  ReturnType<typeof createPublicRpcClient>['apply']
>[0]

export interface RpcRequestOptions {
  timeoutMs?: number
}

/**
 * The wire envelope of one queued notification, after this client's check:
 * exactly `{id, payload, sessionId?}`, with `payload` a JSON object. `payload` is still unchecked JSON; the
 * renderer must validate it as a menu or notify payload before showing
 * anything from it.
 */
export interface ReceivedNotification {
  id: number
  payload: object
  sessionId?: string
}

export interface RpcClient {
  /**
   * Sends one menu action, given as the JSON object the renderer built (a
   * `CommandApplyRequest`); the server parses it and refuses anything else
   * with 400. Resolves the server's answer as unchecked JSON, which the
   * renderer must validate as a `CommandApplyResult` before using it, or
   * `undefined` when there was no answer object: no server published
   * for `expectedPid` (the process ID of the OpenCode process hosting the
   * server), a refusal or other non-2xx status, a timeout, or a body that is
   * not a JSON object.
   */
  apply(
    request: unknown,
    options?: RpcRequestOptions,
  ): Promise<object | undefined>
  /**
   * Notifications after `lastReceivedId`. Resolves `[]` when the call fails
   * or when any message in the answer has a malformed envelope.
   */
  pendingNotifications(
    lastReceivedId: number,
    sessionId?: string,
    options?: RpcRequestOptions,
  ): Promise<ReceivedNotification[]>
}

export function createRpcClient(dir: string, expectedPid?: number): RpcClient {
  const client = createPublicRpcClient(dir, expectedPid, undefined, {
    exactPid: true,
  })
  return {
    async apply(request, options) {
      try {
        const result: unknown = await client.apply(
          request as PublicApplyRequest,
          options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        return isRecord(result) && !isPublicApplyFailure(result)
          ? result
          : undefined
      } catch {
        return undefined
      }
    },
    async pendingNotifications(lastReceivedId, sessionId, options) {
      try {
        const messages: unknown = await client.pending(
          lastReceivedId,
          sessionId,
          options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        return Array.isArray(messages) && messages.every(isNotification)
          ? messages
          : PENDING_FALLBACK
      } catch {
        return PENDING_FALLBACK
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// When an apply gets no answer (no server for the PID, a non-2xx status, a
// timeout or an unparseable body), the public client resolves the fixed
// object `{text: 'apply failed', knobs: {}}` instead of a server answer: the
// failure result of the older per-command dialogs, whose results were
// `{text, knobs}`. A menu result always carries `command`, `ok` and `menu`,
// so it cannot match.
function isPublicApplyFailure(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    value.text === 'apply failed' &&
    isRecord(value.knobs) &&
    Object.keys(value.knobs).length === 0
  )
}

const ENVELOPE_KEYS = new Set(['id', 'payload', 'sessionId'])

// Checks only the envelope: exactly the keys `id`, `payload` and optional
// `sessionId`. Any other key, such as the `type: 'open-dialog'` field of the
// older per-command dialog notifications, refuses the message.
function isNotification(value: unknown): value is ReceivedNotification {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ENVELOPE_KEYS.has(key)) &&
    typeof value.id === 'number' &&
    Number.isSafeInteger(value.id) &&
    value.id >= 1 &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    isRecord(value.payload)
  )
}
