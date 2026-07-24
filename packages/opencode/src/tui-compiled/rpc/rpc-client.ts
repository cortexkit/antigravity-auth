// Subpath import (not the barrel): this module ships into the TUI's
// compiled tree, which must not pull the credential-bearing barrel into
// the host's render path.
import { fetchWithActiveTimeout } from '@cortexkit/antigravity-auth-core/fetch-timeout'

import { discoverPortFile } from './port-file'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

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
  return {
    async apply(request, options) {
      const result = await post<ApplyResult>(
        dir,
        expectedPid,
        '/rpc/apply',
        request,
        options,
      )
      return result ?? APPLY_FALLBACK
    },
    async pendingNotifications(lastReceivedId, sessionId, options) {
      const result = await post<{ messages: RpcNotification[] }>(
        dir,
        expectedPid,
        '/rpc/pending-notifications',
        {
          lastReceivedId,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        options,
      )
      return result?.messages ?? PENDING_FALLBACK
    },
  }
}

async function post<T>(
  dir: string,
  expectedPid: number | undefined,
  path: string,
  body: unknown,
  options: RpcRequestOptions | undefined,
): Promise<T | null> {
  // Internal nullable — every RPC call site (apply, pending) must absorb a
  // missing/unreachable server gracefully. The TUI render path never
  // crashes because the server is dead; the user sees a fallback text and
  // a fresh poll retries the next tick.
  const entry = await discoverPortFileSafe(dir, expectedPid)
  if (!entry) return null

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const response = await fetchWithActiveTimeout(
      `http://127.0.0.1:${entry.port}${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${entry.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { timeoutMs },
    )
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

async function discoverPortFileSafe(
  dir: string,
  expectedPid: number | undefined,
): Promise<Awaited<ReturnType<typeof discoverPortFile>>> {
  try {
    return await discoverPortFile(dir, expectedPid)
  } catch {
    return null
  }
}
