import type { ApplyRequest, ApplyResult, RpcNotification } from './notifications.js';
import { type DiscoverPortFileOptions, discoverPortFile, type PortFileEntry } from './port-file.js';
export interface RpcClient {
    pending: (lastReceivedId: number, sessionId?: string, timeoutMs?: number) => Promise<RpcNotification[]>;
    apply: (request: ApplyRequest, timeoutMs?: number) => Promise<ApplyResult>;
}
export declare const DEFAULT_RPC_TIMEOUT_MS = 2000;
/**
 * `exactPid`: every call goes only to the expected PID's server. With no
 * such server (or no expected PID) a call returns its fallback without
 * opening a socket, on every call. Off by default, when a call falls back to
 * the newest live server.
 */
export type RpcClientOptions = DiscoverPortFileOptions & {
    /** Internal discovery-count seam. */
    discover?: typeof discoverPortFile;
};
/**
 * A client for the server in `dir`, preferring `expectedPid`'s.
 *
 * `onSelected` reports the first selection: it is told which entry (or null)
 * discovery chose, until one call of it returns normally. It is a report, not
 * a gate: an observer that throws rejects that call before any request is
 * sent and is asked again on the next call, but nothing stops a later call
 * once an observer has returned. A caller that must never reach another
 * server passes `{ exactPid: true }`. Validated selections are shared by
 * directory, expected PID and exactPid until their file identity changes or a
 * connect/auth/stale-server failure triggers one rediscovery in the same call.
 */
export declare function createRpcClient(dir: string, expectedPid?: number, onSelected?: (entry: PortFileEntry | null) => void, options?: RpcClientOptions): RpcClient;
