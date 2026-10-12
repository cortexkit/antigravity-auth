import type { ClaustrumReporterSource } from '@cortexkit/claustrum-client';
import type { QuotaObservation } from '../quota/index.js';
import type { RoutingRow } from '../routing/index.js';
import { type ClaustrumFamily, type ClaustrumScopedAttempt, type ClaustrumScopedClient, type IdentityParser } from './custody.js';
import { type ClaustrumLogger } from './errors.js';
import { type AccountMapper, type QuotaReceipt, type VaultRosterFile } from './roster.js';
export interface ClaustrumConsumerOptions {
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
    pollIntervalMs?: number;
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
    now?: () => number;
    logger?: ClaustrumLogger;
}
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
export declare class ClaustrumConsumer {
    #private;
    constructor(options: ClaustrumConsumerOptions);
    /** The last committed roster this instance saw, without any I/O. */
    snapshot(): VaultRosterFile | undefined;
    /** Rows for `/routing`, from the last committed roster. */
    routingRows(): RoutingRow[];
    refresh(): Promise<VaultRosterFile | undefined>;
    start(): void;
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
     * Store a quota or profile observation for a vault route. The receipt the
     * reading was taken with is required: the observation lands only while the
     * route still holds the credential and account that receipt was served for
     * (see `recordVaultQuota`), so a reading for a replaced account is dropped.
     */
    recordQuota(routeId: string, observation: QuotaObservation, attempt: QuotaReceipt): Promise<boolean>;
    close(): void;
}
