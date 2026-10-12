import { type QuotaMap } from '../quota/map.js';
import { type ProjectedQuota } from '../quota/projection.js';
export type RowKind = 'oauth' | 'api-key';
export interface RoutingRow {
    id: string;
    kind: RowKind;
    /** The row's stored quota map; absent is the same as an empty map. */
    quota?: QuotaMap;
}
export interface WindowRef {
    scope: string;
    label: string;
}
export interface ExclusionInputs {
    /** Row id to the time (ms) a rate-limit mark expires. */
    rateLimitMarks?: ReadonlyMap<string, number>;
    /** Row id to the time (ms) a failed refresh may be retried. */
    refreshBackoff?: ReadonlyMap<string, number>;
}
export interface AdmissionInput extends ExclusionInputs {
    rows: readonly RoutingRow[];
    /** `all` (the default) or a model family. */
    scope?: string;
    /** Labels the scope requires an entry for; defaults to `['primary']`. */
    requiredLabels?: readonly string[];
    now: number;
    /**
     * Called synchronously, once per refusal at gates 2 to 4, with the row id.
     * Its return value is ignored and never awaited, so a pull the caller
     * starts from here cannot delay the refusal.
     */
    requestPull?: (rowId: string) => void;
}
export type AdmissionRefusal = {
    id: string;
    stage: 1;
    gate: 2;
    reason: 'needs-first-reading';
    pullRequested: true;
} | {
    id: string;
    stage: 1;
    gate: 3;
    reason: 'unknown-window';
    window: WindowRef;
    pullRequested: true;
} | {
    id: string;
    stage: 1;
    gate: 4;
    reason: 'unknown-reset';
    window: WindowRef;
    pullRequested: true;
} | {
    id: string;
    stage: 1;
    gate: 5;
    reason: 'exhausted';
    window: WindowRef;
    resetsAt: string;
    resetAtMs: number;
} | {
    id: string;
    stage: 2;
    reason: 'budget-spent';
    resetsAt: string;
    resetAtMs: number;
};
export interface AdmissionExclusion {
    id: string;
    reason: 'rate-limited' | 'refresh-backoff';
    until: number;
}
export interface AdmittedRow {
    id: string;
    kind: RowKind;
    /** The projection admission judged; absent for API-key rows. */
    projection?: ProjectedQuota;
    /** Set when a spent budget was kept because no other path survived. */
    lastPath?: true;
}
export interface AdmissionResult {
    /** In input order. */
    admitted: AdmittedRow[];
    refused: AdmissionRefusal[];
    excluded: AdmissionExclusion[];
    /** Ids a pull was requested for, in input order. */
    pulls: string[];
}
/** The exclusion that applies to `id` at `now`, if any. */
export declare function exclusionFor(id: string, inputs: ExclusionInputs, now: number): AdmissionExclusion | undefined;
/** Runs both admission stages over `input.rows`. */
export declare function admit(input: AdmissionInput): AdmissionResult;
