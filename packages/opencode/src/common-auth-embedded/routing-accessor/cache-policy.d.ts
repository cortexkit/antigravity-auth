export type SessionCacheTtl = 'none' | 'short' | 'long';
export type SessionKeepWarmMode = 'off' | 'hours' | 'always' | 'auto';
export interface SessionCacheHours {
    from: string;
    to: string;
    tz: string;
}
export interface SessionCachePolicy {
    ttl?: SessionCacheTtl;
    keep_warm?: SessionKeepWarmMode;
    hours?: SessionCacheHours;
}
export interface SessionToolWait {
    /** Epoch milliseconds when the oldest running plan tool started. */
    since: number;
}
export declare const CACHE_WARM_STOP_REASONS: readonly ['cost-cap', 'count-cap', 'outside-hours', 'session-ended', 'unsupported'];
/** Billing rejects unknown stop reasons; omit them rather than guessing. */
export declare function isCacheWarmStopReason(value: unknown): value is (typeof CACHE_WARM_STOP_REASONS)[number];
/**
 * The stop reasons the llm-runner contract defines today; any other string is
 * accepted too, for reasons that contract adds later.
 */
export type CacheWarmStopReason = 'cost-cap' | 'count-cap' | 'outside-hours' | 'session-ended' | 'unsupported' | (string & Record<never, never>);
export interface CacheTouchInput {
    /** Integer epoch milliseconds when the provider answered. */
    at: number;
    ttlMs: number | 'implicit';
    source: 'response' | 'warm';
}
export interface CacheWarmStoppedInput {
    /** Integer epoch milliseconds. */
    at: number;
    reason: CacheWarmStopReason;
}
/**
 * Read the session's current plan on every decision; never retain it across
 * requests. Null means the plugin keeps its own settings. No I/O or exceptions.
 */
export declare function sessionCachePolicy(sessionId: string): SessionCachePolicy | null;
/** Read the oldest running plan tool afresh, without I/O or exceptions. */
export declare function sessionToolWait(sessionId: string): SessionToolWait | null;
/**
 * Call only after the reply has been handed to the host, never on the awaited
 * request path. Synchronous fire-and-forget, with no retries; the bridge owns
 * redelivery of the newest touch. Accessor and report failures are absorbed.
 */
export declare function reportCacheTouch(sessionId: string, input: CacheTouchInput): void;
/**
 * Call off the request path, after handing the reply to the host. Report only
 * a session that actually warmed, never one that was off from the start.
 * Synchronous fire-and-forget; failures are absorbed and never retried here.
 */
export declare function reportCacheWarmStopped(sessionId: string, input: CacheWarmStoppedInput): void;
