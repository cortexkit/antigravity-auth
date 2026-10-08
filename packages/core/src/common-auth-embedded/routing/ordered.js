// `ordered` routing: admitted rows tried in a fixed order, moving to the next
// row only when a response carries one of the caller's retry statuses.
import { admit, } from './admission.js';
/** The former main row's id when the caller supplies none. */
export const DEFAULT_FORMER_MAIN_ID = 'main';
/**
 * Resolves a persisted `routing.mode` value. `main-first` and
 * `fallback-first` are aliases of `ordered` that move the former main row;
 * an absent or unrecognised value is `ordered` in roster order. The
 * persisted value is only read here, never rewritten.
 */
export function resolveRoutingMode(value) {
    switch (value) {
        case 'sticky-balanced':
            return { mode: 'sticky-balanced', placement: 'roster' };
        case 'main-first':
            return { mode: 'ordered', placement: 'main-first' };
        case 'fallback-first':
            return { mode: 'ordered', placement: 'fallback-first' };
        default:
            return { mode: 'ordered', placement: 'roster' };
    }
}
/**
 * Orders `ids` (in roster order) for a placement: `main-first` moves the row
 * named `formerMainId` to the front, `fallback-first` to the back, and
 * `roster` (or a missing former main row) keeps roster order.
 */
export function orderForPlacement(ids, placement, formerMainId = DEFAULT_FORMER_MAIN_ID) {
    if (placement === 'roster' || !ids.includes(formerMainId))
        return [...ids];
    const rest = ids.filter((id) => id !== formerMainId);
    return placement === 'main-first'
        ? [formerMainId, ...rest]
        : [...rest, formerMainId];
}
export function routeOrdered(input) {
    const admission = admit(input);
    const admitted = new Set(admission.admitted.map((row) => row.id));
    const order = orderForPlacement(input.rows.map((row) => row.id), input.placement ?? 'roster', input.formerMainId).filter((id) => admitted.has(id) && input.killswitch?.get(id) !== false);
    return { order, admission };
}
/**
 * The next row to try, given the attempts so far: the first row when none
 * has been tried, the next untried row when the last attempt's status is one
 * of `retryStatuses`, and undefined otherwise (the last response stands) or
 * when every row has been tried.
 */
export function nextOrderedAttempt(order, attempts, retryStatuses) {
    const last = attempts.at(-1);
    if (last !== undefined) {
        if (last.status === undefined || !retryStatuses.includes(last.status)) {
            return undefined;
        }
    }
    const tried = new Set(attempts.map((attempt) => attempt.id));
    return order.find((id) => !tried.has(id));
}
