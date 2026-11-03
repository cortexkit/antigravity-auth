import type { WaitCheckpoint } from './decide.js';
import type { AccountKey, LimitWindow } from './signal.js';
export interface WakeFacts {
    readonly checkpoint: WaitCheckpoint;
    readonly target: number;
    /**
     * Ordinary holds require this session/account's provider prompt cache to
     * remain valid; terminal waits instead wait for pool quota, without a cache.
     */
    readonly kind?: 'hold' | 'terminal';
}
/**
 * Snapshot exhaustion blockers only. A wait caused by a minimum-remaining quota
 * threshold supplies no windows: elapsed time cannot prove renewed headroom.
 */
export declare function waitCheckpoint(accountKey: AccountKey, decidedAt: number, windows: readonly LimitWindow[]): WaitCheckpoint;
/**
 * Match exhaustion evidence for one wake dispatch, without refreshing quota.
 * The caller must still check admission, other blockers and any cache bound.
 */
export declare function liftedWindowsForWake(wake: WakeFacts, account: AccountKey, windows: readonly LimitWindow[], now: number): readonly string[];
