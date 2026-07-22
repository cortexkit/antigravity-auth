import { fetchWithActiveTimeout } from '@cortexkit/antigravity-auth-core'

import { discoverPortFile } from './port-file'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

const DEFAULT_TIMEOUT_MS = 2_000

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
    apply(request, options) {
      return post<ApplyResult>(dir, expectedPid, '/rpc/apply', request, options)
    },
    pendingNotifications(lastReceivedId, sessionId, options) {
      return post<RpcNotification[]>(
        dir,
        expectedPid,
        '/rpc/pending-notifications',
        {
          lastReceivedId,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        options,
      )
    },
  }
}

async function post<T>(
  dir: string,
  expectedPid: number | undefined,
  path: string,
  body: unknown,
  options: RpcRequestOptions | undefined,
): Promise<T> {
  const entry = discoverPortFile(dir, expectedPid)
  if (!entry) {
    throw new Error('Antigravity RPC server is not available')
  }

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
    { timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  )

  if (!response.ok) {
    throw new Error(
      `Antigravity RPC request failed with status ${response.status}`,
    )
  }

  return (await response.json()) as T
}
