/**
 * Optional THALAMUS routing for vault mode and advisory turn notes for request
 * shaping. Account ids are vault account ids, not local pool rows. Nothing is
 * persisted here; plugins on routes the runner does not serve get no turn notes.
 */
import { type CacheWarmStopReason } from './cache-policy.js';
export type { CacheTouchInput, CacheWarmStoppedInput, CacheWarmStopReason, SessionCacheHours, SessionCachePolicy, SessionCacheTtl, SessionKeepWarmMode, SessionToolWait, } from './cache-policy.js';
export { CACHE_WARM_STOP_REASONS, isCacheWarmStopReason, reportCacheTouch, reportCacheWarmStopped, sessionCachePolicy, sessionToolWait, } from './cache-policy.js';
/** An eligible vault route, not a local pool row. */
export interface RoutingCandidate {
    /** Vault account id, not the plugin's route id. */
    accountId: string;
    credentialId: string;
}
export interface AskRoutingInput<Candidate extends RoutingCandidate = RoutingCandidate, Refusals extends boolean = false> {
    sessionId: string;
    provider: string;
    modelId: string;
    /** Only routes already eligible under the plugin's vault and killswitch rules. */
    candidates: readonly Candidate[];
    /** Defaults to 1500 ms, above routing's normal tail; clamped to 1–2000 ms. */
    deadlineMs?: number;
    /** Opt in to refusals, which stop the request instead of using a local choice. */
    refusals?: Refusals;
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
export type RoutingRefusal = {
    refused: {
        code: 'account_limit_exhausted' | 'account_selection_refused' | 'account_selection_final';
        routingCode?: string;
        retryAfterSecs?: number;
        resetsAtMs?: number;
    };
};
interface RoutingReportIdentity {
    sessionId: string;
    accountId: string;
    credentialId?: string;
}
export type BillingRequestKind = 'primary' | 'title' | 'compaction' | 'generate' | 'keep_warm' | 'prime';
export type BillingOutcome = 'completed' | 'cut' | 'failed';
/** Omit unread counts; zero represents a measured count, not a default. */
export interface BillingUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    reasoningIncludedInOutput?: boolean;
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
} | {
    /**
     * A provider's typed refusal that condemns the API key until it is
     * topped up, such as an exhausted prepaid balance. Never use for
     * 401, 403 or short rate limits.
     */
    outcome: 'credential_refused';
    credentialId: string;
    /**
     * What the provider actually sent: its own code from the structured
     * error (OpenRouter's `openrouter_credits`). When the body carries
     * no code, `http_<status>`, but only for a status the provider
     * documents with a single balance meaning (DeepSeek's `http_402`).
     * Never message text, and never a status with several meanings such
     * as 403 or 429. Must match `^[a-z0-9._-]{1,64}$`.
     */
    providerCode: string;
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
} | {
    sessionId: string;
    kind: 'billing';
    attemptId: string;
    requestKind: BillingRequestKind;
    credentialId: string;
    accountId?: string;
    provider: string;
    model: string;
    outcome: BillingOutcome;
    providerRequestId?: string;
    providerResponseId?: string;
    userMessageId?: string;
    status?: number;
    attempt?: number;
    chargeBasis?: 'subscription_included' | 'metered_api';
    usage?: BillingUsage;
    usageByModel?: readonly {
        modelUsed: string;
        usage: BillingUsage;
    }[];
    cache?: {
        ttlMs?: number;
        implicit?: true;
        warming?: {
            on: boolean;
            stopReason?: CacheWarmStopReason;
        };
    };
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
 * yields undefined so the plugin can keep its own choice. Opted-in routing
 * refusals instead stop the request. This does not admit routes: callers must
 * exclude vault refusals and killswitch-blocked accounts.
 */
export declare function askRouting<Candidate extends RoutingCandidate, Refusals extends boolean = false>(input: AskRoutingInput<Candidate, Refusals>): Promise<RoutingSelection<Candidate> | (Refusals extends true ? RoutingRefusal : never) | undefined>;
/**
 * Report a vault request, billing result or turn-note event without waiting for
 * routing. Only contract fields are sent, and all accessor failures are ignored.
 * Headers must already be limited to rate-limit headers by the caller; values
 * are not filtered or redacted here.
 */
export declare function reportRouting(input: ReportRoutingInput): void;
