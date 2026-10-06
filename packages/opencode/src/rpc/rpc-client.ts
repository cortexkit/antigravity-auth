// The client-only public root keeps server/writer code out of the TUI graph.
import { createRpcClient as createPublicRpcClient } from '../common-auth-embedded/rpc/client.js'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  RpcNotification,
} from './protocol'

const DEFAULT_TIMEOUT_MS = 2_000

const APPLY_FALLBACK: ApplyResult = { text: 'apply failed', knobs: {} }
const PENDING_FALLBACK: RpcNotification[] = []

export interface RpcRequestOptions {
  timeoutMs?: number
}

export interface RpcClient {
  apply(
    request: ApplyRequest,
    options?: RpcRequestOptions,
  ): Promise<ApplyResult>
  pendingNotifications(
    lastReceivedId: number,
    sessionId?: string,
    options?: RpcRequestOptions,
  ): Promise<RpcNotification[]>
}

export function createRpcClient(dir: string, expectedPid?: number): RpcClient {
  const client = createPublicRpcClient(dir, expectedPid, undefined, {
    exactPid: true,
  })
  return {
    async apply(request, options) {
      try {
        const result: unknown = await client.apply(
          request,
          options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        return isApplyResult(result) ? result : APPLY_FALLBACK
      } catch {
        return APPLY_FALLBACK
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

function isApplyResult(value: unknown): value is ApplyResult {
  return (
    isRecord(value) && typeof value.text === 'string' && isRecord(value.knobs)
  )
}

function isCommand(value: unknown): value is CommandModalName {
  return (
    value === 'antigravity-quota' ||
    value === 'antigravity-account' ||
    value === 'antigravity-routing' ||
    value === 'antigravity-killswitch' ||
    value === 'antigravity-dump' ||
    value === 'antigravity-logging'
  )
}

function isNotification(value: unknown): value is RpcNotification {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    value.type === 'open-dialog' &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    isRecord(value.payload) &&
    isApplyResult(value.payload) &&
    isCommand(value.payload.command)
  )
}
