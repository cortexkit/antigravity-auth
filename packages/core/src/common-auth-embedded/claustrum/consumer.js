import { createLogger } from '../logger/index.js';
import { combineAbortSignals } from '../util/any-signal.js';
import { ClaustrumScopedCustody, decideScopedRetryAfter401, } from './custody.js';
import { readClaustrumEnrollmentToken } from './enrollment.js';
import { ClaustrumConsumerError } from './errors.js';
import { acquireInsulaQuotaSource, } from './insula.js';
import { pendingVaultQuota, retainVaultQuotaWriter } from './quota-writer.js';
import { acceptVaultRoute, applyVaultQuota, declineVaultRoute, forgetPendingVaultDiscovery, readVaultRoster, recordVaultAccountQuota, recordVaultQuota, refreshVaultRoster, reorderVaultRoster, vaultRoutingRows, } from './roster.js';
import { drainShutdown, shutdownWarning } from './shutdown.js';
import { SAFETY_POLL_MS } from './watch.js';
let buildHubMember;
/**
 * Build the consumer for one hub member. `options` holds only what the member
 * uses: the hub's roster path for this member and the member's own fields.
 * Hub-mode paths never read `tokenPath`, `family` or `connect`, which the hub
 * owns. Package-internal: only `ClaustrumDiscoveryHub.member` calls it.
 */
export function createHubMember(port, options) {
    if (!buildHubMember)
        throw new Error('ClaustrumConsumer is not initialized');
    return buildHubMember(port, options);
}
function notActive() {
    return new ClaustrumConsumerError('not-active', 'Claustrum scoped custody is not active');
}
/**
 * One plugin host's view of its vault accounts. It turns vault credentials
 * into rows for `/routing`, authorizes each physical send with the vault, and
 * reports a 401 against the exact record version that send used. Metadata
 * (the connection and discovery) is shared and coalesced; credential reads
 * never are. It never enrolls: a missing token is an error here, and setup
 * is where enrollment happens.
 */
