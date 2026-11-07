/**
 * Optional THALAMUS routing for vault mode and advisory turn notes for request
 * shaping. Account ids are vault account ids, not local pool rows. Nothing is
 * persisted here; plugins on routes the runner does not serve get no turn notes.
 */
export type { CacheTouchInput, CacheWarmStoppedInput, CacheWarmStopReason, SessionCacheHours, SessionCachePolicy, SessionCacheTtl, SessionKeepWarmMode, SessionToolWait, } from './cache-policy.js';
export { reportCacheTouch, reportCacheWarmStopped, sessionCachePolicy, sessionToolWait, } from './cache-policy.js';
/** An eligible vault route, not a local pool row. */
export interface RoutingCandidate {
    /** Vault account id, not the plugin's route id. */
    accountId: string;
    credentialId: string;
}
export interface AskRoutingInput<Candidate extends RoutingCandidate = RoutingCandidate> {
    sessionId: string;
    provider: string;
    modelId: string;
    /** Only routes already eligible under the plugin's vault and killswitch rules. */
    candidates: readonly Candidate[];
    /** Defaults to 500 ms, clamped to 1–2000 ms. */
    deadlineMs?: number;
    /**
     * Longest same-account hold, in seconds, that routing may advise. The
     * holdWaitMaxS helper from `./limits` caps it by the setting and the current
     * account's cache expiry, returning 0 when there is no accepted prompt cache
     * worth waiting for. Fractions are floored and negatives become 0. Omit it to leave
     * routing's default cap in force.
     */
    holdWaitMaxS?: number;
}
export interface RoutingHold {
    /** Uncapped advice from routing. The plugin must apply its own hold cap. */
    retry_after_ms: number;
}
export interface RoutingSelection<Candidate extends RoutingCandidate = RoutingCandidate> {
    /** The original eligible candidate, including any plugin-specific metadata. */
    candidate: Candidate;
    hold?: RoutingHold;
}
interface RoutingReportIdentity {
    sessionId: string;
    accountId: string;
    credentialId?: string;
}
export type ReportRoutingInput = (RoutingReportIdentity & ({
    outcome: 'served';
    /**
     * Pass only rate-limit headers, never the whole response headers.
     * Values are forwarded unchanged; do not include tokens, emails or labels.
     */
    headers: Readonly<Record<string, string>>;
} | {
    outcome: 'exhausted';
    /** The exhausted quota window; keep scoped quota groups in `pool`. */
    window: '5h' | '7d';
    /**
     * Scoped quota group, such as Antigravity's `3p` or `gemini`.
     * Must match `^[a-z0-9._-]{1,64}$`. Routing compares names exactly, so
     * callers must lowercase names from elsewhere (e.g. `Fable` to `fable`).
     * Names are never rewritten here. Omit or pass `undefined` to block the
     * whole account; include to block only this pool.
     */
    pool?: string;
    /** Optional reset time in epoch milliseconds. */
    resetsAt?: number;
})) | {
    sessionId: string;
    kind: 'turn_notes_supported';
    model: string;
    supported: boolean;
} | {
    sessionId: string;
    kind: 'turn_note_skipped';
    after_tool_use_id: string;
    reason: 'anchor_missing' | 'before_user_message' | 'unsupported_model' | 'not_oauth';
};
/**
 * Read advisory input for request shaping, in landing order, without persisting
 * it. If no routing handle is available or the runner does not serve the route,
 * returns [].
 */
export declare function turnNotes(sessionId: string): readonly {
    afterToolUseId: string;
    text: string;
}[];
/**
 * Ask routing for an eligible vault route. Any failure or unfamiliar answer
 * yields undefined so the plugin can keep its own choice. This does not admit
 * routes: callers must exclude vault refusals and killswitch-blocked accounts.
 */
export declare function askRouting<Candidate extends RoutingCandidate>(input: AskRoutingInput<Candidate>): Promise<RoutingSelection<Candidate> | undefined>;
/**
 * Report a vault request or turn-note event without waiting for routing. Only
 * contract fields are sent, and all accessor failures are ignored. Headers must
 * already be limited to rate-limit headers by the caller; values are not filtered
 * or redacted here.
 */
export declare function reportRouting(input: ReportRoutingInput): void;
