// The per-row quota map: what the pool knows about one row's limits.
//
// A row's quota is a set of keyed limits. Each key is a (scope, window label)
// pair: the scope is `all` for a limit that binds every request, or a model
// family name for a limit that binds only that family; the label names the
// window the provider reports (for example `primary` or `secondary`). Each key
// holds one entry, which is either a reading, a retirement tombstone (the key
// held a reading until an authoritative observation stopped reporting it), or
// an absence record (an authoritative observation reported the key as having
// no limit before any reading was seen). Tombstones and absence records are
// evidence that the key is known to be unlimited; a missing key is unknown.
//
// Beside the limits sits the credit budget, a third pressure axis with its own
// reset clock. It is a tri-state: absent (never reported), a reading, or
// cleared (the provider reported that no budget exists).
//
// The map is plain JSON so the store can persist it without interpreting it.
/** The scope of a limit that binds every request regardless of model. */
export const ALL_SCOPE = 'all';
/** The window label required when an admission call supplies none. */
export const DEFAULT_REQUIRED_LABELS = Object.freeze([
    'primary',
]);
export function emptyQuotaMap() {
    return { limits: [] };
}
/** The time an entry speaks for: its reading, retirement or absence time. */
export function entryTime(entry) {
    return entry.kind === 'retired' ? entry.retiredAt : entry.checkedAt;
}
export function limitKey(scope, label) {
    // JSON-encoding the pair keeps keys unambiguous for any scope or label text.
    return JSON.stringify([scope, label]);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isName(value) {
    return typeof value === 'string' && value.length > 0;
}
function optional(record, key, check) {
    return record[key] === undefined || check(record[key]);
}
function isPositiveFinite(value) {
    return isFiniteNumber(value) && value > 0;
}
function isString(value) {
    return typeof value === 'string';
}
function isQuotaEntry(value) {
    if (!isRecord(value) || !isName(value.scope) || !isName(value.label)) {
        return false;
    }
    switch (value.kind) {
        case 'reading':
            return (isFiniteNumber(value.checkedAt) &&
                isFiniteNumber(value.usedPercent) &&
                optional(value, 'resetsAt', isString) &&
                optional(value, 'windowMinutes', isPositiveFinite));
        case 'retired':
            return isFiniteNumber(value.retiredAt);
        case 'absent':
            return isFiniteNumber(value.checkedAt);
        default:
            return false;
    }
}
export function isCreditBudgetEntry(value) {
    if (!isRecord(value) || !isFiniteNumber(value.checkedAt))
        return false;
    if (value.kind === 'cleared')
        return true;
    return (value.kind === 'reading' &&
        typeof value.reached === 'boolean' &&
        optional(value, 'remainingPercent', isFiniteNumber) &&
        optional(value, 'usedPercent', isFiniteNumber) &&
        optional(value, 'resetsAt', isString) &&
        optional(value, 'limit', isFiniteNumber) &&
        optional(value, 'used', isFiniteNumber) &&
        optional(value, 'remaining', isFiniteNumber) &&
        optional(value, 'unit', isString));
}
/**
 * True when `value` is a well-formed quota map. Unrecognised top-level keys
 * are tolerated (and preserved by merge) so a newer writer's additions
 * survive; a malformed entry, a duplicated (scope, label) key or a malformed
 * budget makes the whole map invalid.
 */
export function isQuotaMap(value) {
    if (!isRecord(value) || !Array.isArray(value.limits))
        return false;
    const seen = new Set();
    for (const entry of value.limits) {
        if (!isQuotaEntry(entry))
            return false;
        const key = limitKey(entry.scope, entry.label);
        if (seen.has(key))
            return false;
        seen.add(key);
    }
    return optional(value, 'budget', isCreditBudgetEntry);
}