export class ClaustrumConsumer {
    #options;
    #shutdown = new AbortController();
    #logger;
    #warnShutdown;
    #custody;
    #connecting;
    #refreshing;
    #roster;
    /**
     * The grants named by this instance's latest discovery, with the view that
     * discovery committed. Memory only: the roster file never carries it.
     */
    #grantReach;
    #timer;
    #started = false;
    #pending = new Set();
    #disposing;
    #insula;
    #vaultWatch;
    #releaseInsulaWatch;
    #insulaSkips = new Map();
    /** When this instance last completed a discovery, by `now`. */
    #discoveredAt;
    #releaseQuotaWriter;
    /** Set only on a member built by `ClaustrumDiscoveryHub.member`. */
    #hub;
    /** A hub member's one custody lease at a time. */
    #lease;
    /** The lease that issued each receipt, so a 401 goes back through it. */
    #issuedBy = new WeakMap();
    static {
        buildHubMember = (port, options) => {
            const consumer = new ClaustrumConsumer(options);
            consumer.#hub = port;
            return { consumer, hooks: consumer.#hubHooks() };
        };
    }
    constructor(options) {
        this.#options = options;
        this.#logger = options.logger ?? createLogger('claustrum');
        this.#warnShutdown = shutdownWarning(this.#logger, this.#shutdown.signal);
        this.#releaseQuotaWriter = retainVaultQuotaWriter(options.rosterPath, (publication) => {
            this.#roster = applyVaultQuota(this.#roster, publication).roster;
        });
    }
    #assertOpen(signal) {
        this.#shutdown.signal.throwIfAborted();
        signal?.throwIfAborted();
    }
    #track(pending) {
        this.#pending.add(pending);
        void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
        return pending;
    }
    async #active() {
        return (await this.#options.isCustodyActive?.()) ?? true;
    }
    #wait(pending, signal) {
        const combined = combineAbortSignals([
            this.#shutdown.signal,
            ...(signal ? [signal] : []),
        ]);
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                combined.signal.removeEventListener('abort', abort);
                combined.dispose();
            };
            const abort = () => {
                cleanup();
                reject(combined.signal.reason);
            };
            combined.signal.addEventListener('abort', abort, { once: true });
            // Observe the operation even after cancellation: shared metadata work may
            // finish for other callers, and a late connection must still be closed.
            pending.then((value) => {
                cleanup();
                if (combined.signal.aborted)
                    reject(combined.signal.reason);
                else
                    resolve(value);
            }, (error) => {
                cleanup();
                reject(error);
            });
            if (combined.signal.aborted)
                abort();
        });
    }
    async #getCustody() {
        this.#assertOpen();
        if (this.#custody)
            return this.#custody;
        if (!this.#connecting) {
            this.#connecting = this.#options
                .connect()
                .then((client) => {
                if (this.#shutdown.signal.aborted) {
                    client.close();
                    this.#assertOpen();
                }
                this.#custody = new ClaustrumScopedCustody({
                    client,
                    family: this.#options.family,
                    tokenPath: this.#options.tokenPath,
                    parseIdentity: this.#options.parseIdentity,
                    requireAssertion: this.#options.requireAssertion,
                    now: this.#options.now,
                    logger: this.#logger,
                    setTimeoutImpl: this.#options.setTimeoutImpl,
                    clearTimeoutImpl: this.#options.clearTimeoutImpl,
                });
                if (this.#options.insula && client.insula) {
                    this.#insula = acquireInsulaQuotaSource(client.insula, this.#options.tokenPath);
                }
                return this.#custody;
            })
                .finally(() => {
                this.#connecting = undefined;
            });
            this.#track(this.#connecting);
        }
        return this.#wait(this.#connecting);
    }
    /** The last committed roster this instance saw, without any I/O. */
    snapshot() {
        return this.#roster;
    }
    /**
     * What this consumer is granted, from its latest discovery, without any I/O.
     * It explains an empty roster: `grants === 0` means no grant at all, while
     * `grants > 0` means a grant that reaches no credential (`tuples` names its
     * selector). Undefined means unknown, never zero: the vault or client is too
     * old to send it, nothing was discovered yet, or the roster now in memory is
     * a different view than the one this instance discovered (a peer process
     * held the discovery lease and its newer roster was served instead).
     */
    grantReach() {
        if (this.#hub)
            return this.#hub.grantReach(this.#roster?.view);
        const latest = this.#grantReach;
        return latest && this.#roster?.view === latest.view
            ? latest.reach
            : undefined;
    }
    /** How this consumer currently learns about changes, without I/O. */
    watchState() {
        if (this.#hub)
            return Object.freeze({ vault: this.#hub.watchMode() });
        return Object.freeze({
            vault: this.#vaultWatch?.mode ?? 'polling',
            ...(this.#options.insula && {
                insula: this.#insula?.source.watchMode() ?? 'polling',
            }),
        });
    }
    /** Close the watches with the connection they belong to. */
    #stopWatch() {
        this.#vaultWatch?.close();
        this.#vaultWatch = undefined;
        this.#releaseInsulaWatch?.();
        this.#releaseInsulaWatch = undefined;
    }
    /** Whether any account is using an in-memory outage receipt, without I/O. */
    keptReceiptState() {
        if (this.#hub) {
            // Kept receipts live in the one shared custody, whichever lease reads it.
            const lease = this.#lease;
            return lease && this.#hub.leaseLive(lease)
                ? lease.custody.keptReceiptState()
                : this.#hub.keptReceiptState();
        }
        return (this.#custody?.keptReceiptState() ??
            Object.freeze({ active: false, since: null }));
    }
    /** Rows for `/routing`, from the last committed roster. */
    routingRows() {
        return vaultRoutingRows(this.#roster);
    }
    refresh() {
        this.#assertOpen();
        if (this.#hub)
            return this.#track(this.#hubRefresh(this.#hub));
        if (this.#refreshing)
            return this.#refreshing;
        this.#refreshing = (async () => {
            if (!(await this.#active())) {
                this.#roster = undefined;
                this.#grantReach = undefined;
                this.#stopWatch();
                if (this.#custody) {
                    this.#custody.close();
                    this.#track(this.#custody.dispose(this.#warnShutdown));
                }
                this.#custody = undefined;
                this.#insula?.release();
                this.#insula = undefined;
                return undefined;
            }
            const custody = await this.#getCustody();
            // Capture the inventory so its grant fields can be kept beside the roster;
            // the roster file itself never stores them.
            let discovered;
            const roster = await refreshVaultRoster({
                path: this.#options.rosterPath,
                custody,
                onInventory: (inventory) => {
                    discovered = inventory;
                },
                isActive: () => this.#active(),
                signal: this.#shutdown.signal,
                projection: () => ({
                    reservedRouteIds: new Set(this.#options.reservedRouteIds?.() ?? []),
                    routePrefix: this.#options.routePrefix,
                    mapAccount: this.#options.mapAccount,
                    now: (this.#options.now ?? Date.now)(),
                }),
            });
            this.#assertOpen();
            const changed = roster?.view !== this.#roster?.view;
            this.#roster = pendingVaultQuota(this.#options.rosterPath, roster);
            custody.retain(roster?.rows ?? []);
            // Each discovery replaces the previous value, including with unknown. A
            // refresh that served a peer's roster discovered nothing and leaves it;
            // grantReach() hides it once the roster's view no longer matches.
            if (discovered && roster?.view !== undefined)
                this.#grantReach = discovered.grantReach
                    ? { view: roster.view, reach: discovered.grantReach }
                    : undefined;
            // Notify on view changes only: subscribers rewrite shared state on each
            // notification, and the poll runs every few seconds.
            if (roster && changed)
                this.#options.onRoster?.(roster);
            this.#discoveredAt = (this.#options.now ?? Date.now)();
            return roster;
        })().finally(() => {
            this.#refreshing = undefined;
        });
        this.#track(this.#refreshing);
        return this.#refreshing;
    }
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
    start() {
        if (this.#started)
            return;
        this.#assertOpen();
        this.#started = true;
        // A hub member has no tick or watch of its own: the hub drives it.
        if (this.#hub) {
            this.#hub.start();
            return;
        }
        const tick = async () => {
            try {
                if (await this.#listDue())
                    await this.refresh();
                await this.refreshInsulaQuota();
                this.#openWatch();
            }
            catch (error) {
                if (!this.#shutdown.signal.aborted)
                    this.#options.onError?.(error);
            }
            if (this.#shutdown.signal.aborted)
                return;
            const delay = this.#options.pollIntervalMs ?? 5_000;
            if (delay <= 0)
                return;
            this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
                this.#timer = undefined;
                void this.#track(tick());
            }, delay);
            this.#timer.unref?.();
        };
        void this.#track(tick());
    }
    /** Whether a background tick must list the vault now. */
    async #listDue() {
        if (this.#vaultWatch?.mode !== 'watching')
            return true;
        const now = (this.#options.now ?? Date.now)();
        if (this.#discoveredAt === undefined ||
            now - this.#discoveredAt >= SAFETY_POLL_MS)
            return true;
        // refresh() is what closes the connection when the host left vault mode.
        return !(await this.#active());
    }
    /**
     * Open the vault and insula watches once a vault connection exists. Only
     * reached in vault mode: a host in local mode never connects.
     */
    #openWatch() {
        const custody = this.#custody;
        if (this.#shutdown.signal.aborted || !custody)
            return;
        // The same entry point a host without a consumer uses, so both apply
        // notices, refusals and outages alike.
        this.#vaultWatch ??= custody.watchRoster({
            view: () => this.#roster?.view,
            // The existing discovery, so a watched change commits the roster and
            // re-applies it to kept receipts exactly as a poll does. A refresh
            // already in flight may have listed before the change was announced,
            // so wait for it and list again.
            onView: () => this.#track((async () => {
                while (this.#refreshing)
                    await this.#refreshing.catch(() => { });
                if (this.#shutdown.signal.aborted)
                    return;
                await this.refresh();
            })()),
            // Custody has dropped kept receipts, as a poll meeting the same
            // refusal from list_scoped would.
            onRefused: (error) => this.#options.onError?.(error),
            onError: (error) => {
                if (!this.#shutdown.signal.aborted)
                    this.#options.onError?.(error);
            },
        });
        if (this.#options.insula && this.#insula && !this.#releaseInsulaWatch)
            this.#releaseInsulaWatch = this.#insula.source.watch({
                provider: this.#options.insula.provider,
                setTimeoutImpl: this.#options.setTimeoutImpl,
                clearTimeoutImpl: this.#options.clearTimeoutImpl,
            });
    }
    /**
     * Fetch on a background tick, at most once per minute across projects with
     * the same daemon and enrollment token path. Admission must use the cache
     * instead, so an optional quota daemon never delays a provider request.
     */
    async refreshInsulaQuota() {
        if (!this.#options.insula ||
            this.#shutdown.signal.aborted ||
            !(await this.#active()))
            return;
        try {
            await readClaustrumEnrollmentToken(this.#options.tokenPath);
            await this.#getCustody();
            await this.#insula?.source.refresh((this.#options.now ?? Date.now)());
        }
        catch {
            // An optional source must never prevent the plugin's own quota poll.
        }
    }
    /**
     * Cache-only, for unknown-quota admission with a served receipt. Undefined
     * means poll the provider normally. Only get_scoped's asserted account_id
     * joins insula; parsed identities and display metadata cannot substitute.
     * Background polling should use cachedInsulaQuotaForRoute instead.
     */
    async cachedInsulaQuota(receipt) {
        if (!this.#options.insula ||
            this.#shutdown.signal.aborted ||
            !(await this.#active()))
            return undefined;
        try {
            await readClaustrumEnrollmentToken(this.#options.tokenPath);
            return this.#normalizeInsulaQuota(receipt.assertedAccountIdentity);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Background cache lookup without fetching a credential. Re-read the roster
     * so a peer's account replacement invalidates the old route immediately.
     * A route without a known provider account cannot join an insula entry.
     */
    async cachedInsulaQuotaForRoute(routeId) {
        if (!this.#options.insula ||
            this.#shutdown.signal.aborted ||
            !(await this.#active()))
            return undefined;
        try {
            await readClaustrumEnrollmentToken(this.#options.tokenPath);
            const roster = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
            const row = roster?.rows.find((entry) => entry.routeId === routeId);
            return this.#normalizeInsulaQuota(row?.accountIdentity);
        }
        catch {
            return undefined;
        }
    }
    /** Cache-only background lookup, preserving the reason a route has no reading. */
    async lookupInsulaQuotaForRoute(routeId) {
        const options = this.#options.insula;
        if (!options || this.#shutdown.signal.aborted || !(await this.#active()))
            return { miss: 'unreachable' };
        try {
            await readClaustrumEnrollmentToken(this.#options.tokenPath);
            const roster = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
            const account = roster?.rows.find((row) => row.routeId === routeId)?.accountIdentity;
            if (!account || !this.#insula)
                return { miss: 'unreachable' };
            const result = this.#insula.source.lookup(options.provider, account, (this.#options.now ?? Date.now)());
            const reading = result.reading &&
                options.normalize(result.reading.entry, result.reading.context);
            if (result.miss)
                return { miss: result.miss, ...(reading !== undefined && { reading }) };
            // Refusing an echo or unsupported window leaves the plugin's poll in charge.
            return reading === undefined ? { miss: 'unreachable' } : { reading };
        }
        catch {
            return { miss: 'unreachable' };
        }
    }
    /** Skip the fallback poll while insula is cold or its upstream fetch failed. */
    async pollInsulaQuotaForRoute(routeId, fallback) {
        const result = await this.lookupInsulaQuotaForRoute(routeId);
        if (result.miss === 'cold' || result.miss === 'upstream-failed') {
            if (this.#insulaSkips.get(routeId) !== result.miss) {
                this.#insulaSkips.set(routeId, result.miss);
                this.#logger.warn('skipped insula provider poll', {
                    reason: result.miss,
                });
            }
            return undefined;
        }
        this.#insulaSkips.delete(routeId);
        return result.miss ? fallback() : result.reading;
    }
    #normalizeInsulaQuota(accountIdentity) {
        if (!this.#options.insula || !accountIdentity)
            return undefined;
        const current = this.#insula?.source.current(this.#options.insula.provider, accountIdentity, (this.#options.now ?? Date.now)());
        return current
            ? this.#options.insula.normalize(current.entry, current.context)
            : undefined;
    }
    /**
     * Authorize one physical send on a vault route. The roster file is re-read
     * first, so a decline committed by another process applies before the next
     * poll, and a route whose credential or account changed is refused.
     */
    async authorize(routeId, signal) {
        if (this.#hub)
            return this.#hubAuthorize(this.#hub, routeId, signal);
        this.#assertOpen(signal);
        const roster = this.#roster ?? (await this.#wait(this.refresh(), signal));
        if (!roster || !(await this.#active())) {
            this.#custody?.close();
            this.#custody = undefined;
            this.#stopWatch();
            this.#insula?.release();
            this.#insula = undefined;
            throw new ClaustrumConsumerError('not-active', 'Claustrum scoped custody is not active');
        }
        const current = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
        this.#assertOpen(signal);
        const observed = roster.rows.find((row) => row.routeId === routeId);
        const configured = current?.rows.find((row) => row.routeId === routeId);
        if (configured && !configured.enabled) {
            if (observed)
                this.#custody?.forget(observed.credentialId);
            throw new ClaustrumConsumerError('route-declined', 'Claustrum route is disabled');
        }
        if (!observed ||
            !configured ||
            configured.state !== 'active' ||
            configured.credentialId !== observed.credentialId ||
            configured.accountIdentity !== observed.accountIdentity ||
            configured.credentialType !== observed.credentialType) {
            if (observed)
                this.#custody?.forget(observed.credentialId);
            throw new ClaustrumConsumerError('route-unavailable', 'Claustrum route is disabled, removed or changed');
        }
        const custody = await this.#wait(this.#getCustody(), signal);
        const combined = combineAbortSignals([
            this.#shutdown.signal,
            ...(signal ? [signal] : []),
        ]);
        try {
            return await custody.authorize({
                credentialId: configured.credentialId,
                credentialType: configured.credentialType,
                ...(configured.accountIdentity !== undefined && {
                    accountIdentity: configured.accountIdentity,
                }),
            }, combined.signal, routeId);
        }
        finally {
            combined.dispose();
        }
    }
    /** The hub's handle on this member's memory. */
    #hubHooks() {
        return {
            install: (roster) => {
                if (this.#shutdown.signal.aborted)
                    return;
                const changed = roster.view !== this.#roster?.view;
                this.#roster = pendingVaultQuota(this.#options.rosterPath, roster);
                // One subscriber's failure must not stop the hub's fan-out.
                if (changed)
                    try {
                        this.#options.onRoster?.(roster);
                    }
                    catch (error) {
                        this.#options.onError?.(error);
                    }
            },
            reset: () => {
                this.#roster = undefined;
            },
            roster: () => this.#roster,
            projection: () => ({
                reservedRouteIds: new Set(this.#options.reservedRouteIds?.() ?? []),
                routePrefix: this.#options.routePrefix,
                mapAccount: this.#options.mapAccount,
                now: (this.#options.now ?? Date.now)(),
            }),
            onError: (error) => {
                if (!this.#shutdown.signal.aborted)
                    this.#options.onError?.(error);
            },
        };
    }
    /**
     * A hub member's refresh is the hub's: the hub has already pushed this
     * member's committed roster into memory when it resolves.
     */
    async #hubRefresh(hub) {
        const outcome = await hub.refresh();
        this.#assertOpen();
        if (!outcome)
            return undefined;
        if (outcome.errors.has(hub.provider))
            throw outcome.errors.get(hub.provider);
        return this.#roster;
    }
    /** Release this member's lease, or only `lease` when one is named. */
    #dropLease(lease) {
        if (lease && this.#lease !== lease)
            return;
        this.#lease?.release();
        this.#lease = undefined;
    }
    /** This member's lease, re-acquired once its connection has ended. */
    async #currentLease(hub, signal) {
        const held = this.#lease;
        if (held && hub.leaseLive(held))
            return held;
        this.#dropLease();
        const lease = await hub.acquire(signal);
        if (this.#shutdown.signal.aborted) {
            lease.release();
            this.#assertOpen();
        }
        // A concurrent authorize may have acquired first; keep one lease.
        const raced = this.#lease;
        if (raced && hub.leaseLive(raced)) {
            lease.release();
            return raced;
        }
        this.#lease = lease;
        return lease;
    }
    /**
     * `authorize` for a hub member. Only the hub's own authority read decides
     * that vault mode is off. If the hub's refresh still leaves this member
     * without a roster, it fails with `route-unavailable` before acquiring a
     * lease or asking for a credential, and no other member is affected.
     */
    async #hubAuthorize(hub, routeId, signal) {
        this.#assertOpen(signal);
        // A failed list rejects here; this member's own failed commit leaves it
        // without a roster, handled below.
        if (!this.#roster)
            await this.#wait(hub.refresh(), signal);
        const roster = this.#roster;
        if (!(await hub.readAuthority())) {
            this.#dropLease();
            throw notActive();
        }
        this.#assertOpen(signal);
        if (!roster)
            throw new ClaustrumConsumerError('route-unavailable', 'Claustrum has no roster for this provider yet');
        const current = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
        this.#assertOpen(signal);
        const observed = roster.rows.find((row) => row.routeId === routeId);
        const configured = current?.rows.find((row) => row.routeId === routeId);
        if (configured && !configured.enabled) {
            if (observed)
                hub.forget(observed.credentialId);
            throw new ClaustrumConsumerError('route-declined', 'Claustrum route is disabled');
        }
        if (!observed ||
            !configured ||
            configured.state !== 'active' ||
            configured.credentialId !== observed.credentialId ||
            configured.accountIdentity !== observed.accountIdentity ||
            configured.credentialType !== observed.credentialType) {
            if (observed)
                hub.forget(observed.credentialId);
            throw new ClaustrumConsumerError('route-unavailable', 'Claustrum route is disabled, removed or changed');
        }
        const identity = {
            credentialId: configured.credentialId,
            credentialType: configured.credentialType,
            ...(configured.accountIdentity !== undefined && {
                accountIdentity: configured.accountIdentity,
            }),
        };
        const combined = combineAbortSignals([
            this.#shutdown.signal,
            ...(signal ? [signal] : []),
        ]);
        try {
            for (let attempt = 0;; attempt++) {
                const lease = await this.#currentLease(hub, combined.signal);
                try {
                    const served = await lease.custody.authorize(identity, combined.signal, routeId);
                    this.#issuedBy.set(served, lease);
                    return served;
                }
                catch (error) {
                    // Only a lease whose connection ended meanwhile earns one more
                    // try, in the current connection; anything else, or a second
                    // closed, is the answer.
                    if (attempt > 0 ||
                        combined.signal.aborted ||
                        hub.leaseLive(lease) ||
                        !(error instanceof ClaustrumConsumerError) ||
                        error.kind !== 'closed')
                        throw error;
                    this.#dropLease(lease);
                    if (!(await hub.readAuthority()))
                        throw notActive();
                }
            }
        }
        finally {
            combined.dispose();
        }
    }
    async reportFailure(attempt, status, source) {
        this.#assertOpen();
        if (this.#hub) {
            // Only the lease that issued the receipt may report it; once that
            // lease was released or its connection ended, its view throws closed.
            const lease = this.#issuedBy.get(attempt);
            if (!lease)
                throw new ClaustrumConsumerError('no-receipt', 'Claustrum dispatch receipt has no active owner');
            await lease.custody.reportFailure(attempt, status, source);
            return;
        }
        if (!this.#custody)
            throw new ClaustrumConsumerError('no-receipt', 'Claustrum dispatch receipt has no active owner');
        await this.#custody.reportFailure(attempt, status, source);
    }
    /**
     * Send on a vault route. `dispatch` builds and sends the request with the
     * receipt's token and may be called twice, so it must be able to rebuild
     * its body. A 401 is retried once, and only when the vault now serves a new
     * record version of the same credential and account; the final 401 is
     * reported against the version that send actually used. Each call to
     * `dispatch` gets its own receipt.
     */
    async send(routeId, dispatch, options) {
        const signal = options.signal;
        let served = await this.authorize(routeId, signal);
        let response = await dispatch(served, signal);
        if (response.status === 401 && served.fromKeptReceipt) {
            await this.reportFailure(served, 401, options.reporterSource ?? 'direct');
            return response;
        }
        if (response.status === 401 && !signal?.aborted) {
            let current;
            try {
                current = await this.authorize(routeId, signal);
                // Cancellation can land after authorize settles, before this continuation.
                signal?.throwIfAborted();
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                // Re-authorization failed: keep this 401 and report it against the
                // receipt (served record version) this request was sent with.
            }
            if (decideScopedRetryAfter401(options.site, served, current, this.#logger)) {
                await response.body?.cancel().catch(() => { });
                served = current;
                response = await dispatch(current, signal);
            }
        }
        if (response.status === 401) {
            await this.reportFailure(served, 401, options.reporterSource ?? 'direct').catch((error) => this.#options.onError?.(error));
            // After the report the vault may mark the account as needing a new
            // login; refresh now so routing drops it without waiting for the next poll. Deferred so a consumer closed in
            // the meantime reports to onError instead of throwing from this send.
            Promise.resolve()
                .then(() => this.refresh())
                .catch((error) => {
                if (!this.#shutdown.signal.aborted)
                    this.#options.onError?.(error);
            });
        }
        return response;
    }
    /** Decline a vault account: it stays listed and never routes until accepted. */
    async decline(routeId) {
        this.#assertOpen();
        await declineVaultRoute(this.#options.rosterPath, routeId);
        this.#roster = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
        // A hub member shares kept receipts with every other member, so they are
        // retained against all members' rosters, never against this one alone.
        if (this.#hub)
            this.#hub.retainUnion();
        else
            this.#custody?.retain(this.#roster?.rows ?? []);
    }
    async accept(routeId) {
        this.#assertOpen();
        await acceptVaultRoute(this.#options.rosterPath, routeId);
        this.#roster = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
    }
    /**
     * Set the order vault accounts are tried in (`reorderVaultRoster`), then
     * re-read the roster, so the next routing decision in this process uses
     * the new order without waiting for a discovery. Never contacts the vault.
     */
    async reorder(routeIds) {
        this.#assertOpen();
        const result = await reorderVaultRoster(this.#options.rosterPath, routeIds);
        this.#roster = pendingVaultQuota(this.#options.rosterPath, await readVaultRoster(this.#options.rosterPath));
        return result;
    }
    /**
     * Store a quota or profile observation for a vault route. The receipt the
     * reading was taken with is required: the observation lands only while the
     * route still holds the credential and account that receipt was served for
     * (see `recordVaultQuota`), so a reading for a replaced account is dropped.
     */
    async recordQuota(routeId, observation, attempt) {
        this.#assertOpen();
        return recordVaultQuota(this.#options.rosterPath, {
            routeId,
            observation,
            credentialId: attempt.credentialId,
            accountIdentitySource: attempt.accountIdentitySource,
            ...(attempt.accountIdentity !== undefined && {
                accountIdentity: attempt.accountIdentity,
            }),
            ...(attempt.expectedAccountIdentity !== undefined && {
                expectedAccountIdentity: attempt.expectedAccountIdentity,
            }),
        });
    }
    /**
     * Store a background observation that belongs to an account rather than to
     * a served credential (an insula reading from `cachedInsulaQuotaForRoute`).
     * It lands only while the route is still bound to that known account, so no
     * credential fetch is needed and a replaced account's reading is dropped.
     * Memory updates immediately; durable publication is detached and coalesced.
     */
    async recordAccountQuota(routeId, accountIdentity, observation) {
        this.#assertOpen();
        return recordVaultAccountQuota(this.#options.rosterPath, {
            routeId,
            accountIdentity,
            observation,
        });
    }
    close() {
        if (this.#shutdown.signal.aborted)
            return;
        this.#shutdown.abort(new ClaustrumConsumerError('closed', 'Claustrum consumer is closed'));
        if (this.#timer)
            (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer);
        this.#timer = undefined;
        this.#stopWatch();
        if (this.#custody) {
            this.#custody.close();
            this.#track(this.#custody.dispose(this.#warnShutdown));
        }
        // A hub member gives back its lease; the shared custody stays open.
        this.#lease?.release();
        this.#lease = undefined;
        this.#hub?.detach();
        this.#insula?.release();
        this.#insula = undefined;
        this.#roster = undefined;
        this.#grantReach = undefined;
        void this.#releaseQuotaWriter();
        forgetPendingVaultDiscovery(this.#options.rosterPath);
    }
    /** Close immediately; background work gets 2 s and the quota writer its own 1 s. */
    async dispose() {
        this.close();
        this.#disposing ??= Promise.all([
            drainShutdown(this.#pending, this.#warnShutdown),
            this.#releaseQuotaWriter(),
        ]).then(() => { });
        await this.#disposing;
    }
}
