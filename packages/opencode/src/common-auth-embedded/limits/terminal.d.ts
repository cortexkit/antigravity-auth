import type { SessionActivity } from './activity.js';
import type { LimitAxes } from './axes.js';
import type { LimitDecision, PolicyFacts, TerminalFacts, WaitCheckpoint } from './decide.js';
import type { RequestHistory } from './request-history.js';
import type { FamilyOf, Scope } from './scope.js';
import type { AccountKey } from './signal.js';
export interface TerminalWindow {
    readonly window: string;
    readonly scope: Scope;
    /** The caller evaluates quota thresholds, not just provider exhaustion. */
    readonly blockedBy?: 'exhausted' | 'floor' | 'killswitch-floor';
    readonly reset?: {
        readonly at: number;
        /** Provenance of this reset field, never the enclosing row's update time. */
        readonly observedAt?: number;
        readonly checkedAt?: number;
    };
}
export interface TerminalCandidate {
    readonly account: AccountKey;
    readonly readingAccount: AccountKey;
    readonly identity?: string;
    readonly readingIdentity?: string;
    readonly windows: readonly TerminalWindow[];
}
export interface TerminalScanFacts {
    /** Candidate keys come from the caller's scoped/general terminal scan. */
    readonly candidates: readonly TerminalCandidate[];
    readonly effectiveModel: string;
    readonly familyOf: FamilyOf;
    readonly maxAgeMs: number;
    readonly maxSameAccountWait?: unknown;
    /** Set only when the user opts in to waiting for quota reset. Jitter must be a finite, non-negative integer. */
    readonly waitForReset?: {
        readonly jitterMs: number;
    };
    readonly activity?: SessionActivity;
    /** Current session account, used to reject another account's cache record. */
    readonly accountKey?: AccountKey;
}
export interface TerminalReset {
    readonly account: AccountKey;
    readonly resetAt: number;
    readonly checkpoint: WaitCheckpoint;
}
/**
 * Take each account's latest blocking reset, then the earliest across accounts.
 * A missing identity is compatible, but readings from before re-login are not.
 */
export declare function scanTerminalReset(input: TerminalScanFacts, now: number): TerminalReset | undefined;
export declare function terminalWaitDisabled(metadata: TerminalFacts, axes: LimitAxes, now: number): boolean;
/**
 * When no account is ready, an opt-in can wait for the full reset without a
 * warm cache. Otherwise keep the preset's existing refusal and wait bounds.
 */
export declare function terminalRefusalDecision(facts: PolicyFacts, axes: LimitAxes, history: RequestHistory, metadata: TerminalFacts): LimitDecision | undefined;
