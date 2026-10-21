/** The scope of a limit that binds every request regardless of model. */
export declare const ALL_SCOPE = "all";
/** The window label required when an admission call supplies none. */
export declare const DEFAULT_REQUIRED_LABELS: readonly string[];
export interface QuotaReadingEntry {
    scope: string;
    label: string;
    kind: 'reading';
    checkedAt: number;
    usedPercent: number;
    /** ISO timestamp at which the window resets, as the provider reported it. */
    resetsAt?: string;
    /** Window length in minutes, when the provider reported one. */
    windowMinutes?: number;
}
export interface QuotaRetiredEntry {
    scope: string;
    label: string;
    kind: 'retired';
    retiredAt: number;
}
export interface QuotaAbsentEntry {
    scope: string;
    label: string;
    kind: 'absent';
    checkedAt: number;
}
export type QuotaEntry = QuotaReadingEntry | QuotaRetiredEntry | QuotaAbsentEntry;
export interface CreditBudgetReading {
    kind: 'reading';
    checkedAt: number;
    /** The provider's own verdict that the budget is spent. */
    reached: boolean;
    remainingPercent?: number;
    usedPercent?: number;
    resetsAt?: string;
    limit?: number;
    used?: number;
    remaining?: number;
    unit?: string;
}
export interface CreditBudgetCleared {
    kind: 'cleared';
    checkedAt: number;
}
export type CreditBudgetEntry = CreditBudgetReading | CreditBudgetCleared;
export interface QuotaCounter {
    value: number;
    checkedAt: number;
}
/**
 * Prepaid credits a provider account holds beside its rate-limit windows (for
 * example a ChatGPT workspace's credits, which keep requests working after a
 * window is used up). This is a state, not a count or the spend budget: the
 * account has credits or not, they may be unlimited, and the provider may
 * report a balance. It carries its own observation time.
 */
export interface QuotaCredits {
    hasCredits: boolean;
    unlimited: boolean;
    /** The balance the provider reported, when it reported one. */
    balance?: number;
    /** The provider's verdict that the overage allowance is used up. */
    overageLimitReached?: boolean;
    checkedAt: number;
}
export interface QuotaMap {
    limits: QuotaEntry[];
    /** Absent means no observation has reported on the budget yet. */
    budget?: CreditBudgetEntry;
    /** Provider-named counts, each with its own observation time. */
    counters?: Record<string, QuotaCounter>;
    /** Absent means no observation has reported on prepaid credits yet. */
    credits?: QuotaCredits;
}
export declare function emptyQuotaMap(): QuotaMap;
/** The time an entry speaks for: its reading, retirement or absence time. */
export declare function entryTime(entry: QuotaEntry): number;
export declare function limitKey(scope: string, label: string): string;
export declare function isCreditBudgetEntry(value: unknown): value is CreditBudgetEntry;
export declare function isQuotaCounters(value: unknown): value is Record<string, QuotaCounter>;
/** True when `value` is a well-formed prepaid-credits record. */
export declare function isQuotaCredits(value: unknown): value is QuotaCredits;
/** Keep usable counters without letting one malformed count hide a quota map. */
export declare function readQuotaCounters(value: unknown): Record<string, QuotaCounter> | undefined;
/**
 * Decode persisted quota, dropping malformed counters or a malformed credits
 * record but not limit or budget evidence.
 */
export declare function decodeQuotaMap(value: unknown): QuotaMap | undefined;
/**
 * True when `value` is a well-formed quota map. Unrecognised top-level keys
 * are tolerated (and preserved by merge) so a newer writer's additions
 * survive; a malformed entry, a duplicated (scope, label) key or a malformed
 * budget makes the whole map invalid.
 */
export declare function isQuotaMap(value: unknown): value is QuotaMap;
