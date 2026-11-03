import type { Scope } from './scope.js';
import type { AccountKey, LimitKind, LimitSignal } from './signal.js';
export type MergeLaw = 'latest-evidence' | 'max-until' | 'overwrite';
export interface LimitMark {
    readonly scope: Scope;
    readonly until: number;
    readonly mergeLaw: MergeLaw;
}
export interface FailureLadderAxes {
    readonly kind: 'failure-ladder';
    readonly mergeLaw: MergeLaw;
    readonly hintFloorMs: number;
    readonly quotaSteps: readonly number[];
    readonly byKind: Readonly<Partial<Record<LimitKind, number>>>;
    readonly byReason: Readonly<Record<string, number>>;
    readonly capacity: {
        readonly baseMs: number;
        /** Maximum displacement on either side of baseMs. */
        readonly spreadMs: number;
    };
    readonly defaultMs: number;
}
export declare const ANTIGRAVITY_FAILURE_LADDER: FailureLadderAxes;
export type MarkerAxes = {
    readonly kind: 'off';
} | {
    readonly kind: 'hint';
    readonly mergeLaw: MergeLaw;
    readonly defaultMs: number;
    readonly minimumMs: number;
    readonly zero: 'accept' | 'skip';
    /** Core absolute dates and host event-relative hints use different samples. */
    readonly hintClock: 'signal' | 'marker';
} | {
    readonly kind: 'reset';
    readonly mergeLaw: MergeLaw;
    readonly defaultMs: number;
} | FailureLadderAxes;
export interface FailureStreak {
    readonly count: number;
    readonly lastFailureAt: number;
}
/** Owned by the process, not a persisted registry snapshot. */
export type FailureHistory = ReadonlyMap<string, FailureStreak>;
export type FailureEvent = {
    readonly type: 'failure';
    readonly account: AccountKey;
    readonly at: number;
} | {
    readonly type: 'success';
    readonly account: AccountKey;
};
/** Feed committed marker events, not repeated reducer evaluations, into history. */
export declare function reduceFailureHistory(history: FailureHistory, event: FailureEvent, ttlMs?: number): FailureHistory;
export interface MarkerHistory {
    readonly now: number;
    /** Includes the current failure event; success removes only that account's streak. */
    readonly failures?: FailureHistory;
    /** Uniform sample in [0, 1] for the capacity fallback duration; omitted means midpoint. */
    readonly random?: number;
}
/** No clocks, random draws, state updates or I/O occur while producing a mark. */
export declare function markFromSignal(signal: LimitSignal | undefined, axes: MarkerAxes, history: MarkerHistory): LimitMark | undefined;
export declare function markIsActive(mark: LimitMark, now: number): boolean;
