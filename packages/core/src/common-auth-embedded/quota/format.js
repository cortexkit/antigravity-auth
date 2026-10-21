// The one quota wording every surface shows: the command menu's dialogs on
// OpenCode and Pi, the terminal auth menu, and the plugins' sidebars. Each of
// them calls `formatQuota`, `quotaTextParts`, or `quotaWindowParts`, so the
// wording cannot drift between plugins or between a dialog and a sidebar.
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
 * A time span in at most its two largest units: `45m`, `2h29m`, `5h`, `3d23h`,
 * `7d`. Every unit is rounded down, so a reset is never shown later than it is;
 * the one exception is a span under a minute, which reads `1m` rather than
 * zero. A zero second unit is left out.
 */
function shortSpan(ms) {
    const minutes = Math.max(1, Math.floor(ms / 60_000));
    if (minutes < 60)
        return `${minutes}m`;
    if (minutes < 1440) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
    }
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return hours === 0 ? `${days}d` : `${days}d${hours}h`;
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
function clampPercent(remaining) {
    return Math.min(100, Math.max(0, remaining));
}
/** A remaining percentage as the whole number every form shows. */
function wholePercent(remaining) {
    return Math.round(clampPercent(remaining));
}
function percentLeft(remaining) {
    return `${wholePercent(remaining)}% left`;
}
function resetDetails(resetsAt, checkedAt, now) {
    const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
    return {
        ...(Number.isFinite(at) && at > now
            ? { resetIn: shortSpan(at - now) }
            : {}),
        resetSinceReading: Number.isFinite(at) && at > checkedAt && at <= now,
    };
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
 * Structured quota wording for layouts that need one row per window. The
 * windows use the same filtering and order as `quotaTextParts`; future resets
 * and the optional age keep the shared formatter's wording.
 */
export function quotaWindowParts(quota, options) {
    const { windows, age } = scopedWindowParts(quota, options);
    const parts = windows.map(({ part }) => part);
    return age === undefined ? { windows: parts } : { windows: parts, age };
}
/**
 * The narrow label of each scoped window part, as `narrowTextParts` names
 * them: model short names are worked out over every model-scoped window in
 * the reading, so two models never share a short name.
 */
function withShortNames(windows) {
    const abbreviations = scopeAbbreviations(windows
        .filter(({ part, scope }) => part.kind === 'window' && scope !== ALL_SCOPE)
        .map(({ scope }) => scope));
    for (const window of windows) {
        window.part.short =
            window.part.kind === 'budget'
                ? 'cr'
                : window.scope === ALL_SCOPE
                    ? window.part.name
                    : (abbreviations.get(window.scope) ?? window.scope);
    }
    return windows;
}
/**
 * `quotaWindowParts` with each window's scope kept beside it. The narrow form
 * needs the scope to name and pick model-scoped windows; the public parts do
 * not carry it, so their shape stays as it was.
 */
function scopedWindowParts(quota, options) {
    if (!quota)
        return { windows: [] };
    const { now } = options;
    const readings = quota.limits
        .filter((limit) => limit.kind === 'reading' && limit.remainingPercent !== undefined)
        .sort(displayOrder);
    const windows = readings.map((limit) => {
        const remainingPercent = clampPercent(limit.remainingPercent ?? 0);
        return {
            scope: limit.scope,
            ...(limit.windowMinutes === undefined
                ? {}
                : { windowMinutes: limit.windowMinutes }),
            part: {
                kind: 'window',
                name: quotaWindowName(limit),
                short: '',
                figure: percentLeft(limit.remainingPercent ?? 0),
                remainingPercent,
                checkedAt: limit.checkedAt,
                ...resetDetails(limit.resetsAt, limit.checkedAt, now),
            },
        };
    });
    const budget = quota.budget;
    if (budget) {
        const remainingPercent = budget.remainingPercent;
        const figure = budget.reached
            ? 'credits spent'
            : remainingPercent !== undefined
                ? `credits ${percentLeft(remainingPercent)}`
                : 'credits available';
        windows.push({
            scope: ALL_SCOPE,
            spent: budget.reached,
            part: {
                kind: 'budget',
                name: 'credits',
                short: '',
                figure,
                ...(remainingPercent === undefined
                    ? {}
                    : { remainingPercent: clampPercent(remainingPercent) }),
                checkedAt: budget.checkedAt,
                ...resetDetails(budget.resetsAt, budget.checkedAt, now),
            },
        });
    }
    withShortNames(windows);
    if (windows.length > 0) {
        const age = now - Math.min(...windows.map(({ part }) => part.checkedAt));
        if (age > (options.staleAfterMs ?? QUOTA_STALE_AFTER_MS)) {
            return { windows, age: `checked ${shortSpan(age)} ago` };
        }
    }
    return { windows };
}
/**
 * Whether the reading is stale: true exactly when the compact and full forms
 * would end with `checked … ago`. The narrow form leaves that age out to stay
 * short, so a caller drawing a narrow line uses this to dim it instead.
 */
export function isQuotaStale(quota, options) {
    return scopedWindowParts(quota, options).age !== undefined;
}
/**
 * The model a scope names, as a display name: any namespace before a colon
 * is dropped (`model:claude-opus-4` → `claude-opus-4`) and the first letter is
 * capitalized (`fable` → `Fable`); the rest stays as written.
 */
function scopeDisplayName(scope) {
    const model = scope.slice(scope.indexOf(':') + 1);
    return model.charAt(0).toUpperCase() + model.slice(1);
}
/**
 * Short names for the model scopes in one row: the first two letters of each
 * display name. Names that would read the same for different models are each
 * extended one letter at a time until they differ (`Fable` and `Fabric` read
 * `Fabl` and `Fabr`); a name that runs out of letters stays whole.
 */
function scopeAbbreviations(scopes) {
    const names = [...new Set(scopes.map(scopeDisplayName))];
    const lengths = new Map(names.map((name) => [name, 2]));
    const short = (name) => name.slice(0, lengths.get(name));
    for (;;) {
        const byShort = new Map();
        for (const name of names) {
            byShort.set(short(name), [...(byShort.get(short(name)) ?? []), name]);
        }
        let extended = false;
        for (const group of byShort.values()) {
            if (group.length < 2)
                continue;
            for (const name of group) {
                const length = lengths.get(name) ?? 2;
                if (length < name.length) {
                    lengths.set(name, length + 1);
                    extended = true;
                }
            }
        }
        if (!extended)
            break;
    }
    return new Map(scopes.map((scope) => [scope, short(scopeDisplayName(scope))]));
}
/** The most groups a grouped narrow line shows. */
const NARROW_GROUP_LIMIT = 2;
/**
 * The names the groups read under in the narrow line, one per listed group:
 * each label's short name, derived exactly as a model window's is (`Gemini`
 * → `Ge`, `Other models` → `Ot`, colliding names extended until they
 * differ), computed over every listed group so a group keeps its name
 * whichever groups show. A blank label falls back to the group's scope.
 */
function groupShortNames(groups) {
    const labels = groups.map((group) => group.label.trim() || group.scope);
    const short = scopeAbbreviations(labels);
    return labels.map((label) => short.get(label) ?? label);
}
/**
 * The narrow line of a reading whose windows belong to named groups and that
 * has no account-wide window: for each group, its tightest window as
 * `Ge 7d 62%`, with ` left` once at the end. The tightest window is the
 * one with least left, compared before rounding; on a tie the first in
 * display order (the shorter window) wins. At most two groups show: the two
 * with least left, earlier-listed first on a tie, and always in the order
 * the reading lists them, so the line does not reorder as the figures move.
 * A group with no reported window is skipped. Windows outside the listed
 * groups and the credit budget are left out. Undefined when the rule does
 * not apply, so the caller uses the ordinary narrow rule.
 */
function groupedNarrowPieces(groups, windows) {
    if (!groups || groups.length === 0)
        return undefined;
    const reported = windows.filter(({ part }) => part.kind === 'window');
    if (reported.some(({ scope }) => scope === ALL_SCOPE))
        return undefined;
    const candidates = groups.flatMap((group, listed) => {
        const inGroup = reported.filter(({ scope }) => scope === group.scope);
        // `windows` is already in display order, and strictly lower wins, so on
        // a tie the shorter window keeps the place.
        const groupTightest = inGroup.reduce((least, window) => least === undefined ||
            (window.part.remainingPercent ?? 0) < (least.part.remainingPercent ?? 0)
            ? window
            : least, undefined);
        return groupTightest ? [{ group, listed, window: groupTightest }] : [];
    });
    if (candidates.length === 0)
        return undefined;
    const names = groupShortNames(groups);
    const left = (candidate) => candidate.window.part.remainingPercent ?? 0;
    const shown = [...candidates]
        .sort((a, b) => left(a) - left(b) || a.listed - b.listed)
        .slice(0, NARROW_GROUP_LIMIT)
        .sort((a, b) => a.listed - b.listed);
    return shown.map((candidate, index) => {
        const { windowMinutes } = candidate.window;
        const piece = [
            names[candidate.listed] ?? candidate.group.scope,
            ...(windowMinutes === undefined ? [] : [lengthName(windowMinutes)]),
            `${wholePercent(left(candidate))}%`,
        ].join(' ');
        return index === shown.length - 1 ? `${piece} left` : piece;
    });
}
/**
 * The narrow form's pieces: every account-wide window as `5h 92%`, then at
 * most one more item, with ` left` added once to the last piece. That item is
 * the tightest (least remaining) of the model-scoped windows and the credit
 * budget, so the line stays bounded whatever the account carries: a scoped
 * window reads under its short model name (`Fa 98%`), the budget as `cr 75%`
 * (`cr 0%` when spent). On a tie a scoped window wins over the budget, and
 * among scoped windows the first in display order wins. The choice depends
 * only on the reading, never on a width. A budget without a percentage cannot
 * be chosen; when nothing at all is shown it keeps its compact wording
 * (`credits available`). No age is added; `isQuotaStale` says whether the
 * reading is stale. A window whose reset arrived after the reading keeps its
 * figure, as in the other forms. A reading that lists named groups and has no
 * account-wide window reads one item per group instead (see
 * `groupedNarrowPieces`).
 */
function narrowTextParts(quota, options) {
    const { windows } = scopedWindowParts(quota, options);
    const grouped = groupedNarrowPieces(quota?.groups, windows);
    if (grouped)
        return grouped;
    const general = windows.filter(({ part, scope }) => part.kind === 'window' && scope === ALL_SCOPE);
    const scoped = windows.filter(({ part, scope }) => part.kind === 'window' && scope !== ALL_SCOPE);
    // The items competing for the one slot after the account-wide windows, in
    // tie-break order: scoped windows in display order, then the budget. A
    // spent budget counts as 0% left; one without a percentage cannot compete.
    // Their labels are the parts' short names, so the narrow line and a layout
    // reading `short` always agree.
    const budget = windows.find(({ part }) => part.kind === 'budget');
    const budgetLeft = budget?.spent ? 0 : budget?.part.remainingPercent;
    const extras = [
        ...scoped.map(({ part }) => ({
            label: part.short,
            remaining: part.remainingPercent ?? 0,
        })),
        ...(budgetLeft === undefined || budget === undefined
            ? []
            : [{ label: budget.part.short, remaining: budgetLeft }]),
    ];
    // Strictly lower wins, so on a tie the earlier item keeps the slot.
    const tightest = extras.reduce((best, item) => best === undefined || item.remaining < best.remaining ? item : best, undefined);
    const pieces = general.map(({ part }) => `${part.name} ${wholePercent(part.remainingPercent ?? 0)}%`);
    if (tightest) {
        pieces.push(`${tightest.label} ${wholePercent(tightest.remaining)}%`);
    }
    if (pieces.length === 0)
        return windows.map(({ part }) => part.figure);
    return pieces.map((piece, index) => index === pieces.length - 1 ? `${piece} left` : piece);
}
/**
 * The pieces of a quota text, in order: one per reported window
 * (`5h 58% left, resets 2h`), then the credit budget when there is one, then
 * `checked 3h ago` when the oldest piece shown is stale. Empty when nothing
 * was reported; `formatQuota` turns that into a sentence. A caller printing
 * one line per window (the terminal auth menu) uses these directly. In the
 * narrow form the pieces are the narrow line's (`5h 92%`, `7d 66% left`).
 */
export function quotaTextParts(quota, options) {
    if (options.form === 'narrow')
        return narrowTextParts(quota, options);
    const parts = quotaWindowParts(quota, options);
    const full = (options.form ?? 'full') === 'full';
    const text = parts.windows.map((part) => {
        const reset = full && part.resetIn ? `, resets ${part.resetIn}` : '';
        return `${part.kind === 'budget' ? '' : `${part.name} `}${part.figure}${reset}`;
    });
    return parts.age === undefined ? text : [...text, parts.age];
}
/**
 * A row's quota as one line: `5h 58% left · 7d 90% left` in the compact
 * form, with `, resets 2h` after each window in the full form, and
 * `5h 58% · 7d 90% left` in the narrow form. With nothing
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
/**
 * Prepaid credits as one short value, worded as the official Codex client's
 * status view words them: `Unlimited` for unlimited credits, `<n> credits`
 * for a finite positive balance (rounded to a whole number), `Available` when
 * the account has credits but no usable balance was reported, and undefined
 * when the account has no credits (or `credits` is undefined), so a caller
 * shows no credits row at all. Unlimited wins even when `hasCredits` is false.
 * No other formatter adds this text; a caller that wants a credits row asks
 * for it.
 */
export function quotaCreditsText(credits) {
    if (credits === undefined)
        return undefined;
    if (credits.unlimited)
        return 'Unlimited';
    if (!credits.hasCredits)
        return undefined;
    const { balance } = credits;
    return typeof balance === 'number' && Number.isFinite(balance) && balance > 0
        ? `${Math.round(balance)} credits`
        : 'Available';
}
