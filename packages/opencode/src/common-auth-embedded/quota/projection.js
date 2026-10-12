// Projection of a keyed quota map onto one request scope.
//
// The selection primitives carried from openai-auth judge an account by a
// short list of windows; the keyed map can hold many (scope, label) keys. The
// projection resolves exactly one entry per window label for the request's
// scope, orders the result the way the primitives expect, and carries each
// entry's (scope, label) so a decision names the limit it judged rather than
// the position it occupied.
import { ALL_SCOPE, } from './map.js';
function project(entry) {
    if (entry.kind === 'retired') {
        return {
            scope: entry.scope,
            label: entry.label,
            kind: 'retired',
            checkedAt: entry.retiredAt,
        };
    }
    if (entry.kind === 'absent') {
        return {
            scope: entry.scope,
            label: entry.label,
            kind: 'absent',
            checkedAt: entry.checkedAt,
        };
    }
    return {
        scope: entry.scope,
        label: entry.label,
        kind: 'reading',
        checkedAt: entry.checkedAt,
        usedPercent: entry.usedPercent,
        remainingPercent: 100 - entry.usedPercent,
        ...(entry.windowMinutes === undefined
            ? {}
            : { windowMinutes: entry.windowMinutes }),
        ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt }),
    };
}
function compareLimits(left, right) {
    const leftKnown = left.windowMinutes !== undefined;
    const rightKnown = right.windowMinutes !== undefined;
    if (leftKnown !== rightKnown)
        return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && left.windowMinutes !== right.windowMinutes) {
        return (right.windowMinutes ?? 0) - (left.windowMinutes ?? 0);
    }
    if (left.label !== right.label)
        return left.label < right.label ? -1 : 1;
    return 0;
}
function projectBudget(budget) {
    return {
        checkedAt: budget.checkedAt,
        reached: budget.reached,
        ...(budget.remainingPercent === undefined
            ? {}
            : { remainingPercent: budget.remainingPercent }),
        ...(budget.resetsAt === undefined ? {} : { resetsAt: budget.resetsAt }),
    };
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
export function projectQuota(map, scope = ALL_SCOPE) {
    const byLabel = new Map();
    for (const entry of map?.limits ?? []) {
        if (entry.scope !== scope && entry.scope !== ALL_SCOPE)
            continue;
        const current = byLabel.get(entry.label);
        if (current === undefined) {
            byLabel.set(entry.label, entry);
            continue;
        }
        const family = entry.scope === ALL_SCOPE ? current : entry;
        const general = entry.scope === ALL_SCOPE ? entry : current;
        byLabel.set(entry.label, family.kind === 'reading' ? family : general);
    }
    const limits = [...byLabel.values()].map(project).sort(compareLimits);
    const readings = limits.filter((limit) => limit.kind === 'reading');
    const stamped = readings.length > 0 ? readings : limits;
    const checkedAt = stamped.length > 0
        ? Math.min(...stamped.map((limit) => limit.checkedAt))
        : undefined;
    const budget = map?.budget?.kind === 'reading' ? projectBudget(map.budget) : undefined;
    return {
        scope,
        limits,
        ...(checkedAt === undefined ? {} : { checkedAt }),
        ...(budget === undefined ? {} : { budget }),
    };
}
/**
 * The credit budget's own exhaustion signal. Admission and the sticky
 * routing decision to move a session off its pinned row both use it, so the
 * two agree on what "spent" means. `reached` is the provider's
 * verdict (the percentage is only a display value), and the check fails open
 * on a missing, unparsable or already-passed reset.
 */
export function budgetExhaustedResetAt(quota, now) {
    const budget = quota?.budget;
    if (budget?.reached !== true || typeof budget.resetsAt !== 'string') {
        return undefined;
    }
    const resetAtMs = Date.parse(budget.resetsAt);
    if (!Number.isFinite(resetAtMs) || resetAtMs <= now)
        return undefined;
    return { resetsAt: budget.resetsAt, resetAtMs };
}
/** True for a reading at or beyond its whole window. */
export function readsExhausted(limit) {
    return (limit.kind === 'reading' &&
        typeof limit.usedPercent === 'number' &&
        Number.isFinite(limit.usedPercent) &&
        limit.usedPercent >= 100);
}
/** The reset time of a limit when it parses and lies after `now`. */
export function futureResetAt(limit, now) {
    if (typeof limit.resetsAt !== 'string')
        return undefined;
    const resetAtMs = Date.parse(limit.resetsAt);
    return Number.isFinite(resetAtMs) && resetAtMs > now ? resetAtMs : undefined;
}
