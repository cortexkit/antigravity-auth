import type { AccountKey } from './signal.js';
export interface SessionActivity {
    readonly accountKey: AccountKey;
    readonly lastAcceptedAt: number;
    readonly ttlMs: number;
}
export interface AcceptedActivity {
    readonly sessionId: string;
    readonly accountKey: AccountKey;
    /** The authoritative account key at completion, not the key at request start. */
    readonly currentAccountKey: AccountKey;
    readonly lastAcceptedAt: number;
    /** TTLs of prompt segments cached by this response, or their single longest TTL. */
    readonly ttlMs?: number | readonly number[];
}
export interface SessionActivityStore {
    readonly size: number;
    /** Call for accepted responses and successful (2xx) keep-warm prewarms. */
    recordAccepted(input: AcceptedActivity): boolean;
    get(sessionId: string): SessionActivity | undefined;
    /** Call both when forgetting a session and when the host deletes it. */
    forgetSession(sessionId: string): void;
}
export declare function effectiveCacheTtlMs(ttlMs: number | undefined): number;
/** One process-local cache record per session; no credential or store I/O. */
export declare function createSessionActivityStore(): SessionActivityStore;
