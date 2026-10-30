import type { QuotaObservation } from '../quota/index.js';
import { type ClaustrumConsumer, type ClaustrumConsumerOptions } from './consumer.js';
import { type ClassifyingClaustrumFamily, type ClaustrumScopedClient, ClaustrumScopedCustody, type IdentityParser, type KeptReceiptState, type VaultGrantReach } from './custody.js';
import { type ClaustrumLogger } from './errors.js';
import { type AccountMapper, type VaultRosterFile } from './roster.js';
import { type WatchMode } from './watch.js';
export interface ClaustrumDiscoveryHubOptions {
    /**
     * The plugin's owner-only state directory. Member rosters live under
     * `<stateDir>/rosters/<hostGeneration>/<fingerprint>/<provider>.json`.
     */
    stateDir: string;
    /**
     * Which host generation this process runs (for example `opencode1`,
     * `opencode2` or `pi`). Hosts that classify rows differently keep separate
     * roster directories.
     */
    hostGeneration: string;
    /**
     * Everything the plugin's classifier decides with, as plain JSON: the
     * exact object it hands the classifier (its version, the supported-table
     * entries, the reserved provider set and every host fact it reads). The
     * hub hashes it, with the member set, `routePrefix` and `mapAccount`, into
     * the roster key, so processes whose classifiers or projections could
     * disagree never share a roster file. Configuration that `mapAccount`
     * reads, beyond its own source text, belongs here too.
     */
    classifierInput: unknown;
    /**
     * Every provider the plugin serves on this host, fixed for the hub's life.
     * Each is the `member` a classified row names and a roster file name, so
     * it is lowercase ASCII: letters, digits, `.`, `_` and `-`.
     */
    members: readonly string[];
    /** Prefix of every member's vault route ids; part of the roster key. */
    routePrefix?: string;
    /**
     * How every member presents a vault credential (the credential names its
     * member). Part of the roster key by its source text.
     */
    mapAccount?: AccountMapper;
    /** This host's enrollment token, written by setup. */
    tokenPath: string;
    /**
     * The plugin's classifying family. A legacy `ClaustrumFamily` names no
     * member for any row and is refused.
     */
    family: ClassifyingClaustrumFamily<string>;
    connect: () => Promise<ClaustrumScopedClient>;
    /**
     * How long one `connect()` attempt may take before the hub treats the vault
     * as unreachable (default 10 s, as `ClaustrumConsumerOptions`). The hub's
     * connect is shared by every member waiting for a lease, so an attempt that
     * never settles would hold every one of them; after the limit they get an
     * unreachable error and the next acquire connects again.
     */
    connectTimeoutMs?: number;
    /**
     * Whether the plugin takes its accounts from the vault. Read from local
     * state only, never from the vault: on every hub tick, and when a member
     * refreshes or authorizes. The first false read revokes every lease,
     * closes the connection and clears every member.
     */
    isCustodyActive?: () => boolean | Promise<boolean>;
    parseIdentity?: IdentityParser;
    /** As `ClaustrumConsumerOptions.requireAssertion`, for every member. */
    requireAssertion?: boolean;
    /**
     * How often the hub ticks (default 5 s). A tick reads authority, installs
     * member roster files another writer changed under the same view, and
     * lists when a list is due: on every tick while no vault watch is open,
     * when a pending member's retry is due (a member the last list did not
     * commit, retried with a backoff), otherwise every five minutes as a
     * safety net.
     */
    pollIntervalMs?: number;
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
    now?: () => number;
    logger?: ClaustrumLogger;
    /**
     * Errors of the hub's own tick, list and watch. A failed list and a vault
     * refusal of the watch also reach every member's `onError`.
     */
    onError?: (error: unknown) => void;
}
/**
 * What one hub member takes: only what is per provider. The hub owns the
 * roster path, the enrollment token, the family, the connection, the
 * authority check, the poll timer and the projection inputs that are part of
 * the roster key (`routePrefix`, `mapAccount`), so none of them can be given
 * here. The type parameter matches the consumer `member` returns; members
 * have no insula source.
 */
