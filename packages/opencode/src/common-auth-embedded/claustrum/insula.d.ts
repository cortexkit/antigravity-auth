import type { ClaustrumClientOptions } from '@cortexkit/claustrum-client';
import { type WatchMode } from './watch.js';
/** Insula's window fields are open: plugins choose which limits they understand. */
export interface InsulaUsageWindow {
    usedPercent: number;
    rawUsedPercent?: number;
    resetsAt?: string;
    windowMinutes?: number;
    windowKind?: string;
    [field: string]: unknown;
}
export interface InsulaUsageEntry {
    provider: string;
    account?: string;
    fetchedAt?: string;
    source?: string;
    stale?: unknown;
    errorClass?: unknown;
    usage?: {
        primary?: InsulaUsageWindow;
        secondary?: InsulaUsageWindow;
        tertiary?: InsulaUsageWindow;
        extraRateWindows?: Array<{
            id?: string;
            title?: string;
            window?: InsulaUsageWindow;
        }>;
        [field: string]: unknown;
    };
    [field: string]: unknown;
}
export interface InsulaQuotaContext {
    /** Milliseconds since the epoch, parsed from the producer's fetchedAt. */
    fetchedAt: number;
    source?: string;
}
export interface InsulaQuotaOptions<Q> {
    provider: 'codex' | 'claude' | 'antigravity';
    /**
     * Set every converted window's reading time to context.fetchedAt, not poll
     * time. Return undefined for entries the plugin cannot use. Antigravity can
     * receive its own sidebar reading back from insula: accept it only from the
     * vault or when fetchedAt is newer than the plugin's last reading.
     */
    normalize: (entry: InsulaUsageEntry, context: InsulaQuotaContext) => Q | undefined;
}
/**
 * A held-open `usage.watch` stream. `closed` resolves when insula ends the
 * stream (STREAM_END at shutdown, or a reply that ends it) or after `stop()`,
 * and rejects with insula's refusal (an error with a `code`, such as
 * `unknown_method` from an insula that predates the method, or
 * `usage_watch_limit` when 64 watches are already open) or with the
 * transport failure.
 */
export interface InsulaUsageWatch {
    stop(): void;
    readonly closed: Promise<void>;
}
/** Optional transport for custom scoped clients; getUsage must not retry refusals. */
export interface InsulaUsageTransport {
    connectionFile: string;
    getUsage(): Promise<unknown>;
    /**
     * Open a `usage.watch` stream, passing each notice's raw JSON body to
     * `onNotice`. Optional: a transport without it is polled as before.
     */
    watchUsage?(onNotice: (body: Uint8Array) => void): InsulaUsageWatch;
}
/** Constructing this transport opens no connection; getUsage opens one per call. */
export declare function insulaUsageTransport(options: ClaustrumClientOptions & {
    connectionFile: string;
}): InsulaUsageTransport;
export interface InsulaWatchOptions {
    /**
     * The provider this watcher reads. A notice that names only other
     * providers then needs no read; unset means every notice does.
     */
    provider?: string;
    /**
     * setTimeout and clearTimeout for the waits before re-subscribing or retrying
     * a watch. Defaults to the global timers; tests inject virtual ones.
     */
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
}
export declare class InsulaQuotaSource {
    #private;
    private readonly transport;
    private readonly key;
    constructor(transport: InsulaUsageTransport, key: string);
    /**
     * The background poll: at most one usage.get per minute per daemon and
     * enrollment token. While a watch is open it reads nothing, because insula's
     * notices announce every new reading. If insula stops announcing an account,
     * that account's last entry grows older than the freshness limit `current()`
     * applies, `current()` returns nothing for it, and the plugin falls back to
     * its own provider poll for that account.
     */
    refresh(now: number): Promise<void>;
    /** How this source currently learns about usage changes, for logs. */
    watchMode(): WatchMode;
    /**
     * Hold a `usage.watch` open while any watcher wants it, and re-read
     * usage.get when a notice says something changed. Watchers of one source
     * share one watch, since insula admits only 64 per process. Returns the
     * release; the last release closes the watch.
     */
    watch(options?: InsulaWatchOptions): () => void;
    current(provider: string, accountId: string, now: number): {
        entry: InsulaUsageEntry;
        context: InsulaQuotaContext;
    } | undefined;
}
export declare function acquireInsulaQuotaSource(transport: InsulaUsageTransport, tokenPath: string): {
    source: InsulaQuotaSource;
    release(): void;
};
