import { type QuotaMap } from './map.js';
export interface ProjectedLimit {
    scope: string;
    label: string;
    kind: 'reading' | 'retired' | 'absent';
    /** The reading, retirement or absence time. */
    checkedAt: number;
    /** The stored window length; undefined when the provider reported none. */
    windowMinutes?: number;
    /** Present on readings only. */
    usedPercent?: number;
    /** Present on readings only: `100 - usedPercent`. */
    remainingPercent?: number;
    resetsAt?: string;
}
export interface ProjectedBudget {
    checkedAt: number;
    reached: boolean;
    remainingPercent?: number;
    resetsAt?: string;
}
export interface ProjectedQuota {
    scope: string;
    /** One entry per label: longest known window first, unknown lengths last. */
    limits: readonly ProjectedLimit[];
    /**
     * The oldest reading time among the limits (or, with no reading, the oldest
     * evidence time), so a projection is only as fresh as its stalest limit.
     */
    checkedAt?: number;
    /** Present only when the stored budget is a reading, not cleared. */
    budget?: ProjectedBudget;
}
/**
 * Resolves `map` for a request in `scope` (`all` or a model family). A family
 * request sees only its own family's keys and the `all` keys.
 *
 * The label decides how a family limit relates to a general one. Under the
 * same label, the family reading replaces the `all` reading: use this only
 * when the provider's family figure is a more specific view of the same cap.
 * Under different labels both limits are projected and every consumer judges
 * both, so a family cap that applies on top of a general cap must be stored
 * under its own label; otherwise the general cap is hidden from a family
 * request. A family tombstone or absence record says only that no
 * family-specific limit exists, so it does not hide an `all` entry for the
 * same label and is used only when there is none.
 */
export declare function projectQuota(map: QuotaMap | undefined, scope?: string): ProjectedQuota;
export interface ExhaustionReset {
    resetsAt: string;
    resetAtMs: number;
}
/**
 * The credit budget's own exhaustion signal. Admission and the sticky
 * routing decision to move a session off its pinned row both use it, so the
 * two agree on what "spent" means. `reached` is the provider's
 * verdict (the percentage is only a display value), and the check fails open
 * on a missing, unparsable or already-passed reset.
 */
export declare function budgetExhaustedResetAt(quota: Pick<ProjectedQuota, 'budget'> | null | undefined, now: number): ExhaustionReset | undefined;
/** True for a reading at or beyond its whole window. */
export declare function readsExhausted(limit: ProjectedLimit): boolean;
/** The reset time of a limit when it parses and lies after `now`. */
export declare function futureResetAt(limit: ProjectedLimit, now: number): number | undefined;
