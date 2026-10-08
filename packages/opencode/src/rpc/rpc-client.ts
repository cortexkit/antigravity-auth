// This client-only public entry point keeps server and writer modules out of
// the TUI's dependency graph.
import { createRpcClient as createPublicRpcClient } from '../common-auth-embedded/rpc/client.js'
import type { CommandApplyRequest } from './protocol'

const DEFAULT_TIMEOUT_MS = 2_000

const PENDING_FALLBACK: ReceivedNotification[] = []

// The public client sends any JSON value as the request body, but declares
// `apply` with the request shape of the older per-command dialogs.
type PublicApplyRequest = Parameters<
  ReturnType<typeof createPublicRpcClient>['apply']
>[0]

export interface RpcRequestOptions {
  timeoutMs?: number
}

/**
 * One queued notification as received. Only the envelope has been checked
 * here; `payload` is still unchecked JSON, and the renderer must validate it
 * as a menu or notify payload before showing anything from it.
 */
export interface ReceivedNotification {
  id: number
  payload: object
  sessionId?: string
}

export interface RpcClient {
  /**
   * Sends one menu action. Resolves the server's answer as unchecked JSON,
   * which the renderer must validate as a `CommandApplyResult` before using
   * it, or `undefined` when there was no answer object: no server for the
   * expected PID, a refusal or other non-2xx status, a timeout, or a body
   * that is not a JSON object.
   */
  apply(
    request: CommandApplyRequest,
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
          request as unknown as PublicApplyRequest,
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
// timeout or an unparseable body), the public client resolves this fixed
// object from the older dialog protocol instead of a server answer. A menu
// result always carries `command`, `ok` and `menu`, so it cannot match.
function isPublicApplyFailure(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    value.text === 'apply failed' &&
    isRecord(value.knobs) &&
    Object.keys(value.knobs).length === 0
  )
}

const ENVELOPE_KEYS = new Set(['id', 'payload', 'sessionId'])

// Checks the queue's envelope only. A key outside it (such as the `type`
// field the older per-command dialog notifications carried) refuses the message.
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
