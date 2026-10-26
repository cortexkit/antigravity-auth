import type { ClaustrumReporterSource } from '@cortexkit/claustrum-client';
import type { QuotaObservation } from '../quota/index.js';
import type { RoutingRow } from '../routing/index.js';
import { type ClaustrumFamily, type ClaustrumScopedAttempt, type ClaustrumScopedClient, type IdentityParser, type KeptReceiptState, type VaultGrantReach } from './custody.js';
import { type ClaustrumLogger } from './errors.js';
import type { CustodyLease } from './hub.js';
import { type InsulaQuotaOptions, type InsulaQuotaResult } from './insula.js';
import { type AccountMapper, type ProjectionOptions, type QuotaReceipt, type ReorderVaultRosterResult, type VaultRosterFile } from './roster.js';
import { type WatchMode } from './watch.js';
export interface ClaustrumConsumerOptions<Q = QuotaObservation> {
    /**
     * The roster file: one row per vault account (route id, credential id,
     * account identity, state, quota), plus the accounts the user declined. It
     * never holds a token.
     */
    rosterPath: string;
    /** This host's enrollment token, written by setup. */
    tokenPath: string;
    family: ClaustrumFamily;
    connect: () => Promise<ClaustrumScopedClient>;
    /**
     * How long one `connect()` attempt may take before this consumer treats the
     * vault as unreachable (default 10 s). A connect that never settles would
     * otherwise leave every later `refresh()` waiting on the same promise. After
     * the limit the waiters get an unreachable error, the next `refresh()`
     * connects again, and a client that arrives late is closed.
     */
    connectTimeoutMs?: number;
    /**
     * Whether the plugin currently takes its accounts from the vault (custody
     * mode) rather than from local logins. Checked before every discovery,
     * commit and dispatch; false closes the vault connection and refuses sends.
     */
    isCustodyActive?: () => boolean | Promise<boolean>;
    /** Ids of the plugin's local pool rows; no vault route id may equal one. */
    reservedRouteIds?: () => Iterable<string>;
    routePrefix?: string;
    mapAccount?: AccountMapper;
    parseIdentity?: IdentityParser;
    /**
     * Issue a receipt only when the vault's served reply itself names the
     * credential id and the roster's account identity (see
     * `ClaustrumScopedCustody`). Set it for providers whose tokens do not reveal
     * their account; leave it unset to accept a reply that asserts no identity.
     */
    requireAssertion?: boolean;
    /**
     * Fired once per change of the vault's view cursor, including the first
     * roster. A poll that sees the same view does not fire, and neither does a
     * routine token refresh, which never moves the view.
     */
    onRoster?: (roster: VaultRosterFile) => void;
    onError?: (error: unknown) => void;
    /**
     * How often `start()` ticks. A tick lists the vault when no vault watch is
     * open (before it is accepted, or when the vault or the client cannot
     * watch), and otherwise only every five minutes, as a safety net. A tick
     * polls insula (at most once a minute) only while its watch is not open.
     */
    pollIntervalMs?: number;
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
    now?: () => number;
    logger?: ClaustrumLogger;
    /** Optional background quota source. In-band readings still use recordQuota. */
    insula?: InsulaQuotaOptions<Q>;
}
/**
 * How a started consumer learns about changes, for logs and status displays.
 * `insula` is present when the consumer was given an insula source. Never
 * carries secrets.
 */
export interface ClaustrumWatchState {
    readonly vault: WatchMode;
    readonly insula?: WatchMode;
}
/**
 * What a hub member asks of the `ClaustrumDiscoveryHub` that built it.
 * Package-internal: the hub implements it, and `/claustrum` exports neither
 * it nor `createHubMember`.
 */
