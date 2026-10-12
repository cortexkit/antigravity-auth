export interface ApplyRequest {
    command: string;
    arguments: string;
    sessionId?: string;
}
export interface ApplyResult {
    text: string;
    knobs: Record<string, unknown>;
}
export interface OpenDialogPayload {
    command: string;
    text: string;
    knobs: Record<string, unknown>;
}
export interface RpcNotification {
    id: number;
    type: 'open-dialog';
    payload: OpenDialogPayload;
    sessionId?: string;
}
export interface NotificationScope {
    rpcRoot: string;
    directoryPrefix: string;
    registrationSessionId: string;
    /**
     * Strict session isolation. When true, `pushNotification` and
     * `drainNotifications` refuse an absent or empty session id (throwing
     * `RpcSessionRequiredError`) and a drain returns only that session's own
     * notifications: no notification reaches every session. A strict scope is
     * a separate queue from the same scope without the flag, so a lenient
     * caller cannot push into it or drain it.
     *
     * Off by default: without it, a drain with no session returns every
     * session's notifications and a push with no session reaches every
     * session, which plugins that drain from one process-wide TUI rely on.
     */
    requireSession?: boolean;
    /**
     * What a drain with no session id returns, and what it acknowledges.
     *
     * - `'all'` (default): every queued notification, broadcasts and every
     *   session's targeted ones; a sessionless acknowledgement removes
     *   nothing. A plugin that drains from one process-wide TUI relies on this.
     * - `'broadcast-only'`: broadcasts only (notifications pushed without a
     *   session), never a session's targeted ones, for a TUI that polls before
     *   it knows its session. A sessionless acknowledgement removes the
     *   acknowledged broadcasts and leaves every targeted notification queued.
     *   It also answers `isTuiConnected(scope, undefined)`: true while any
     *   drain on the queue, with or without a session, happened within the
     *   connection window.
     *
     * The option governs each call made with this scope; it does not split the
     * queue, so a push through a scope without it lands in the same queue.
     */
    sessionlessDrain?: 'all' | 'broadcast-only';
}
/** A strict notification scope was used without a session id. */
export declare class RpcSessionRequiredError extends Error {
    readonly operation: 'push' | 'drain';
    constructor(operation: 'push' | 'drain');
}
/** True for a session id a strict scope accepts: a non-empty string. */
export declare function isSessionId(value: unknown): value is string;
export declare function pushNotification(scope: NotificationScope, payload: OpenDialogPayload, sessionId?: string): void;
export declare function drainNotifications(scope: NotificationScope, lastReceivedId?: number, sessionId?: string): RpcNotification[];
/**
 * True when a TUI drained within the last 3000 ms. With a session id, that
 * session drained. Without one, a broadcast-only scope answers whether any
 * drain happened; a default scope answers false, since it only tracks
 * sessions.
 */
export declare function isTuiConnected(scope: NotificationScope, sessionId: string | undefined): boolean;
export declare function resetNotificationsForTest(scope: NotificationScope): void;
