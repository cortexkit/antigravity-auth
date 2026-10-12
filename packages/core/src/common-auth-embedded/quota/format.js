// The one quota wording every surface shows: the command menu's dialogs on
// OpenCode and Pi, the terminal auth menu, and the plugins' sidebars. Each of
// them calls `formatQuota` (or `quotaTextParts` for one line per window), so
// the wording cannot drift between plugins or between a dialog and a sidebar.
//
// The rules: a window is named by its length (`5h`, `7d`), or, for a window
// that binds only one model family, by the label the plugin stored it under.
// Every figure is "% left". A window the provider did not report (an absence
// record or a retirement tombstone) is left out rather than written as "not
// reported". A reset is a short time from now (`resets 2h`). A reading older
// than fifteen minutes says how old it is (`checked 3h ago`).
//
// Like the rest of this module it reads no clock: `now` is a parameter.
import { ALL_SCOPE } from './map.js';
/** A reading older than this is marked with its age. */
export const QUOTA_STALE_AFTER_MS = 15 * 60_000;
/** What `formatQuota` returns when there is no reading at all. */
export const NO_QUOTA_READING = 'no quota reading yet';
/**
 * What `formatQuota` returns when the provider answered but reported no
 * limit for any window (every window is an absence record or a tombstone).
 */
export const NO_LIMITS_REPORTED = 'no limits reported';
/**
 * A length or a time span in its largest whole-ish unit: `45m`, `5h`, `3d`.
 * Spans under an hour are minutes, under a day hours, otherwise days, each
 * rounded to the nearest unit and never shown as zero.
 */
function shortSpan(ms) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return `${hours}h`;
    return `${Math.max(1, Math.round(minutes / 1440))}d`;
}
/** A stored window length in minutes as its exact name: `5h`, `7d`, `90m`. */
function lengthName(minutes) {
    if (minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}
/**
 * The name a window is shown under. A general window (scope `all`) is named
 * by its stored length; a model-scoped window keeps the label the plugin
 * stored it under, which already names the model (`seven_day_opus`). A
 * general window stored without a length (a snapshot from before lengths
 * were recorded) falls back to its label.
 */
export function quotaWindowName(limit) {
    if (limit.scope !== ALL_SCOPE || limit.windowMinutes === undefined)
        return limit.label;
    return lengthName(limit.windowMinutes);
}
function percentLeft(remaining) {
    return `${Math.round(Math.min(100, Math.max(0, remaining)))}% left`;
}
function resetText(resetsAt, now) {
    if (resetsAt === undefined)
        return '';
    const at = Date.parse(resetsAt);
    // A reset already passed says nothing about the future; leave it out.
    if (!Number.isFinite(at) || at <= now)
        return '';
    return `, resets ${shortSpan(at - now)}`;
}
/** Shortest window first, so `5h` reads before `7d`; unknown lengths last. */
function displayOrder(left, right) {
    const l = left.windowMinutes;
    const r = right.windowMinutes;
    if (l !== undefined && r !== undefined && l !== r)
        return l - r;
    if ((l === undefined) !== (r === undefined))
        return l === undefined ? 1 : -1;
    if (left.scope !== right.scope) {
        if (left.scope === ALL_SCOPE)
            return -1;
        if (right.scope === ALL_SCOPE)
            return 1;
        return left.scope < right.scope ? -1 : 1;
    }
    return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
}
/**
 * The pieces of a quota text, in order: one per reported window
 * (`5h 58% left, resets 2h`), then the credit budget when there is one, then
 * `checked 3h ago` when the oldest piece shown is stale. Empty when nothing
 * was reported; `formatQuota` turns that into a sentence. A caller printing
 * one line per window (the terminal auth menu) uses these directly.
 */
export function quotaTextParts(quota, options) {
    if (!quota)
        return [];
    const { now } = options;
    const full = (options.form ?? 'full') === 'full';
    const parts = [];
    const times = [];
    const readings = quota.limits
        .filter((limit) => limit.kind === 'reading' && limit.remainingPercent !== undefined)
        .sort(displayOrder);
    for (const limit of readings) {
        times.push(limit.checkedAt);
        parts.push(`${quotaWindowName(limit)} ${percentLeft(limit.remainingPercent ?? 0)}${full ? resetText(limit.resetsAt, now) : ''}`);
    }
    const budget = quota.budget;
    if (budget) {
        times.push(budget.checkedAt);
        const figure = budget.reached
            ? 'credits spent'
            : budget.remainingPercent !== undefined
                ? `credits ${percentLeft(budget.remainingPercent)}`
                : 'credits available';
        parts.push(`${figure}${full ? resetText(budget.resetsAt, now) : ''}`);
    }
    if (times.length > 0) {
        const age = now - Math.min(...times);
        if (age > (options.staleAfterMs ?? QUOTA_STALE_AFTER_MS))
            parts.push(`checked ${shortSpan(age)} ago`);
    }
    return parts;
}
/**
 * A row's quota as one line: `5h 58% left · 7d 90% left` in the compact
 * form, with `, resets 2h` after each window in the full form. With nothing
 * reported it is `NO_QUOTA_READING`, or `NO_LIMITS_REPORTED` when the
 * provider answered without a limit for any window.
 */
export function formatQuota(quota, options) {
    const parts = quotaTextParts(quota, options);
    if (parts.length > 0)
        return parts.join(' · ');
    return quota && quota.limits.length > 0
        ? NO_LIMITS_REPORTED
        : NO_QUOTA_READING;
}