export interface HubMemberPort {
    readonly provider: string;
    /** The member's `start()`: make sure the hub's own driver runs. */
    start(): void;
    /**
     * One hub refresh, coalesced across members (one list, one fan-out).
     * Undefined while vault mode is off, or when the connection it ran on was
     * ended before its fan-out finished. `errors` holds each member's own
     * commit error; a failed list rejects instead.
     */
    refresh(): Promise<HubRefreshOutcome | undefined>;
    /**
     * The hub's authority read. The hub, not the member, decides what a false
     * read means: it runs its inactive transition on the first one.
     */
    readAuthority(): Promise<boolean>;
    acquire(signal?: AbortSignal): Promise<CustodyLease>;
    /** False once a lease was released or its connection ended. */
    leaseLive(lease: CustodyLease): boolean;
    /** The hub's grant reach, only while `view` is the view it was read with. */
    grantReach(view: string | undefined): VaultGrantReach | undefined;
    watchMode(): WatchMode;
    keptReceiptState(): KeptReceiptState;
    /** Apply the union of every member's roster in memory to kept receipts. */
    retainUnion(): void;
    forget(credentialId: string): void;
    /** The member closed: the hub stops committing and pushing to it. */
    detach(): void;
}
export interface HubRefreshOutcome {
    readonly errors: ReadonlyMap<string, unknown>;
}
/** What the hub may do to one member's memory. Package-internal. */
export interface HubMemberHooks {
    /**
     * Set the roster in memory as a consumer's own refresh does (pending quota
     * readings included) and notify `onRoster` when its view changed.
     */
    install(roster: VaultRosterFile): void;
    /** Vault mode went off: forget the roster. */
    reset(): void;
    roster(): VaultRosterFile | undefined;
    projection(): ProjectionOptions;
    onError(error: unknown): void;
}
/**
 * How long one connect attempt may take by default. It bounds a connect that
 * never settles; the client's own handshake limit is not guaranteed to cover
 * every stall, and callers waiting on discovery need an answer either way.
 */
export declare const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
/**
 * Build the consumer for one hub member. `options` holds only what the member
 * uses: the hub's roster path for this member and the member's own fields.
 * Hub-mode paths never read `tokenPath`, `family` or `connect`, which the hub
 * owns. Package-internal: only `ClaustrumDiscoveryHub.member` calls it.
 */
export declare function createHubMember<Q>(port: HubMemberPort, options: ClaustrumConsumerOptions<Q>): {
    consumer: ClaustrumConsumer<Q>;
    hooks: HubMemberHooks;
};
export interface SendOptions {
    /**
     * What kind of request this is (for example `model`, `quota`, `profile`),
     * recorded in the 401 retry log line so a retry can be traced to its caller.
     */
    site: string;
    signal?: AbortSignal;
    reporterSource?: ClaustrumReporterSource;
}
/**
 * One plugin host's view of its vault accounts. It turns vault credentials
 * into rows for `/routing`, authorizes each physical send with the vault, and
 * reports a 401 against the exact record version that send used. Metadata
 * (the connection and discovery) is shared and coalesced; credential reads
 * never are. It never enrolls: a missing token is an error here, and setup
 * is where enrollment happens.
 */
