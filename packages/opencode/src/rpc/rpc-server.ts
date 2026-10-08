import {
  RpcRequestError,
  startRpcServer as startPublicRpcServer,
} from '../common-auth-embedded/rpc/index.js'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  RpcNotification,
} from './protocol'

export interface StartRpcServerOptions {
  dir: string
  apply(request: ApplyRequest): Promise<ApplyResult> | ApplyResult
  drain(
    lastReceivedId: number,
    sessionId?: string,
  ): Promise<RpcNotification[]> | RpcNotification[]
}

export interface RpcServerHandle {
  port: number
  token: string
  stop(): Promise<void>
}

export async function startRpcServer(
  options: StartRpcServerOptions,
): Promise<RpcServerHandle> {
  const server = await startPublicRpcServer({
    dir: options.dir,
    secureDir: true,
    // Do not set sweepRoot: this adapter manages no other project directories
    // or their RPC files.
    isManagedDir: () => false,
    receiptTimeoutMs: 2_000,
    applyDeadlineMs: 120_000,
    timeoutMs: 0,
    parsePending,
    apply: async (request) => options.apply(parseApply(request)),
    // Use only the asynchronous overload, including for synchronous producers.
    drainAsync: async (cursor, session) =>
      Promise.resolve(options.drain(cursor, session)),
  })
  let stopping: Promise<void> | undefined
  return {
    port: server.port,
    token: server.token,
    stop() {
      stopping ??= server.stop()
      return stopping
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function parseApply(value: unknown): ApplyRequest {
  if (
    !isRecord(value) ||
    !isCommand(value.command) ||
    typeof value.arguments !== 'string' ||
    (value.sessionId !== undefined && typeof value.sessionId !== 'string')
  ) {
    throw new RpcRequestError(400, 'Invalid apply request')
  }
  return {
    command: value.command,
    arguments: value.arguments,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  }
}

function parsePending(value: unknown): {
  lastReceivedId: number
  sessionId?: string
} {
  if (
    !isRecord(value) ||
    typeof value.lastReceivedId !== 'number' ||
    !Number.isSafeInteger(value.lastReceivedId) ||
    value.lastReceivedId < 0 ||
    (value.sessionId !== undefined && typeof value.sessionId !== 'string')
  ) {
    throw new RpcRequestError(400, 'Invalid pending-notifications request')
  }
  return {
    lastReceivedId: value.lastReceivedId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  }
}
