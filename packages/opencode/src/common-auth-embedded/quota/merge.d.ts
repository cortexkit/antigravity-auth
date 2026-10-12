import { type QuotaMap } from './map.js';
export interface ObservedReading {
    /** Defaults to `all`. */
    scope?: string;
    label: string;
    usedPercent: number;
    resetsAt?: string;
    windowMinutes?: number;
}
export interface ObservedPair {
    /** Defaults to `all`. */
    scope?: string;
    label: string;
}
export type ObservedBudget = {
    kind: 'reading';
    reached: boolean;
    remainingPercent?: number;
    usedPercent?: number;
    resetsAt?: string;
    limit?: number;
    used?: number;
    remaining?: number;
    unit?: string;
} | {
    kind: 'cleared';
};
export interface QuotaObservation {
    checkedAt: number;
    readings?: ObservedReading[];
    /** Pairs reported on with authority besides the ones carrying a reading. */
    coverage?: ObservedPair[];
    /** Absent means the observation says nothing about the budget. */
    budget?: ObservedBudget;
}
/** Thrown by `mergeQuotaObservation` when either argument is malformed. */
export declare class QuotaCodecError extends TypeError {
    constructor(message: string);
}
/** True when `value` is a well-formed observation; a pair read twice is not. */
export declare function isQuotaObservation(value: unknown): value is QuotaObservation;
/**
 * Applies `observation` to `stored` (undefined for a row with no map yet) and
 * returns the new map. Pure: neither argument is modified. Throws
 * `QuotaCodecError` when either argument is malformed, so a store refuses the
 * write rather than persisting a map it could not read back.
 */
export declare function mergeQuotaObservation(stored: unknown, observation: unknown): QuotaMap;
