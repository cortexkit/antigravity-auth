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
export type ReportRoutingInput = RoutingReportIdentity & ({
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
     * Scoped quota group, such as `non-gemini`.
     * Must be a non-empty string without `:`. Omit to block the whole
     * account; include to block only this pool.
     */
    pool?: string;
    /** Optional reset time in epoch milliseconds. */
    resetsAt?: number;
});
/**
 * Ask routing for an eligible vault route. Any failure or unfamiliar answer
 * yields undefined so the plugin can keep its own choice. This does not admit
 * routes: callers must exclude vault refusals and killswitch-blocked accounts.
 */
export declare function askRouting<Candidate extends RoutingCandidate>(input: AskRoutingInput<Candidate>): Promise<RoutingSelection<Candidate> | undefined>;
/**
 * Report a vault request without waiting for routing. Only contract fields are
 * sent, and all accessor failures are ignored. Headers must already be limited
 * to rate-limit headers by the caller; values are not filtered or redacted here.
 */
export declare function reportRouting(input: ReportRoutingInput): void;
export {};