export declare class ClaustrumConsumer<Q = QuotaObservation> {
    #private;
    constructor(options: ClaustrumConsumerOptions<Q>);
    /** The last committed roster this instance saw, without any I/O. */
    snapshot(): VaultRosterFile | undefined;
    /**
     * What this consumer is granted, from its latest discovery, without any I/O.
     * It explains an empty roster: `grants === 0` means no grant at all, while
     * `grants > 0` means a grant that reaches no credential (`tuples` names its
     * selector). Undefined means unknown, never zero: the vault or client is too
     * old to send it, nothing was discovered yet, or the roster now in memory is
     * a different view than the one this instance discovered (a peer process
     * held the discovery lease and its newer roster was served instead).
     */
    grantReach(): VaultGrantReach | undefined;
    /** How this consumer currently learns about changes, without I/O. */
    watchState(): ClaustrumWatchState;
    /** Whether any account is using an in-memory outage receipt, without I/O. */
    keptReceiptState(): KeptReceiptState;
    /** Rows for `/routing`, from the last committed roster. */
    routingRows(): RoutingRow[];
    refresh(): Promise<VaultRosterFile | undefined>;
    /**
     * Poll in the background and open the vault and insula watches. Until the
     * vault watch is accepted, and whenever it is unavailable, every tick lists
     * the vault exactly as before watches existed. While it is open a tick
     * lists only when five minutes have passed since the last discovery, since
     * the watch keeps no history; it still checks `isCustodyActive`, so a switch
     * to local mode closes the connection as quickly as before. Insula is
     * polled on the tick only while its own watch is not open. A host not in
     * vault mode makes no request.
     */
    start(): void;
    /**
     * Fetch on a background tick, at most once per minute across projects with
     * the same daemon and enrollment token path. Admission must use the cache
     * instead, so an optional quota daemon never delays a provider request.
     */
    refreshInsulaQuota(): Promise<void>;
    /**
     * Cache-only, for unknown-quota admission with a served receipt. Undefined
     * means poll the provider normally. Only get_scoped's asserted account_id
     * joins insula; parsed identities and display metadata cannot substitute.
     * Background polling should use cachedInsulaQuotaForRoute instead.
     */
    cachedInsulaQuota(receipt: Pick<ClaustrumScopedAttempt, 'assertedAccountIdentity'>): Promise<Q | undefined>;
    /**
     * Background cache lookup without fetching a credential. Re-read the roster
     * so a peer's account replacement invalidates the old route immediately.
     * A route without a known provider account cannot join an insula entry.
     */
    cachedInsulaQuotaForRoute(routeId: string): Promise<Q | undefined>;
    /** Cache-only background lookup, preserving the reason a route has no reading. */
    lookupInsulaQuotaForRoute(routeId: string): Promise<InsulaQuotaResult<Q>>;
    /** Skip the fallback poll while insula is cold or its upstream fetch failed. */
    pollInsulaQuotaForRoute(routeId: string, fallback: () => Promise<Q | undefined>): Promise<Q | undefined>;
    /**
     * Authorize one physical send on a vault route. The roster file is re-read
     * first, so a decline committed by another process applies before the next
     * poll, and a route whose credential or account changed is refused.
     */
    authorize(routeId: string, signal?: AbortSignal): Promise<ClaustrumScopedAttempt>;
    reportFailure(attempt: ClaustrumScopedAttempt, status: number, source: ClaustrumReporterSource): Promise<void>;
    /**
     * Send on a vault route. `dispatch` builds and sends the request with the
     * receipt's token and may be called twice, so it must be able to rebuild
     * its body. A 401 is retried once, and only when the vault now serves a new
     * record version of the same credential and account; the final 401 is
     * reported against the version that send actually used. Each call to
     * `dispatch` gets its own receipt.
     */
    send(routeId: string, dispatch: (attempt: ClaustrumScopedAttempt, signal?: AbortSignal) => Promise<Response>, options: SendOptions): Promise<Response>;
    /** Decline a vault account: it stays listed and never routes until accepted. */
    decline(routeId: string): Promise<void>;
    accept(routeId: string): Promise<void>;
    /**
     * Set the order vault accounts are tried in (`reorderVaultRoster`), then
     * re-read the roster, so the next routing decision in this process uses
     * the new order without waiting for a discovery. Never contacts the vault.
     */
    reorder(routeIds: readonly string[]): Promise<ReorderVaultRosterResult>;
    /**
     * Store a quota or profile observation for a vault route. The receipt the
     * reading was taken with is required: the observation lands only while the
     * route still holds the credential and account that receipt was served for
     * (see `recordVaultQuota`), so a reading for a replaced account is dropped.
     */
    recordQuota(routeId: string, observation: QuotaObservation, attempt: QuotaReceipt): Promise<boolean>;
    /**
     * Store a background observation that belongs to an account rather than to
     * a served credential (an insula reading from `cachedInsulaQuotaForRoute`).
     * It lands only while the route is still bound to that known account, so no
     * credential fetch is needed and a replaced account's reading is dropped.
     * Memory updates immediately; durable publication is detached and coalesced.
     */
    recordAccountQuota(routeId: string, accountIdentity: string, observation: QuotaObservation): Promise<boolean>;
    close(): void;
    /** Close immediately; background work gets 2 s and the quota writer its own 1 s. */
    dispose(): Promise<void>;
}
