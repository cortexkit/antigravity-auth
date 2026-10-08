import type * as Commands from '../common-auth-embedded/commands/index.js'
import {
  RpcRequestError,
  type RpcServerAsyncOptions,
  startRpcServer as startPublicRpcServer,
} from '../common-auth-embedded/rpc/index.js'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  RpcNotification,
} from './protocol'

export interface StartRpcServerOptions {
  dir: string
  /**
   * The `parseApplyRequest` of the common-auth commands module whose menu
   * `apply` answers. The caller passes the function from the same loaded
   * module it built the menu with, so this server neither loads a second
   * copy of the commands module nor keeps its own copy of the request
   * schema. Every `/rpc/apply` body goes through it before `apply` runs; a
   * body it does not accept is answered 400 and `apply` is not called.
   */
  parseApplyRequest: typeof Commands.parseApplyRequest
  /** Runs one parsed menu action and returns the refreshed menu. */
  apply(
    request: CommandApplyRequest,
  ): Promise<CommandApplyResult> | CommandApplyResult
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

// The public RPC server sends whatever JSON its handlers return, but declares
// the handler types with the request and notification shapes of the older
// per-command dialogs. These two aliases are where the menu shapes above are
// handed to it.
type PublicApply = RpcServerAsyncOptions['apply']
type PublicDrain = RpcServerAsyncOptions['drainAsync']

export async function startRpcServer(
  options: StartRpcServerOptions,
): Promise<RpcServerHandle> {
  const parseApply = (value: unknown): CommandApplyRequest => {
    const request = options.parseApplyRequest(value)
    if (request === undefined) {
      throw new RpcRequestError(400, 'Invalid apply request')
    }
    return request
  }
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
    apply: (async (request: unknown) =>
      options.apply(parseApply(request))) as unknown as PublicApply,
    // Use only the asynchronous overload, including for synchronous producers.
    drainAsync: (async (cursor: number, session?: string) =>
      Promise.resolve(
        options.drain(cursor, session),
      )) as unknown as PublicDrain,
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
