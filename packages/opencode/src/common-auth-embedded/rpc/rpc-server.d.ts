import type { RpcLogChannel } from './index.js';
import { type ApplyRequest, type ApplyResult, type RpcNotification } from './notifications.js';
export interface RpcServerHandle {
    port: number;
    token: string;
    stop: () => Promise<void>;
}
export interface RpcServerOptions {
    dir: string;
    log?: RpcLogChannel;
    isManagedDir: (name: string) => boolean;
    secureDir?: boolean;
    sweepRoot?: string;
    drain: (lastReceivedId: number, sessionId?: string) => RpcNotification[];
    drainAsync?: never;
    /** Replace default cursor parsing with plugin policy over the raw JSON value. */
    parsePending?: (params: unknown) => {
        lastReceivedId: number;
        sessionId?: string;
    };
    apply: (request: ApplyRequest) => Promise<ApplyResult>;
    /**
     * Refuse a `pending-notifications` drain whose `sessionId` is absent, not a
     * string or empty, with 400 and without calling `drain`. Pair it with a
     * strict notification scope (`requireSession`) so neither the wire nor
     * the queue can hand one session's notifications to another. Off by
     * default, when a session-less drain is passed to `drain` as undefined.
     */
    requireSession?: boolean;
    timeoutMs?: number;
    receiptTimeoutMs?: number;
    /**
     * Answer an `apply` call whose handler is still running after this many
     * milliseconds with 504 `{error: 'handler deadline exceeded'}`. The handler
     * is not cancelled; its eventual result is discarded. Unset by default,
     * when only the socket inactivity timeout (`timeoutMs`) bounds a handler,
     * by destroying the socket.
     */
    applyDeadlineMs?: number;
}
/** Async-only options keep the existing synchronous drain type unchanged. */
export interface RpcServerAsyncOptions extends Omit<RpcServerOptions, 'drain' | 'drainAsync'> {
    drain?: never;
    drainAsync: (lastReceivedId: number, sessionId?: string) => Promise<RpcNotification[]>;
}
/**
 * Thrown by an `apply`, `drain`, or `parsePending` handler to refuse a request with a 4xx
 * status. Its message is sent on the wire as `{error: message}`, so it must
 * be written for the client and never quote a credential. Any other error an
 * apply/drain handler throws answers 500 with a fixed code; other parser
 * errors answer 400 invalid params. Async drain failures always answer 500.
 */
export declare class RpcRequestError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare function startRpcServer(options: RpcServerAsyncOptions): Promise<RpcServerHandle>;
export declare function startRpcServer(options: RpcServerOptions): Promise<RpcServerHandle>;
