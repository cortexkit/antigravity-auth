// `sticky-balanced` routing: openai-auth's quota-weighted session placement
// and pin-break classification, judged over the quota projection rather than
// openai-auth's fixed primary/secondary snapshot.
import { budgetExhaustedResetAt, projectQuota, } from '../quota/projection.js';
import { admit, } from './admission.js';
import { isPinValid } from './pins.js';
export const QUOTA_STALENESS_MS = 15 * 60_000;
export const MIN_RESET_HOURS = 1 / 60;
export const MIN_WEIGHT = 1e-6;
/** The projection's time, else the caller's cache-entry time. */
export function snapshotCheckedAt(quota, entryCheckedAt) {
    for (const checkedAt of [quota?.checkedAt, entryCheckedAt]) {
        if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
            return checkedAt;
        }
    }
    return undefined;
}
/**
 * The status rule used when the adapter supplies none, carried from
 * openai-auth: 401 and 403 are permanent; no response, 0, a non-finite
 * status, 429 and 5xx are transient; anything else leaves the row healthy.
 * A provider whose 403 can mean an organisation or model policy rather than
 * a dead account supplies its own classifier and can fall back to this one
 * for the statuses it does not single out.
 */
export function defaultStickyStatusClass(status) {
    if (status === 401 || status === 403)
        return 'permanent';
    if (status === undefined ||
        status === 0 ||
        !Number.isFinite(status) ||
        (status >= 500 && status <= 599) ||
        status === 429) {
        return 'transient';
    }
    return 'healthy';
}
function windowReadings(quota) {
    // Every reading is an independent constraint, so all of them are judged:
    // a third window (for example a short window beside two weekly ones) can
    // be the one that is nearly spent. Longest known window first, unknown
    // lengths last, as openai-auth sorts, so a break decision with several
    // spent windows names the longest. Tombstones and absence records carry no
    // capacity figure and are left out.
    return quota.limits
        .filter((limit) => limit.kind === 'reading')
        .sort((left, right) => {
        const leftKnown = left.windowMinutes !== undefined;
        const rightKnown = right.windowMinutes !== undefined;
        if (leftKnown !== rightKnown)
            return leftKnown ? -1 : 1;
        if (leftKnown && rightKnown) {
            return (right.windowMinutes ?? 0) - (left.windowMinutes ?? 0);
        }
        return 0;
    });
}
/** Classifies whether a pinned session should leave its row after a failure. */
export function decideStickyBreak(input) {
    const statusClass = (input.classifyStatus ?? defaultStickyStatusClass)(input.status);
    if (statusClass === 'permanent') {
        return { action: 'migrate', reason: 'permanent' };
    }
    if (!input.quota)
        return { action: 'retain', reason: 'unknown' };
    const checkedAt = snapshotCheckedAt(input.quota, input.quotaCheckedAt);
    if (checkedAt === undefined ||
        !Number.isFinite(checkedAt) ||
        input.now - checkedAt > QUOTA_STALENESS_MS) {
        return { action: 'retain', reason: 'stale' };
    }
    // After the stale check, so a stale snapshot never judges the account on a
    // reading the killswitch would consider below its floor.
    if (input.killswitchPasses === false) {
        return { action: 'migrate', reason: 'killswitch' };
    }
    for (const limit of windowReadings(input.quota)) {
        const remaining = limit.remainingPercent;
        if (typeof remaining === 'number' &&
            Number.isFinite(remaining) &&
            remaining <= 0) {
            return {
                action: 'migrate',
                reason: 'exhausted',
                window: { scope: limit.scope, label: limit.label },
                ...(typeof limit.resetsAt === 'string'
                    ? { resetsAt: limit.resetsAt }
                    : {}),
            };
        }
    }
    // A reached credit budget is exhaustion on its own axis, judged by the same
    // signal admission uses so the two never disagree on what "spent" means.
    const budgetReset = budgetExhaustedResetAt(input.quota, input.now);
    if (budgetReset) {
        return {
            action: 'migrate',
            reason: 'exhausted',
            resetsAt: budgetReset.resetsAt,
        };
    }
    return { action: 'retain', reason: statusClass };
}
export function sustainableWindowWeight(window, reservePercent, now) {
    const spendable = Math.max(0, window.remainingPercent - reservePercent);
    if (spendable <= 0)
        return 0;
    if (!window.resetsAt)
        return spendable;
    const resetMs = Date.parse(window.resetsAt);
    // A lapsed reset cannot yield a spend rate: the divisor would clamp to
    // MIN_RESET_HOURS and inflate the weight about sixty-fold on stale
    // information, so the un-rate-adjusted spendable capacity is used instead.
    if (!Number.isFinite(resetMs) || resetMs <= now)
        return spendable;
    const hours = Math.max((resetMs - now) / 3_600_000, MIN_RESET_HOURS);
    return spendable / hours;
}
function compareAccountIds(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function candidateWeight(candidate, now) {
    if (!candidate.quota)
        return undefined;
    const quotaCheckedAt = snapshotCheckedAt(candidate.quota, candidate.quotaCheckedAt);
    if (quotaCheckedAt === undefined ||
        now - quotaCheckedAt > QUOTA_STALENESS_MS) {
        return undefined;
    }
    // Missing reserve data must leave a window usable rather than silently
    // excluding its account.
    // The account is as constrained as its tightest window, whichever it is.
    const weights = windowReadings(candidate.quota).map((limit) => sustainableWindowWeight({
        remainingPercent: limit.remainingPercent ?? Number.NaN,
        ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
    }, candidate.reservePercent[limit.label] ?? 0, now));
    // The credit budget is a third pressure axis on its own reset clock. It has
    // no configured reserve, and a malformed reading is ignored rather than
    // allowed to zero the account's weight.
    const budget = candidate.quota.budget;
    if (budget &&
        typeof budget.remainingPercent === 'number' &&
        Number.isFinite(budget.remainingPercent)) {
        weights.push(sustainableWindowWeight({
            remainingPercent: budget.remainingPercent,
            ...(budget.resetsAt === undefined
                ? {}
                : { resetsAt: budget.resetsAt }),
        }, 0, now));
    }
    const weight = weights.length > 0 ? Math.min(...weights) : 0;
    return weight > 0 ? { candidate, quotaCheckedAt, weight } : undefined;
}
/**
 * Places a session: the lowest projected pressure among candidates with a
 * fresh positive weight, else (`mode-fallback`) the first candidate in
 * configured order, preferring one with an applicable reset credit.
 */
export function selectStickyCandidate(input) {
    // A candidate killed by the killswitch is excluded from BOTH weighted
    // placement and the fallback branch, which must never become a way to
    // spend on a killed account.
    const eligibleCandidates = input.candidates.filter((candidate) => candidate.killswitchPasses !== false);
    if (input.candidates.length === 0) {
        throw new Error('Cannot select a sticky candidate: input.candidates is empty');
    }
    if (eligibleCandidates.length === 0)
        return undefined;
    const weighted = eligibleCandidates
        .map((candidate) => candidateWeight(candidate, input.now))
        .filter((candidate) => candidate !== undefined);
    if (weighted.length > 0) {
        weighted.sort((left, right) => {
            // MIN_WEIGHT only guards the division; every weight here is positive.
            const leftScore = ((input.pendingBytes.get(left.candidate.accountId) ?? 0) +
                input.requestBytes) /
                Math.max(left.weight, MIN_WEIGHT);
            const rightScore = ((input.pendingBytes.get(right.candidate.accountId) ?? 0) +
                input.requestBytes) /
                Math.max(right.weight, MIN_WEIGHT);
            return (leftScore - rightScore ||
                left.candidate.configuredOrder - right.candidate.configuredOrder ||
                compareAccountIds(left.candidate.accountId, right.candidate.accountId));
        });
        const selected = weighted[0];
        if (selected) {
            return {
                accountId: selected.candidate.accountId,
                quotaCheckedAt: selected.quotaCheckedAt,
                source: 'weighted',
            };
        }
    }
    input.onEmptyWeightedSet?.();
    const fallback = [...eligibleCandidates].sort((left, right) => {
        const leftHasCredits = (left.resetCreditsApplicable ?? 0) > 0 ? 1 : 0;
        const rightHasCredits = (right.resetCreditsApplicable ?? 0) > 0 ? 1 : 0;
        return (rightHasCredits - leftHasCredits ||
            left.configuredOrder - right.configuredOrder ||
            compareAccountIds(left.accountId, right.accountId));
    })[0];
    if (!fallback) {
        throw new Error('Cannot select a sticky candidate: input.candidates is empty');
    }
    return {
        accountId: fallback.accountId,
        quotaCheckedAt: snapshotCheckedAt(fallback.quota, fallback.quotaCheckedAt),
        source: 'mode-fallback',
    };
}
/**
 * Routes one request in `sticky-balanced` mode. A valid pin whose row is
 * admitted, not excluded and not killed is dispatched as is. Otherwise
 * selection runs over the non-excluded rows; each selected row admission
 * refused is removed and selection re-runs, so the loop ends either on an
 * admitted row or with no admissible account.
 */
export function routeSticky(input) {
    const admission = admit(input);
    const admitted = new Map(admission.admitted.map((row) => [row.id, row]));
    const refusals = new Map(admission.refused.map((r) => [r.id, r]));
    const excluded = new Set(admission.excluded.map((row) => row.id));
    const validIds = new Set(input.rows.map((row) => row.id));
    const pinValid = input.pin !== undefined &&
        isPinValid(input.pin, validIds, input.identities?.get(input.pin.accountId));
    if (pinValid && input.pin) {
        const pinned = admitted.get(input.pin.accountId);
        if (pinned && input.killswitch?.get(pinned.id) !== false) {
            return {
                outcome: 'dispatch',
                accountId: pinned.id,
                source: 'pin',
                ...(pinned.projection?.checkedAt === undefined
                    ? {}
                    : { quotaCheckedAt: pinned.projection.checkedAt }),
                pin: { action: 'retain' },
                refusedSelections: [],
                admission,
            };
        }
    }
    // A spent window with a future reset, a spent credit budget and a killswitch
    // verdict all say the pinned row will not serve until some known later time,
    // so the pin may move. A row refused for want of a usable reading, or
    // excluded by a short rate-limit mark or refresh backoff, may serve again on
    // the next reading, so its pin stays.
    const pinRefusal = input.pin ? refusals.get(input.pin.accountId) : undefined;
    const pinMoves = pinValid &&
        input.pin !== undefined &&
        input.refusedPinPolicy === 'move-on-confirmed-exhaustion' &&
        (input.killswitch?.get(input.pin.accountId) === false ||
            pinRefusal?.reason === 'exhausted' ||
            pinRefusal?.reason === 'budget-spent');
    const reserveFor = (row) => {
        const perRow = typeof input.rowReservePercent === 'function'
            ? input.rowReservePercent(row)
            : input.rowReservePercent?.get(row.id);
        return perRow ?? input.reservePercent ?? {};
    };
    const scope = input.scope;
    let candidates = input.rows
        .map((row, configuredOrder) => ({ row, configuredOrder }))
        .filter(({ row }) => !excluded.has(row.id))
        .map(({ row, configuredOrder }) => {
        const killswitchPasses = input.killswitch?.get(row.id);
        const credits = input.resetCreditsApplicable?.get(row.id);
        return {
            accountId: row.id,
            quota: row.kind === 'api-key'
                ? undefined
                : (admitted.get(row.id)?.projection ??
                    projectQuota(row.quota, scope)),
            reservePercent: reserveFor(row),
            configuredOrder,
            ...(credits === undefined ? {} : { resetCreditsApplicable: credits }),
            ...(killswitchPasses === undefined ? {} : { killswitchPasses }),
        };
    });
    const refusedSelections = [];
    const unplaced = pinValid
        ? { action: 'retain' }
        : input.pin
            ? { action: 'clear' }
            : { action: 'none' };
    while (candidates.length > 0) {
        const selection = selectStickyCandidate({
            candidates,
            pendingBytes: input.pendingBytes ?? new Map(),
            requestBytes: input.requestBytes,
            now: input.now,
            ...(input.onEmptyWeightedSet
                ? { onEmptyWeightedSet: input.onEmptyWeightedSet }
                : {}),
        });
        if (!selection)
            break;
        const refusal = refusals.get(selection.accountId);
        if (refusal) {
            refusedSelections.push(refusal);
            candidates = candidates.filter((candidate) => candidate.accountId !== selection.accountId);
            continue;
        }
        const identity = input.identities?.get(selection.accountId);
        return {
            outcome: 'dispatch',
            accountId: selection.accountId,
            source: selection.source,
            ...(selection.quotaCheckedAt === undefined
                ? {}
                : { quotaCheckedAt: selection.quotaCheckedAt }),
            pin: pinValid && !pinMoves
                ? { action: 'retain' }
                : {
                    action: 'assign',
                    pin: {
                        accountId: selection.accountId,
                        inputBytes: input.requestBytes,
                        ...(identity === undefined ? {} : { wireIdentity: identity }),
                        ...(selection.quotaCheckedAt === undefined
                            ? {}
                            : { quotaCheckedAt: selection.quotaCheckedAt }),
                    },
                },
            refusedSelections,
            admission,
        };
    }
    return {
        outcome: 'no-admissible-account',
        pin: unplaced,
        refusedSelections,
        admission,
    };
}
