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
export interface QuotaMap {
    limits: QuotaEntry[];
    /** Absent means no observation has reported on the budget yet. */
    budget?: CreditBudgetEntry;
}
export declare function emptyQuotaMap(): QuotaMap;
/** The time an entry speaks for: its reading, retirement or absence time. */
export declare function entryTime(entry: QuotaEntry): number;
export declare function limitKey(scope: string, label: string): string;
export declare function isCreditBudgetEntry(value: unknown): value is CreditBudgetEntry;
/**
 * True when `value` is a well-formed quota map. Unrecognised top-level keys
 * are tolerated (and preserved by merge) so a newer writer's additions
 * survive; a malformed entry, a duplicated (scope, label) key or a malformed
 * budget makes the whole map invalid.
 */
export declare function isQuotaMap(value: unknown): value is QuotaMap;
