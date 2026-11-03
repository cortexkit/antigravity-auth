import type { DecisionFamily, LimitAxes, LimitHost, RefusalReason } from './axes.js';
import type { HostRetry } from './families.js';
import type { RequestHistory } from './request-history.js';
import { REQUEST_EXCLUSION_EFFECTS } from './request-history.js';
import type { Scope } from './scope.js';
import type { AccountKey, LimitSignal, LimitWindow } from './signal.js';
import type { TerminalScanFacts } from './terminal.js';
import type { WakeFacts } from './wake.js';
export interface TimedBlocker {
    readonly kind: 'hard' | 'cooldown' | 'soft';
    readonly until?: number;
    readonly cause?: import('./marker.js').LimitMarkCause;
}
/**
 * Admission includes the caller's minimum quota thresholds, access checks,
 * current identity/credential ownership checks and pending-write fences.
 * Placement and readiness are separate facts.
 */
export interface LimitCandidate {
    readonly account: AccountKey;
    readonly admitted: boolean;
    readonly placementEligible: boolean;
    readonly ready: boolean;
    readonly blockers: readonly TimedBlocker[];
    readonly confirmedBlockers?: readonly LimitWindow[];
}
export interface ModeSelection {
    readonly account: AccountKey;
    readonly pin: 'pin' | 'preserve' | 'detour';
}
export interface WaitCheckpoint {
    readonly accountKey: AccountKey;
    readonly decidedAt: number;
    readonly blockers: readonly {
        readonly window: string;
        readonly resetAt: number;
    }[];
}
/** Resolved via sameAccountHoldFacts; expiry uses the caller's epoch clock. */
export interface HoldFacts {
    readonly cacheExpiresAt: number;
    readonly maxWaitMs: number;
    readonly maxDelayMs?: number;
}
/** Resolved metadata for a terminal refusal, not an account-selection instruction. */
export interface TerminalFacts {
    readonly source: 'pool' | 'vault';
    readonly reason: RefusalReason;
    readonly family?: DecisionFamily;
    readonly messageKey?: string;
    readonly retryable?: boolean;
    readonly hostRetry?: HostRetry;
    readonly retryAfterMs?: number;
    readonly resetAt?: number;
    /** Pool quota refusals require per-field scan evidence to retain a reset. */
    readonly scan?: TerminalScanFacts;
}
export interface PolicyFacts {
    readonly phase: 'pre-send' | 'after-limit';
    readonly host: LimitHost;
    readonly hostPhase?: 'request' | 'retry';
    readonly now: number;
    readonly clockNow: number;
    readonly sessionId: string;
    readonly requestScope: Scope;
    readonly history: RequestHistory;
    readonly attempted?: AccountKey;
    readonly signal?: LimitSignal;
    readonly signalApplicable?: boolean;
    readonly status?: number;
    readonly failureRetryable?: boolean;
    readonly delivery: {
        readonly owned: boolean;
        readonly attributable: boolean;
        readonly replayable: boolean;
    };
    readonly candidates: readonly LimitCandidate[];
    readonly selection?: ModeSelection;
    readonly affinity?: 'sticky' | 'broken' | 'none';
    readonly credentialRecovery?: {
        readonly retryMs?: number;
    };
    readonly retryHintsMs?: readonly number[];
    /** Committed unconfirmed retains for the current session, turn and account. */
    readonly unconfirmedRetainCount?: number;
    readonly hold?: HoldFacts;
    readonly wake?: WakeFacts;
    readonly remainingRetries?: number;
    readonly terminal?: TerminalFacts;
    readonly poolWaitBudgetMs?: number;
}
interface DecisionBase {
    readonly retryable: boolean;
    readonly hostRetry: HostRetry;
    readonly history: RequestHistory;
    readonly reason: string;
}
export type LimitDecision = DecisionBase & ({
    readonly action: 'reroute';
    readonly account: AccountKey;
    readonly pin: ModeSelection['pin'];
} | {
    readonly action: 'hold';
    readonly account: AccountKey;
    readonly delayMs: number;
    readonly retryAfterMs: number;
    readonly target: number;
    readonly checkpoint: WaitCheckpoint;
    readonly resetAt?: number;
    /** Carry into wake.kind so terminal waits omit the ordinary cache bound. */
    readonly waitKind?: 'terminal';
} | {
    readonly action: 'retain';
    readonly account: AccountKey;
    readonly retryMs?: number;
    /** Commit once when executing this retain, never when polling the decision. */
    readonly incrementUnconfirmedRetain?: true;
    /** Exhaustion windows waived for this dispatch only, never persisted. */
    readonly liftedWindows?: readonly string[];
} | {
    readonly action: 'wait-then-reselect';
    readonly delayMs: number;
    readonly resetAt?: number;
    readonly target: number;
    readonly checkpoint: WaitCheckpoint;
    readonly retryAfterMs?: number;
    /** Carry into wake.kind; Pi reselects once and then refuses without another wait. */
    readonly waitKind?: 'terminal';
} | {
    readonly action: 'exclude-for-request';
    readonly account: AccountKey;
    readonly scope: Scope;
    readonly effects: typeof REQUEST_EXCLUSION_EFFECTS;
} | {
    readonly action: 'refuse';
    readonly reason: RefusalReason;
    readonly family: DecisionFamily;
    readonly messageKey: string;
    readonly retryAfterMs?: number;
    readonly resetAt?: number;
} | {
    readonly action: 'pass';
});
/** The caller supplies clocks, admission, delivery ownership and parsed evidence. */
export declare function decideAfterLimit(facts: PolicyFacts, axes: LimitAxes): LimitDecision;
export {};