export interface ClaustrumHubMemberOptions<_Q = QuotaObservation> {
    /**
     * Ids of the plugin's local pool rows; no vault route id may equal one.
     * Read on every projection and install, so it may change at any time.
     */
    reservedRouteIds?: () => Iterable<string>;
    /** As `ClaustrumConsumerOptions.onRoster`: once per change of view. */
    onRoster?: (roster: VaultRosterFile) => void;
    /** Observe every hub discovery's member result, including background work. */
    onDiscovery?: ClaustrumConsumerOptions<_Q>['onDiscovery'];
    /** This member's own failures, such as a roster commit that failed. */
    onError?: (error: unknown) => void;
    logger?: ClaustrumLogger;
}
/** What a lease may do with the shared custody. */
export type ClaustrumLeasedCustody = Pick<ClaustrumScopedCustody, 'authorize' | 'reportFailure' | 'forget' | 'keptReceiptState'>;
/**
 * One acquisition of the hub's shared custody. `custody` throws `closed`
 * after `release()`, and once the connection it belongs to ended for any
 * reason, vault mode going off included. `release()` is idempotent.
 */
export interface CustodyLease {
    readonly custody: ClaustrumLeasedCustody;
    /** The connection this lease belongs to; each new connection counts up. */
    readonly generation: number;
    release(): void;
}
/** The rows the hub's last complete discovery refused or left to others. */
export interface ClaustrumHubRefusals {
    readonly view: string;
    readonly refused: readonly {
        credentialId?: string;
        code: string;
    }[];
    readonly notMine: number;
}
/**
 * One discovery hub per host process: the only vault connection and the only
 * `ClaustrumScopedCustody`, one vault watch and one list per refresh, fanned
 * out to one roster per provider. Members (`member()`) are ordinary
 * `ClaustrumConsumer`s that never connect, list or watch themselves; each
 * holds a custody lease. The connection stays open while vault mode is on,
 * because the hub's own discovery holds a lease of its own, and closes when
 * the last lease of a connection is released, when vault mode goes off, or
 * at `close()`.
 */
export declare class ClaustrumDiscoveryHub {
    #private;
    constructor(options: ClaustrumDiscoveryHubOptions);
    /** The roster file member `provider` reads and the hub commits. */
    rosterPath(provider: string): string;
    /**
     * Build the consumer for `provider`, once. It is an ordinary
     * `ClaustrumConsumer` whose roster path is `rosterPath(provider)`; it
     * connects, lists and watches only through this hub.
     */
    member<Q = QuotaObservation>(provider: string, options: ClaustrumHubMemberOptions<Q>): ClaustrumConsumer<Q>;
    /**
     * Take a lease on the current connection, connecting first when there is
     * none. The acquirer's count is taken before anything is awaited, so a
     * release elsewhere meanwhile cannot end the connection under it. An abort
     * or a failed connect gives that count back; an acquirer whose connection
     * ended while it waited tries once more on the current one. Rejects with
     * `not-active` while vault mode is off.
     */
    acquire(signal?: AbortSignal): Promise<CustodyLease>;
    /** The current connection and its lease count, for status and tests. */
    leaseState(): {
        readonly generation?: number;
        readonly count: number;
    };
    /**
     * Start the hub's tick, which runs until `close()`. While vault mode is
     * off a tick only reads authority and makes no vault request.
     */
    start(): void;
    /**
     * List once and commit every member, as a tick does. Resolves once every
     * member's memory holds its new roster. Rejects when the list fails; a
     * member's own commit error goes to that member's `onError`.
     */
    refresh(): Promise<void>;
    /**
     * Rows the last discovery every member committed refused, with their fixed
     * codes, and how many rows it left to other plugins. Undefined while
     * unknown: before a complete discovery, and while vault mode is off.
     */
    refusals(): ClaustrumHubRefusals | undefined;
    /** The grant reach of the same discovery as `refusals()`. */
    grantReach(): VaultGrantReach | undefined;
    /** How the hub learns about changes; `polling` until a watch is open. */
    watchState(): WatchMode;
    /** The shared custody's kept receipts, host-wide. */
    keptReceiptState(): KeptReceiptState;
    /**
     * Stop the tick and the watch and close the connection. Members are not
     * closed; they fail `closed` from then on. Use `dispose()` to also allow
     * in-flight discovery up to two seconds to release its file handles.
     */
    close(): void;
    /** Close immediately, then join background work for at most two seconds. */
    dispose(): Promise<void>;
}
