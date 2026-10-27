import type * as Commands from '../common-auth-embedded/commands/index.js'
import {
  RpcRequestError,
  type RpcServerAsyncOptions,
  startRpcServer as startPublicRpcServer,
  writePortFile,
} from '../common-auth-embedded/rpc/index.js'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  RpcNotification,
} from './protocol'

export interface StartRpcServerOptions {
  dir: string
  /**
   * Use the `parseApplyRequest` of the same common-auth commands module that
   * built the menu `apply` runs against. Passing it in means this server
   * loads no second copy of the commands module and keeps no request schema
   * of its own. Every `/rpc/apply` body goes through this parser before
   * `apply` runs; a body the parser refuses is answered 400 and `apply` is
   * not called.
   */
  parseApplyRequest: typeof Commands.parseApplyRequest
  /**
   * This plugin's package version, written into the port file. A process
   * deciding whether it may move the vault files out of OpenCode's config
   * folder (`version-fence.ts`) reads it; a port file without one counts as
   * an older plugin and holds the move. The caller passes it in so this
   * adapter imports nothing beyond the RPC library.
   */
  version: string
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

// The public RPC server sends whatever JSON its handlers return, but its
// handler types still use the older per-command dialog shapes: requests
// `{command, arguments, sessionId?}`, results `{text, knobs}` and
// notifications `{id, type: 'open-dialog', payload, sessionId?}`. The menu
// handlers below are cast to these two aliases to be passed to that server.
type PublicApply = RpcServerAsyncOptions['apply']
type PublicDrain = RpcServerAsyncOptions['drainAsync']

export async function startRpcServer(
  options: StartRpcServerOptions,
): Promise<RpcServerHandle> {
  // JavaScript callers get no compile-time check for this required option.
  // Without the guard, a missing parser would only surface as a failure on
  // the first apply, after the server had started and published its port
  // file. Refuse before anything is created instead.
  if (typeof options.parseApplyRequest !== 'function') {
    throw new TypeError(
      'startRpcServer needs parseApplyRequest from the common-auth commands module',
    )
  }
  // Without a version the port file would be unversioned, and every later
  // version check would treat this process as an older plugin. Refuse before
  // anything is created, like the parser check above.
  if (typeof options.version !== 'string' || options.version === '') {
    throw new TypeError("startRpcServer needs this plugin's package version")
  }
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
  try {
    // The shared server publishes `port-<pid>.json` without a version. Another
    // process deciding whether it may move the vault files out of OpenCode's
    // config folder (`version-fence.ts`) treats a live port file without a
    // current version as an older plugin and waits. Replace the record with
    // one that names this plugin's version before returning; if that fails,
    // stop the server rather than leave an unversioned record behind.
    const versioned = {
      port: server.port,
      token: server.token,
      pid: process.pid,
      version: options.version,
    }
    await writePortFile(options.dir, versioned, { secureDir: true })
  } catch (error) {
    await server.stop().catch(() => {})
    throw error
  }
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
