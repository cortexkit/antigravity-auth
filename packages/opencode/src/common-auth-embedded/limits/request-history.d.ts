import type { Scope } from './scope.js';
import type { AccountKey, LimitKind } from './signal.js';
export declare function sameAccount(a: AccountKey, b: AccountKey): boolean;
export interface RequestExclusion {
    readonly account: AccountKey;
    readonly scope: Scope;
}
export interface RetainHistory {
    readonly account: AccountKey;
    readonly count: number;
    readonly startedAt: number;
    readonly lastRetainedAt: number;
}
export interface RequestHistory {
    /** A request/turn token, not a session id. */
    readonly requestId: string;
    readonly originalUrl: string;
    readonly requestStartedAt: number;
    readonly saw429: boolean;
    readonly sawPaymentBalance?: boolean;
    readonly lastStatus?: number;
    readonly tried: readonly RequestExclusion[];
    readonly excludedForRequest: readonly RequestExclusion[];
    readonly retains: readonly RetainHistory[];
    readonly retainedAttempts: readonly string[];
    readonly excludedAttempts: readonly string[];
    readonly switchedAttempts: readonly string[];
    readonly switches: number;
    readonly blockedSince?: number;
}
export declare function createRequestHistory(input: {
    readonly requestId: string;
    readonly originalUrl: string;
    readonly clockNow: number;
}): RequestHistory;
export declare function isRequestExcluded(history: RequestHistory, account: AccountKey, scope: Scope): boolean;
export type RequestHistoryEvent = {
    readonly type: 'response';
    readonly account: AccountKey;
    readonly scope: Scope;
    readonly status?: number;
    readonly kind?: LimitKind;
} | {
    readonly type: 'retain';
    readonly account: AccountKey;
    readonly attemptId: string;
    readonly clockNow: number;
    readonly cause: 'unconfirmed-limit' | 'credential-recovery';
} | {
    readonly type: 'exclude';
    readonly account: AccountKey;
    readonly scope: Scope;
    readonly attemptId: string;
} | {
    readonly type: 'switch';
    readonly attemptId: string;
} | {
    readonly type: 'blocked';
    readonly clockNow: number;
} | {
    readonly type: 'selected';
};
/** Retain/exclude/switch events are committed by the executor, not by polling. */
export declare function reduceRequestHistory(history: RequestHistory, event: RequestHistoryEvent): RequestHistory;
export declare const REQUEST_EXCLUSION_EFFECTS: Readonly<{
    readonly refundHybridToken: true;
    readonly cancelDiscardedBody: true;
    readonly addMark: false;
    readonly addCooldown: false;
    readonly penalizeHealth: false;
    readonly chargeSwitch: false;
}>;
/** Run the returned effects once, then reselect with the returned history. */
export declare function commitRequestExclusion(history: RequestHistory, entry: RequestExclusion & {
    readonly attemptId: string;
}): {
    readonly history: RequestHistory;
    readonly effects?: typeof REQUEST_EXCLUSION_EFFECTS;
};
