// Merging one observation into a stored quota map.
//
// One freshness rule applies everywhere: an observation applies to a key when
// it is not older than what the key holds, so an equal time applies and the
// observation applied last wins, as openai-auth's `freshestWindow` does.
//
// An observation carries readings plus a coverage list: the (scope, label)
// pairs it speaks for with authority. Every reading is implicitly covered. A
// covered pair the observation carries no reading for is reported as having
// no limit: an existing reading becomes a retirement tombstone, and a key with
// no entry gets an absence record. A pair outside the coverage is never
// touched, so a header-shaped partial observation (which covers only what it
// carries) cannot erase a family limit or the budget.
import { ALL_SCOPE, entryTime, isQuotaMap, limitKey, } from './map.js';
/** Thrown by `mergeQuotaObservation` when either argument is malformed. */
export class QuotaCodecError extends TypeError {
    constructor(message) {
        super(message);
        this.name = 'QuotaCodecError';
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isScope(value) {
    return value === undefined || (typeof value === 'string' && value !== '');
}
function isLabel(value) {
    return typeof value === 'string' && value !== '';
}
function optionalFinite(record, key) {
    return record[key] === undefined || isFiniteNumber(record[key]);
}
function optionalString(record, key) {
    return record[key] === undefined || typeof record[key] === 'string';
}
function isObservedReading(value) {
    return (isRecord(value) &&
        isScope(value.scope) &&
        isLabel(value.label) &&
        isFiniteNumber(value.usedPercent) &&
        optionalString(value, 'resetsAt') &&
        (value.windowMinutes === undefined ||
            (isFiniteNumber(value.windowMinutes) && value.windowMinutes > 0)));
}
function isObservedPair(value) {
    return isRecord(value) && isScope(value.scope) && isLabel(value.label);
}
function isObservedBudget(value) {
    if (!isRecord(value))
        return false;
    if (value.kind === 'cleared')
        return true;
    return (value.kind === 'reading' &&
        typeof value.reached === 'boolean' &&
        optionalFinite(value, 'remainingPercent') &&
        optionalFinite(value, 'usedPercent') &&
        optionalString(value, 'resetsAt') &&
        optionalFinite(value, 'limit') &&
        optionalFinite(value, 'used') &&
        optionalFinite(value, 'remaining') &&
        optionalString(value, 'unit'));
}
/** True when `value` is a well-formed observation; a pair read twice is not. */
export function isQuotaObservation(value) {
    if (!isRecord(value) || !isFiniteNumber(value.checkedAt))
        return false;
    const readings = value.readings ?? [];
    const coverage = value.coverage ?? [];
    if (!Array.isArray(readings) || !Array.isArray(coverage))
        return false;
    const read = new Set();
    for (const reading of readings) {
        if (!isObservedReading(reading))
            return false;
        const key = limitKey(reading.scope ?? ALL_SCOPE, reading.label);
        if (read.has(key))
            return false;
        read.add(key);
    }
    if (!coverage.every(isObservedPair))
        return false;
    return value.budget === undefined || isObservedBudget(value.budget);
}
function compareEntries(left, right) {
    if (left.scope !== right.scope)
        return left.scope < right.scope ? -1 : 1;
    if (left.label !== right.label)
        return left.label < right.label ? -1 : 1;
    return 0;
}
function mergeBudget(stored, observed, checkedAt) {
    if (observed === undefined)
        return stored;
    if (stored !== undefined && checkedAt < stored.checkedAt)
        return stored;
    return { ...observed, checkedAt };
}
/**
 * Applies `observation` to `stored` (undefined for a row with no map yet) and
 * returns the new map. Pure: neither argument is modified. Throws
 * `QuotaCodecError` when either argument is malformed, so a store refuses the
 * write rather than persisting a map it could not read back.
 */
export function mergeQuotaObservation(stored, observation) {
    if (stored !== undefined && !isQuotaMap(stored)) {
        throw new QuotaCodecError('stored quota map is malformed');
    }
    if (!isQuotaObservation(observation)) {
        throw new QuotaCodecError('quota observation is malformed');
    }
    const base = stored ?? { limits: [] };
    const at = observation.checkedAt;
    const entries = new Map();
    for (const entry of base.limits) {
        entries.set(limitKey(entry.scope, entry.label), entry);
    }
    const applies = (key) => {
        const existing = entries.get(key);
        return existing === undefined || at >= entryTime(existing);
    };
    const carried = new Set();
    for (const reading of observation.readings ?? []) {
        const scope = reading.scope ?? ALL_SCOPE;
        const key = limitKey(scope, reading.label);
        carried.add(key);
        if (!applies(key))
            continue;
        entries.set(key, {
            scope,
            label: reading.label,
            kind: 'reading',
            checkedAt: at,
            usedPercent: reading.usedPercent,
            ...(reading.resetsAt === undefined ? {} : { resetsAt: reading.resetsAt }),
            ...(reading.windowMinutes === undefined
                ? {}
                : { windowMinutes: reading.windowMinutes }),
        });
    }
    for (const pair of observation.coverage ?? []) {
        const scope = pair.scope ?? ALL_SCOPE;
        const key = limitKey(scope, pair.label);
        if (carried.has(key) || !applies(key))
            continue;
        const existing = entries.get(key);
        entries.set(key, existing === undefined || existing.kind === 'absent'
            ? { scope, label: pair.label, kind: 'absent', checkedAt: at }
            : { scope, label: pair.label, kind: 'retired', retiredAt: at });
    }
    // Keys this module does not recognise are carried over untouched.
    const { limits: _limits, budget: _budget, ...unknownKeys } = base;
    const budget = mergeBudget(base.budget, observation.budget, at);
    return {
        ...unknownKeys,
        limits: [...entries.values()].sort(compareEntries),
        ...(budget === undefined ? {} : { budget }),
    };
}
