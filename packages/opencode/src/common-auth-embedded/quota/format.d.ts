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
 */
export type QuotaTextForm = 'compact' | 'full';
export interface QuotaTextOptions {
    /** The current time in ms, for reset countdowns and the stale marker. */
    now: number;
    /** Defaults to `full`. */
    form?: QuotaTextForm;
    /** Defaults to `QUOTA_STALE_AFTER_MS`. */
    staleAfterMs?: number;
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
 * The pieces of a quota text, in order: one per reported window
 * (`5h 58% left, resets 2h`), then the credit budget when there is one, then
 * `checked 3h ago` when the oldest piece shown is stale. Empty when nothing
 * was reported; `formatQuota` turns that into a sentence. A caller printing
 * one line per window (the terminal auth menu) uses these directly.
 */
export declare function quotaTextParts(quota: ProjectedQuota | undefined, options: QuotaTextOptions): string[];
/**
 * A row's quota as one line: `5h 58% left · 7d 90% left` in the compact
 * form, with `, resets 2h` after each window in the full form. With nothing
 * reported it is `NO_QUOTA_READING`, or `NO_LIMITS_REPORTED` when the
 * provider answered without a limit for any window.
 */
export declare function formatQuota(quota: ProjectedQuota | undefined, options: QuotaTextOptions): string;
