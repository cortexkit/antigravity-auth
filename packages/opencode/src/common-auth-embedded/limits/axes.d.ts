import type { HostRetry, RefusalFamily } from './families.js';
import type { LimitMark, MarkerAxes } from './marker.js';
import type { FamilyOf } from './scope.js';
export type LimitHost = 'opencode1' | 'opencode2' | 'pi';
export type HostValues<T> = Readonly<Record<LimitHost, T>>;
export type RefusalReason = 'auth' | 'quota' | 'incomplete' | 'model-unavailable';
export type DecisionFamily = RefusalFamily | 'local-auth' | 'native-vault-refusal' | 'no-account';
export interface RefusalPolicy {
    readonly family: DecisionFamily;
    readonly messageKey: string;
    readonly retryable: boolean;
    readonly hostRetry: HostRetry;
}
export interface UnknownLimitPolicy {
    readonly action: 'retain' | 'reselect' | 'pass';
    readonly affinity: 'always' | 'sticky';
    readonly hint: 'none' | 'minimum';
    readonly defaultMs: number;
}
/** Policies consume already parsed, applicable evidence, never provider names. */
export interface LimitAxes {
    readonly evidence: 'per-field-overlay' | 'typed' | 'named-window' | 'hints-only';
    readonly markers: HostValues<MarkerAxes>;
    readonly readingClearsCoveredScopes: 'on' | 'off';
    readonly successClearsCoveredScopes: 'on' | 'off';
    readonly unknown: HostValues<UnknownLimitPolicy>;
    readonly shortLimit: {
        readonly holdBound: 'cache-ttl' | 'disabled';
        readonly preference: 'same-account-first' | 'ready-alternative-first';
        readonly jitter: 'session-sha256' | 'none';
    };
    /** Bounded retention is not an adopted policy. */
    readonly retainBound: 'none';
    readonly poolWaiting: {
        readonly kind: 'off';
    } | {
        readonly kind: 'earliest';
        readonly budgetMs: number;
        readonly requestDeadlineMs: number;
        readonly hardFallbackMs: number;
        readonly singleEligibleSoftExemption: boolean;
    };
    readonly execution: 'host' | 'engine';
    readonly requestExclusion: 'on' | 'off';
    readonly advance: HostValues<{
        readonly statuses: readonly number[];
        readonly attributedLimitOnly: boolean;
    }>;
    readonly markedPool: {
        readonly requestEscape: 'off' | 'ignore-timed-marks-if-all-marked';
        readonly retryExhaustion: 'terminal' | 'same-host-delay' | 'host-delay';
    };
    readonly terminalMetadata: 'setting-capped-fresh' | 'baseline';
    readonly terminalPolicy: 'provided' | 'pool' | 'status-history';
    /** Required when selecting status-history; other terminal policies ignore it. */
    readonly terminalStatusHistory?: {
        readonly minRetryMs: number;
        readonly defaultRetryMs: number;
    };
    readonly refusals: Readonly<Record<RefusalReason, HostValues<RefusalPolicy>>>;
}
/** The caller supplies only this account's marks; other models remain blocked. */
export declare function marksAfterSuccess<T extends LimitMark>(marks: readonly T[], axes: Pick<LimitAxes, 'successClearsCoveredScopes'>, model: string, familyOf: FamilyOf): readonly T[];
