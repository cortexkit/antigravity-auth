import { type QuotaCredits } from './map.js';
import type { ProjectedLimit, ProjectedQuota } from './projection.js';
/** A reading older than this is marked with its age. */
export declare const QUOTA_STALE_AFTER_MS: number;
/** What `formatQuota` returns when there is no reading at all. */
export declare const NO_QUOTA_READING = "no quota reading yet";
/**
 * What `formatQuota` returns when the provider answered but reported no
 * limit for any window (every window is an absence record or a tombstone).
 */
export declare const NO_LIMITS_REPORTED = "no limits reported";
/**
 * `compact` fits a footer or a sidebar row: each window's figure, the credit
 * budget and the stale marker, without reset times. `full` adds each reset.
 * `narrow` fits one line per account in a narrow sidebar: `5h 92% · 7d 66%
 * · Fa 98% left`, the account-wide windows plus at most one model-scoped
 * window or the budget (as `cr`), and no stale marker (see `isQuotaStale`).
 * A reading whose windows belong to named groups and that has no
 * account-wide window reads up to two groups instead:
 * `Ge 7d 62% · Ot 7d 48% left`.
 */
export type QuotaTextForm = 'compact' | 'full' | 'narrow';
export interface QuotaTextOptions {
    /** The current time in ms, for reset countdowns and the stale marker. */
    now: number;
    /** Defaults to `full`. */
    form?: QuotaTextForm;
    /** Defaults to `QUOTA_STALE_AFTER_MS`. */
    staleAfterMs?: number;
}
export interface QuotaWindowPart {
    kind: 'window' | 'budget';
    /** The display name of a quota window, or `credits` for the budget. */
    name: string;
    /**
     * The label the narrow line gives this item: an account-wide window keeps
     * its name (`5h`), a model-scoped window reads as its model's short name
     * (`Fa` for Fable, extended until names in the same reading differ), and
     * the budget reads `cr`. For layouts too narrow for the full name.
     */
    short: string;
    /** The shared figure wording, including `credits` for budget figures. */
    figure: string;
    /** The unrounded remaining percentage, clamped to 0–100, when known. */
    remainingPercent?: number;
    /** A bare relative reset span such as `4d`, only when the reset is future. */
    resetIn?: string;
    checkedAt: number;
    /** Whether the reset followed this reading and has arrived by `now`. */
    resetSinceReading: boolean;
}
export interface QuotaParts {
    /** Reported windows in display order, followed by the budget when present. */
    windows: QuotaWindowPart[];
    /** The shared checked-age wording, present only when the reading is stale. */
    age?: string;
}
/**
 * The name a window is shown under. A general window (scope `all`) is named
 * by its stored length; a model-scoped window keeps the label the plugin
 * stored it under, which already names the model (`seven_day_opus`). A
 * general window stored without a length (a snapshot from before lengths
 * were recorded) falls back to its label.
 */
export declare function quotaWindowName(limit: Pick<ProjectedLimit, 'scope' | 'label' | 'windowMinutes'>): string;
/**
 * Structured quota wording for layouts that need one row per window. The
 * windows use the same filtering and order as `quotaTextParts`; future resets
 * and the optional age keep the shared formatter's wording.
 */
export declare function quotaWindowParts(quota: ProjectedQuota | undefined, options: QuotaTextOptions): QuotaParts;
/**
 * Whether the reading is stale: true exactly when the compact and full forms
 * would end with `checked … ago`. The narrow form leaves that age out to stay
 * short, so a caller drawing a narrow line uses this to dim it instead.
 */
export declare function isQuotaStale(quota: ProjectedQuota | undefined, options: QuotaTextOptions): boolean;
/**
 * The pieces of a quota text, in order: one per reported window
 * (`5h 58% left, resets 2h`), then the credit budget when there is one, then
 * `checked 3h ago` when the oldest piece shown is stale. Empty when nothing
 * was reported; `formatQuota` turns that into a sentence. A caller printing
 * one line per window (the terminal auth menu) uses these directly. In the
 * narrow form the pieces are the narrow line's (`5h 92%`, `7d 66% left`).
 */
export declare function quotaTextParts(quota: ProjectedQuota | undefined, options: QuotaTextOptions): string[];
/**
 * A row's quota as one line: `5h 58% left · 7d 90% left` in the compact
 * form, with `, resets 2h` after each window in the full form, and
 * `5h 58% · 7d 90% left` in the narrow form. With nothing
 * reported it is `NO_QUOTA_READING`, or `NO_LIMITS_REPORTED` when the
 * provider answered without a limit for any window.
 */
export declare function formatQuota(quota: ProjectedQuota | undefined, options: QuotaTextOptions): string;
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
export declare function quotaCreditsText(credits: Pick<QuotaCredits, 'hasCredits' | 'unlimited' | 'balance'> | undefined): string | undefined;
