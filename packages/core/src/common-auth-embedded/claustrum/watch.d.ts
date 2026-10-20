import type { ClaustrumLogger } from './errors.js';
/**
 * How a host currently learns about changes, for logs and status displays.
 * `watching`: a watch was accepted and is open, so polling is reduced to a
 * slow safety read. `polling`: no watch is open yet (not started, opening, or
 * re-subscribing after a close), so the host polls at its usual interval.
 * `fallback`: the watch is unavailable (an older module or client, a refusal,
 * the watch limit, or repeated failures), so the host polls at its usual
 * interval and may try a watch again later. Never carries secrets.
 */
export type WatchMode = 'watching' | 'polling' | 'fallback';
/**
 * While a vault watch is healthy, the roster is still read this often: the
 * watch carries no history, so a lost notice or a silently dead stream is
 * caught within this period.
 */
export declare const SAFETY_POLL_MS: number;
/**
 * After a watch fails without being accepted, the host polls and tries one
 * new watch this much later, so a refusing or draining module is never asked
 * in a tight loop.
 */
export declare const WATCH_RETRY_MS: number;
/**
 * First wait before re-subscribing a watch that closed after it had been
 * accepted. It doubles for each further close in a row, up to WATCH_RETRY_MS.
 */
export declare const RESUBSCRIBE_BACKOFF_MS = 1000;
/**
 * The fields every change notice carries, from the vault's watchScoped and
 * insula's usage.watch alike.
 */
export interface ChangeNotice {
    readonly kind: string;
    readonly epoch: string;
    readonly seq: number;
}
/**
 * Tells whether a notice follows the previous one with nothing lost between
 * them. `seq` restarts at 1 for every watch and `epoch` names the sending
 * module's process lifetime. A sequence gap (notices are sheddable), a
 * different epoch (the module restarted) or a notice of an unknown kind all
 * mean changes may have been missed, so the caller must re-read everything.
 */
export declare class ChangeNoticeReader {
    #private;
    /**
     * Begin a new watch, whose first notice is seq 1 again. The epoch is kept,
     * so a module restart between two watches still reads as a break.
     */
    restart(): void;
    continuous(notice: ChangeNotice): boolean;
}
/**
 * Runs `read` with at most one call in flight and at most one more queued
 * behind it, however many requests arrive meanwhile. A request made while a
 * read is running may have arrived after that read took its snapshot, so it
 * earns exactly one more read; any further requests share that one.
 */
export declare class CoalescedRead {
    #private;
    constructor(read: () => Promise<void>, onError: (error: unknown) => void);
    /** The read in flight (including its queued follow-up), if any. */
    get running(): Promise<void> | undefined;
    request(): Promise<void>;
}
/** A vault watch notice: `view` is the same digest `list_scoped` returns. */
export interface ScopedWatchNoticeShape extends ChangeNotice {
    readonly view: string;
}
/**
 * How a vault watch ended, as claustrum-client 0.12.0 reports it. `refused`
 * and `not_accepting` both mean the watch closed before its first notice; the
 * client then made one `list_scoped` read to learn why, and `refused` carries
 * that read's refusal.
 */
export type ScopedWatchEnd = {
    readonly kind: 'refused';
    readonly error: unknown;
} | {
    readonly kind: 'transport_lost';
    readonly error: unknown;
} | {
    readonly kind: 'ended' | 'not_accepting' | 'unsupported' | 'stopped';
};
export interface ScopedWatchHandle {
    stop(): void;
    readonly closed: Promise<ScopedWatchEnd>;
}
/**
 * The part of a vault client that can watch. claustrum-client added
 * `watchScoped` in 0.12.0; the peer range still admits 0.6.2, so it is
 * optional and detected at run time.
 */
export interface ScopedWatchSource {
    watchScoped?(onNotice: (notice: ScopedWatchNoticeShape) => void, options?: {
        enrollmentToken?: string;
    }): ScopedWatchHandle;
}
export interface ScopedRosterWatchOptions {
    client: ScopedWatchSource;
    /** The enrollment token, read again for every watch so a new one is used. */
    enrollmentToken: () => Promise<string>;
    /** The view of the roster this host last discovered; undefined for none. */
    view: () => string | undefined;
    /**
     * The host's existing discovery: `list_scoped`, the roster commit and
     * everything that follows it. The watch never reads the vault list itself.
     * `view` is the view the newest notice carried.
     */
    discover: (view: string) => Promise<unknown>;
    /**
     * The vault refused the watch, and the confirming `list_scoped` read it
     * with this error (a revoked enrollment ends both with `not_found`). Handle
     * it as discovery handles the same refusal from `list_scoped`.
     */
    onRefused: (error: unknown) => void;
    onTransportLost?: () => void;
    onReachable?: () => void;
    onError?: (error: unknown) => void;
    onMode?: (mode: WatchMode) => void;
    logger?: ClaustrumLogger;
    now?: () => number;
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
}
/**
 * Keeps one vault `watchScoped` open for a host and runs the host's discovery
 * when a notice shows the visible account list changed. Discovery runs only
 * when the notice's view differs from the last discovered roster's view, when
 * a notice shows a gap or a new epoch, or on the first notice of a watch that
 * was re-subscribed after a close (the time between two watches was not
 * observed). It never opens a second watch while one is open.
 */
export declare class ScopedRosterWatch {
    #private;
    constructor(options: ScopedRosterWatchOptions);
    get mode(): WatchMode;
    start(): void;
    stop(): void;
}
