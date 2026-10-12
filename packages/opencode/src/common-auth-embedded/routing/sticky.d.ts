import { type ProjectedQuota } from '../quota/projection.js';
import { type AdmissionInput, type AdmissionRefusal, type AdmissionResult, type RoutingRow, type WindowRef } from './admission.js';
import { type StickyPin } from './pins.js';
export declare const QUOTA_STALENESS_MS: number;
export declare const MIN_RESET_HOURS: number;
export declare const MIN_WEIGHT = 0.000001;
/** The projection's time, else the caller's cache-entry time. */
export declare function snapshotCheckedAt(quota: ProjectedQuota | null | undefined, entryCheckedAt?: number): number | undefined;
export type StickyBreakDecision = {
    action: 'retain';
    reason: 'unknown' | 'stale' | 'healthy' | 'transient';
} | {
    action: 'migrate';
    reason: 'exhausted' | 'permanent' | 'killswitch';
    /** The exhausted limit, named by its (scope, label), not its position. */
    window?: WindowRef;
    resetsAt?: string;
};
/**
 * How the adapter reads a failed response's HTTP status for the break
 * decision. `permanent` moves the session off its row before any quota is
 * consulted; `transient` and `healthy` keep it unless the quota says the row
 * is spent. A missing status means the request failed without a response.
 */
export type StickyStatusClass = 'permanent' | 'transient' | 'healthy';
export type StickyStatusClassifier = (status: number | undefined) => StickyStatusClass;
/**
 * The status rule used when the adapter supplies none, carried from
 * openai-auth: 401 and 403 are permanent; no response, 0, a non-finite
 * status, 429 and 5xx are transient; anything else leaves the row healthy.
 * A provider whose 403 can mean an organisation or model policy rather than
 * a dead account supplies its own classifier and can fall back to this one
 * for the statuses it does not single out.
 */
export declare function defaultStickyStatusClass(status: number | undefined): StickyStatusClass;
/** Classifies whether a pinned session should leave its row after a failure. */
export declare function decideStickyBreak(input: {
    quota: ProjectedQuota | null | undefined;
    quotaCheckedAt?: number;
    status?: number;
    now: number;
    killswitchPasses?: boolean;
    /** Defaults to `defaultStickyStatusClass`. */
    classifyStatus?: StickyStatusClassifier;
}): StickyBreakDecision;
export declare function sustainableWindowWeight(window: {
    remainingPercent: number;
    resetsAt?: string;
}, reservePercent: number, now: number): number;
export interface StickySelectionCandidate {
    accountId: string;
    quota: ProjectedQuota | null | undefined;
    quotaCheckedAt?: number;
    /** Reserve percent per window label; a missing label reserves nothing. */
    reservePercent: Readonly<Record<string, number>>;
    configuredOrder: number;
    resetCreditsApplicable?: number;
    /** `false` excludes the candidate from weighted and fallback placement. */
    killswitchPasses?: boolean;
}
export interface StickySelectionInput {
    candidates: readonly StickySelectionCandidate[];
    pendingBytes: ReadonlyMap<string, number>;
    requestBytes: number;
    now: number;
    onEmptyWeightedSet?: () => void;
}
export interface StickySelection {
    accountId: string;
    quotaCheckedAt?: number;
    source: 'weighted' | 'mode-fallback';
}
/**
 * Places a session: the lowest projected pressure among candidates with a
 * fresh positive weight, else (`mode-fallback`) the first candidate in
 * configured order, preferring one with an applicable reset credit.
 */
export declare function selectStickyCandidate(input: StickySelectionInput): StickySelection | undefined;
/** Reserve percent per window label; a missing label reserves nothing. */
export type ReservePercent = Readonly<Record<string, number>>;
/**
 * Reserve percentages per row: a map keyed by row id, or a function of the
 * row. A row the map lacks, or for which the function returns undefined,
 * takes the shared `reservePercent`.
 */
export type RowReservePercent = ReadonlyMap<string, ReservePercent> | ((row: RoutingRow) => ReservePercent | undefined);
/**
 * What a valid pin does when its row is not dispatched.
 *
 * `keep`: the pin is retained whatever kept its row from this request.
 *
 * `move-on-confirmed-exhaustion`: the pin moves to the row this request is
 * dispatched to when its own row was refused as confirmed exhausted (a spent
 * window with a future reset, or a spent credit budget) or killed by the
 * killswitch. A refusal for unknown quota (no reading yet, a missing window,
 * an exhausted reading without a usable reset) and an exclusion (rate-limit
 * mark, refresh backoff) keep the pin while this request is served elsewhere.
 * With no admissible row the pin is retained either way.
 */
export type RefusedPinPolicy = 'keep' | 'move-on-confirmed-exhaustion';
export interface StickyRouteInput extends AdmissionInput {
    requestBytes: number;
    /** Bytes already committed per row, for example from other sessions' pins. */
    pendingBytes?: ReadonlyMap<string, number>;
    /** Killswitch verdict per row; a missing row passes. */
    killswitch?: ReadonlyMap<string, boolean>;
    /** Reserve percent per window label, for every row without its own. */
    reservePercent?: ReservePercent;
    /** Per-row reserves, which replace `reservePercent` for the rows they cover. */
    rowReservePercent?: RowReservePercent;
    /** Defaults to `keep`. */
    refusedPinPolicy?: RefusedPinPolicy;
    resetCreditsApplicable?: ReadonlyMap<string, number>;
    /** The session's current pin, if it has one. */
    pin?: StickyPin;
    /** Each row's recorded wire identity; missing means unknown. */
    identities?: ReadonlyMap<string, string | undefined>;
    onEmptyWeightedSet?: () => void;
}
/**
 * What the caller does with the session's pin: keep it, replace it with
 * `pin`, or drop it. Under the default `keep` policy a valid pin is always
 * kept, even when this request was routed elsewhere because its row was
 * refused, excluded or killed; `refusedPinPolicy` can move it instead.
 */
export type PinAction = {
    action: 'retain';
} | {
    action: 'assign';
    pin: StickyPin;
} | {
    action: 'clear';
} | {
    action: 'none';
};
export type StickyRoute = {
    outcome: 'dispatch';
    accountId: string;
    source: 'pin' | 'weighted' | 'mode-fallback';
    quotaCheckedAt?: number;
    pin: PinAction;
    /** Rows that selection chose and admission then refused, in selection order. */
    refusedSelections: AdmissionRefusal[];
    admission: AdmissionResult;
} | {
    outcome: 'no-admissible-account';
    pin: PinAction;
    refusedSelections: AdmissionRefusal[];
    admission: AdmissionResult;
};
/**
 * Routes one request in `sticky-balanced` mode. A valid pin whose row is
 * admitted, not excluded and not killed is dispatched as is. Otherwise
 * selection runs over the non-excluded rows; each selected row admission
 * refused is removed and selection re-runs, so the loop ends either on an
 * admitted row or with no admissible account.
 */
export declare function routeSticky(input: StickyRouteInput): StickyRoute;
