// One vault connection, one watch and one list for every provider a plugin
// serves on a host. The plugin still runs one ClaustrumConsumer per provider,
// each with its own roster file; the hub builds those consumers as its
// members, lists once, commits each member's share of the listing to that
// member's roster and pushes it into the member's memory.
//
// Several processes on one profile (an OpenCode server, Pi, a second
// OpenCode) each run their own hub and list for themselves. Nothing elects a
// leader between them: each hub commits every member through the same
// per-path discovery lease and roster write lock that plain consumers in
// different processes already share, plus the base-view rule, so a commit
// never replaces a view another process committed after this hub listed.
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../logger/index.js';
import { combineAbortSignals } from '../util/any-signal.js';
import { createHubMember, } from './consumer.js';
import { ClaustrumScopedCustody, } from './custody.js';
import { ClaustrumConsumerError } from './errors.js';
import { DEFAULT_ROUTE_PREFIX, decodedVaultRoster, forgetPendingVaultDiscovery, isVaultRosterLockRefusal, readVaultRoster, refreshVaultRoster, vaultRosterSeed, } from './roster.js';
import { drainShutdown, shutdownWarning } from './shutdown.js';
import { SAFETY_POLL_MS } from './watch.js';
/** Lowercase ASCII, safe as a file name on every OS. */
const FILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Device names Windows reserves in every directory, with any extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/;
/** A roster key's directory name: the first 16 hex digits of a SHA-256. */
const FINGERPRINT = /^[0-9a-f]{16}$/;
/** A failing member is listed for on each of this many ticks before backing off. */
const PENDING_EVERY_TICK = 3;
/**
 * `value` as JSON with every object's keys sorted, so equal inputs give equal
 * text in every process. Undefined for anything that is not plain JSON
 * (functions, undefined, non-finite numbers, class instances, cycles).
 */
function canonicalJson(value, path = new Set()) {
    if (value === null)
        return 'null';
    if (typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number')
        return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    if (typeof value !== 'object' || path.has(value))
        return undefined;
    const inner = new Set(path).add(value);
    const parts = [];
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            const part = canonicalJson(value[index], inner);
            if (part === undefined)
                return undefined;
            parts.push(part);
        }
        return `[${parts.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return undefined;
    for (const key of Object.keys(value).sort()) {
        const part = canonicalJson(value[key], inner);
        if (part === undefined)
            return undefined;
        parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `{${parts.join(',')}}`;
}
/**
 * The roster key's fingerprint: a hash of everything that decides which rows
 * a member's roster holds and how they are projected, other than the host
 * generation (the directory above it) and the reserved route ids (local pool
 * rows, which change at runtime; see `#collides`).
 */
function rosterFingerprint(options, members) {
    const input = canonicalJson({
        format: 1,
        classifier: options.classifierInput,
        members: [...members].sort(),
        routePrefix: options.routePrefix ?? DEFAULT_ROUTE_PREFIX,
        // A function cannot be compared across processes; its source text
        // changes with the plugin build that ships it.
        mapAccount: options.mapAccount ? String(options.mapAccount) : null,
    });
    if (input === undefined)
        throw new ClaustrumConsumerError('invalid-state', 'Claustrum hub classifierInput must be plain JSON');
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
function fileId(value, what) {
    if (typeof value !== 'string' ||
        !FILE_ID.test(value) ||
        WINDOWS_DEVICE.test(value))
        throw new ClaustrumConsumerError('invalid-state', `Claustrum hub ${what} must be a lowercase file-safe id`);
    return value;
}
function closed(message = 'Claustrum custody lease is closed') {
    return new ClaustrumConsumerError('closed', message);
}
function notActive() {
    return new ClaustrumConsumerError('not-active', 'Claustrum scoped custody is not active');
}
/**
 * Follow `pending`, but reject as soon as `signal` aborts. `pending` is
 * still observed afterwards, so its rejection is never unhandled.
 */
function untilAborted(pending, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        pending.then((value) => {
            signal.removeEventListener('abort', abort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
        });
        if (signal.aborted)
            abort();
    });
}
/**
 * Each row's credential id and enabled state, serialized. A change between two
 * rosters means kept receipts must be retained against the new rows.
 */
function enabledRows(roster) {
    return JSON.stringify((roster?.rows ?? []).map((row) => [row.credentialId, row.enabled]));
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
export class ClaustrumDiscoveryHub {
    #options;
    #logger;
    #warnShutdown;
    #shutdown = new AbortController();
    #members = new Map();
    #leases = new WeakMap();
    #generations = 0;
    #current;
    /** The pending connect, with the generation it was started for. */
    #connecting;
    /** The lease the hub's own discovery and watch hold. */
    #own;
    #watch;
    #run;
    /** The hub's last authority read; undefined before the first one. */
    #active;
    /** Counts inactive transitions, so local work started before one stops. */
    #epoch = 0;
    #committed;
    #discoveredAt;
    #timer;
    #started = false;
    #pending = new Set();
    #disposing;
    /** This host generation's roster directory, which holds every key. */
    #generationDirectory;
    /** This hub's roster key: the fingerprint directory under it. */
    #key;
    constructor(options) {
        if (!options.family || !('classify' in options.family))
            throw new ClaustrumConsumerError('wrong-consumer', 'Claustrum discovery hub requires a classifying family');
        const hostGeneration = fileId(options.hostGeneration, 'host generation');
        const providers = options.members.map((member) => fileId(member, 'member'));
        if (new Set(providers).size !== providers.length)
            throw new ClaustrumConsumerError('invalid-state', 'Claustrum hub members must be distinct');
        this.#options = options;
        this.#logger = options.logger ?? createLogger('claustrum');
        this.#warnShutdown = shutdownWarning(this.#logger, this.#shutdown.signal);
        // The roster key: the host generation, then a fingerprint of the
        // classifier's whole input and the projection inputs. Every member keeps
        // the path it is given here for its whole life, and every lock and
        // temporary file of a roster sits beside it, inside the key's directory.
        this.#generationDirectory = join(options.stateDir, 'rosters', hostGeneration);
        this.#key = rosterFingerprint(options, providers);
        const directory = join(this.#generationDirectory, this.#key);
        for (const provider of providers)
            this.#members.set(provider, {
                provider,
                path: join(directory, `${provider}.json`),
                closed: false,
            });
    }
    #track(pending) {
        this.#pending.add(pending);
        void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
        return pending;
    }
    #assertOpen() {
        if (this.#shutdown.signal.aborted)
            throw closed('Claustrum discovery hub is closed');
    }
    #entry(provider) {
        const entry = this.#members.get(provider);
        if (!entry)
            throw new ClaustrumConsumerError('wrong-consumer', 'Claustrum hub has no such member');
        return entry;
    }
    /** The roster file member `provider` reads and the hub commits. */
    rosterPath(provider) {
        return this.#entry(provider).path;
    }
    /**
     * Build the consumer for `provider`, once. It is an ordinary
     * `ClaustrumConsumer` whose roster path is `rosterPath(provider)`; it
     * connects, lists and watches only through this hub.
     */
    member(provider, options) {
        this.#assertOpen();
        const entry = this.#entry(provider);
        if (entry.hooks)
            throw new ClaustrumConsumerError('wrong-consumer', 'Claustrum hub member was already built');
        // The type has none of these; refuse them when they arrive through a cast
        // rather than let a member read a path or source the hub does not own.
        for (const owned of [
            'rosterPath',
            'tokenPath',
            'family',
            'connect',
            'isCustodyActive',
            'insula',
            'pollIntervalMs',
            'routePrefix',
            'mapAccount',
        ])
            if (owned in options)
                throw new ClaustrumConsumerError('wrong-consumer', `Claustrum hub members cannot take ${owned}`);
        const port = {
            provider: entry.provider,
            start: () => this.start(),
            refresh: () => this.#refresh(),
            readAuthority: () => this.#readAuthority(),
            acquire: (signal) => this.acquire(signal),
            leaseLive: (lease) => this.#leaseLive(lease),
            grantReach: (view) => view !== undefined && this.#committed?.view === view
                ? this.#committed.reach
                : undefined,
            watchMode: () => this.watchState(),
            keptReceiptState: () => this.keptReceiptState(),
            retainUnion: () => this.#retainUnion(),
            forget: (credentialId) => this.#current?.custody?.forget(credentialId),
            detach: () => {
                entry.closed = true;
            },
        };
        const consumerOptions = {
            rosterPath: entry.path,
            ...(options.reservedRouteIds && {
                reservedRouteIds: options.reservedRouteIds,
            }),
            ...(this.#options.routePrefix !== undefined && {
                routePrefix: this.#options.routePrefix,
            }),
            ...(this.#options.mapAccount && { mapAccount: this.#options.mapAccount }),
            ...(options.onRoster && { onRoster: options.onRoster }),
            ...(options.onError && { onError: options.onError }),
            logger: options.logger ?? this.#logger,
            ...(this.#options.now && { now: this.#options.now }),
        };
        const { consumer, hooks } = createHubMember(port, consumerOptions);
        entry.hooks = hooks;
        return consumer;
    }
    // --- leases ---
    #startGeneration() {
        const generation = {
            id: ++this.#generations,
            count: 0,
            ended: false,
            controller: new AbortController(),
        };
        this.#current = generation;
        return generation;
    }
    #live(generation) {
        return (!generation.ended &&
            this.#current === generation &&
            !this.#shutdown.signal.aborted);
    }
    #leaseLive(lease) {
        const state = this.#leases.get(lease);
        return !!state && !state.released && !state.generation.ended;
    }
    /**
     * End a generation: its signal aborts, every lease of it is revoked, its
     * watch stops and its custody closes (with every kept receipt and the
     * client). A connect still pending closes its own client when it resolves.
     */
    #end(generation, reason = closed()) {
        if (generation.ended)
            return;
        generation.ended = true;
        generation.count = 0;
        if (this.#current === generation)
            this.#current = undefined;
        if (this.#own && this.#leases.get(this.#own)?.generation === generation)
            this.#own = undefined;
        if (this.#watch?.generation === generation) {
            this.#watch.watch.close();
            this.#watch = undefined;
        }
        generation.controller.abort(reason);
        if (generation.custody) {
            generation.custody.close();
            this.#track(generation.custody.dispose(this.#warnShutdown));
        }
    }
    /** Return one waiting acquirer's count to a generation that still runs. */
    #giveBack(generation) {
        if (generation.ended)
            return;
        generation.count--;
        if (generation.count <= 0)
            this.#end(generation);
    }
    #connect(generation) {
        const pending = this.#connecting;
        if (pending?.generation === generation)
            return pending.promise;
        const entry = {
            generation,
            promise: this.#track(this.#options.connect().then((client) => {
                // A connect resolves into its generation only while that generation
                // is current and still wanted; otherwise its client never serves.
                if (!this.#live(generation) || generation.count <= 0) {
                    client.close();
                    throw closed('Claustrum connection is no longer wanted');
                }
                generation.custody = new ClaustrumScopedCustody({
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
                return generation.custody;
            })),
        };
        // Clear only this connect: an older generation's connect settling late
        // must leave a newer generation's pending connect in place.
        const settled = entry.promise.finally(() => {
            if (this.#connecting === entry)
                this.#connecting = undefined;
        });
        settled.catch(() => { });
        this.#connecting = entry;
        return entry.promise;
    }
    /**
     * Take a lease on the current connection, connecting first when there is
     * none. The acquirer's count is taken before anything is awaited, so a
     * release elsewhere meanwhile cannot end the connection under it. An abort
     * or a failed connect gives that count back; an acquirer whose connection
     * ended while it waited tries once more on the current one. Rejects with
     * `not-active` while vault mode is off.
     */
    acquire(signal) {
        try {
            this.#assertOpen();
            signal?.throwIfAborted();
            if (this.#active === false)
                throw notActive();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const generation = this.#current ?? this.#startGeneration();
        generation.count++;
        return this.#settle(generation, signal, true);
    }
    async #settle(generation, signal, retry) {
        let custody = generation.custody;
        if (!custody) {
            const combined = combineAbortSignals([
                generation.controller.signal,
                ...(signal ? [signal] : []),
            ]);
            try {
                custody = await untilAborted(this.#connect(generation), combined.signal);
            }
            catch (error) {
                if (!generation.ended) {
                    // Aborted, or the connect failed: this acquirer holds nothing.
                    this.#giveBack(generation);
                    throw error;
                }
                return this.#again(signal, retry);
            }
            finally {
                combined.dispose();
            }
        }
        if (generation.ended)
            return this.#again(signal, retry);
        if (signal?.aborted) {
            this.#giveBack(generation);
            throw signal.reason;
        }
        return this.#lease(generation, custody);
    }
    /** An acquirer whose generation ended while it waited. */
    #again(signal, retry) {
        signal?.throwIfAborted();
        this.#assertOpen();
        if (this.#active === false)
            throw notActive();
        if (!retry)
            throw closed();
        const generation = this.#current ?? this.#startGeneration();
        generation.count++;
        return this.#settle(generation, signal, false);
    }
    #lease(generation, custody) {
        const state = { generation, custody, released: false };
        const check = () => {
            if (state.released || generation.ended)
                throw closed();
        };
        const view = Object.freeze({
            authorize: async (identity, signal, routeId) => {
                check();
                // Work in flight stops when the generation ends.
                const combined = combineAbortSignals([
                    generation.controller.signal,
                    ...(signal ? [signal] : []),
                ]);
                try {
                    return await custody.authorize(identity, combined.signal, routeId);
                }
                finally {
                    combined.dispose();
                }
            },
            reportFailure: async (attempt, status, source) => {
                check();
                return custody.reportFailure(attempt, status, source);
            },
            forget: (credentialId) => {
                check();
                custody.forget(credentialId);
            },
            keptReceiptState: () => {
                check();
                return custody.keptReceiptState();
            },
        });
        const lease = Object.freeze({
            custody: view,
            generation: generation.id,
            release: () => {
                if (state.released)
                    return;
                state.released = true;
                this.#giveBack(generation);
            },
        });
        this.#leases.set(lease, state);
        return lease;
    }
    /** The current connection and its lease count, for status and tests. */
    leaseState() {
        const current = this.#current;
        return Object.freeze({
            generation: current?.id,
            count: current?.count ?? 0,
        });
    }
    // --- authority ---
    /**
     * Read authority. The first false read after a true one (or before any)
     * runs the inactive transition; nothing else does.
     */
    async #readAuthority() {
        const active = (await this.#options.isCustodyActive?.()) ?? true;
        if (this.#shutdown.signal.aborted)
            return false;
        const was = this.#active;
        this.#active = active;
        if (!active && was !== false)
            this.#deactivate();
        return active;
    }
    /** Vault mode went off. Kept receipts never survive into local mode. */
    #deactivate() {
        this.#epoch++;
        const current = this.#current;
        if (current)
            this.#end(current, notActive());
        this.#own = undefined;
        this.#watch?.watch.close();
        this.#watch = undefined;
        this.#committed = undefined;
        this.#discoveredAt = undefined;
        for (const entry of this.#members.values()) {
            entry.seen = undefined;
            entry.pending = undefined;
            entry.hooks?.reset();
            forgetPendingVaultDiscovery(entry.path);
        }
    }
    // --- discovery ---
    /** Members built and not closed, in the order the hub was given them. */
    #open() {
        return [...this.#members.values()].filter((entry) => entry.hooks && !entry.closed);
    }
    /** The hub's own lease, taken in the current generation when needed. */
    async #ownLease() {
        const held = this.#own;
        const heldState = held && this.#leases.get(held);
        if (held && heldState && this.#leaseLive(held))
            return heldState;
        this.#own = undefined;
        const lease = await this.acquire(this.#shutdown.signal);
        const raced = this.#own && this.#leases.get(this.#own);
        if (this.#own && raced && this.#leaseLive(this.#own)) {
            lease.release();
            return raced;
        }
        this.#own = lease;
        const state = this.#leases.get(lease);
        if (!state)
            throw closed();
        return state;
    }
    /**
     * One coalesced refresh. A run whose generation ended is never joined: a
     * refresh after vault mode went off and on again starts a new one.
     */
    #refresh() {
        try {
            this.#assertOpen();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const running = this.#run;
        if (running && !running.generation?.ended)
            return running.promise;
        const run = {};
        const promise = this.#track(this.#discover(run).finally(() => {
            if (this.#run === run)
                this.#run = undefined;
        }));
        run.promise = promise;
        this.#run = run;
        return promise;
    }
    /**
     * Read each member's base view, list once, then commit each member's share
     * of the listing to its roster, push it into the member, and retain the
     * union. Each publication step checks first that the generation it started
     * in is still current. A member that this list did not commit is marked
     * pending, so a later tick lists again.
     */
    async #discover(run) {
        if (!(await this.#readAuthority()))
            return undefined;
        const own = await this.#ownLease();
        const generation = own.generation;
        run.generation = generation;
        if (!this.#live(generation))
            return undefined;
        // What each member's file held before the list. Another process may
        // commit while this list runs; the base-view rule then keeps its newer
        // roster rather than replacing it with this older listing.
        const bases = new Map();
        for (const entry of this.#members.values())
            bases.set(entry, await readVaultRoster(entry.path).then((file) => (file ? { file } : {}), (error) => error instanceof Error ? error : new Error(String(error))));
        if (!this.#live(generation))
            return undefined;
        let inventory;
        try {
            inventory = await own.custody.discover(generation.controller.signal);
        }
        catch (error) {
            if (!this.#live(generation))
                return undefined;
            // Every pending member missed this list too.
            for (const entry of this.#members.values())
                if (entry.pending)
                    this.#markPending(entry);
            throw error;
        }
        const errors = new Map();
        let complete = true;
        for (const entry of this.#open()) {
            if (!this.#live(generation))
                return undefined;
            const hooks = entry.hooks;
            if (!hooks || entry.closed)
                continue;
            const share = {
                ...inventory,
                credentials: inventory.credentials.filter((credential) => credential.member === entry.provider),
                skipped: inventory.skipped.filter((record) => record.member === entry.provider),
            };
            const base = bases.get(entry);
            let roster;
            try {
                if (!base)
                    throw closed('Claustrum hub member has no base view');
                if (base instanceof Error)
                    throw base;
                // A member's first roster under this key carries the declines and
                // order of its newest roster under an older key.
                const seed = base.file ? undefined : await this.#seed(entry);
                roster = await refreshVaultRoster({
                    path: entry.path,
                    custody: { discover: async () => share },
                    // Generation g's commit checks that g is still current, not only
                    // that vault mode is on, so off-then-on cannot let it into g+1.
                    isActive: () => this.#live(generation) && this.#active === true,
                    signal: generation.controller.signal,
                    projection: () => ({ ...hooks.projection(), ...(seed && { seed }) }),
                    listedOver: { view: base.file?.view },
                });
            }
            catch (error) {
                if (!this.#live(generation))
                    return undefined;
                complete = false;
                this.#markPending(entry);
                // Another writer holding or taking this roster's locks is not this
                // member's failure: the member keeps what it has and is retried.
                if (isVaultRosterLockRefusal(entry.path, error))
                    this.#logger.debug('claustrum hub member commit refused', {
                        member: entry.provider,
                    });
                else
                    errors.set(entry.provider, error);
                continue;
            }
            if (!this.#live(generation))
                return undefined;
            // Not this list's roster: vault mode went off, the file was removed
            // since the list, or another process holds or committed it (a peer's
            // newer view, or a peer that stopped mid-commit holding the lease).
            if (roster?.view !== inventory.view) {
                complete = false;
                this.#markPending(entry);
            }
            else
                entry.pending = undefined;
            if (!roster)
                continue;
            if (this.#collides(hooks, roster)) {
                // Another process projected a route id that is a local row here.
                complete = false;
                this.#markPending(entry);
                continue;
            }
            // The push: memory holds the committed roster before refresh resolves.
            entry.seen = JSON.stringify(decodedVaultRoster(roster));
            if (!entry.closed)
                hooks.install(roster);
        }
        if (!this.#live(generation))
            return undefined;
        this.#retainUnion();
        // The committed view, and the refusals and grant reach tied to it, move
        // only when every member committed this listing.
        if (complete)
            this.#committed = Object.freeze({
                view: inventory.view,
                ...(inventory.grantReach && { reach: inventory.grantReach }),
                refused: Object.freeze([...(inventory.refused ?? [])]),
                notMine: inventory.notMine ?? 0,
            });
        this.#discoveredAt = (this.#options.now ?? Date.now)();
        return { errors };
    }
    /**
     * The preferences a member's first roster under this key starts from: the
     * declines and order of the newest roster of the same host generation and
     * member under any other key, the layout without a fingerprint included.
     * Those files are only read. Undefined when there is none.
     */
    async #seed(entry) {
        const name = `${entry.provider}.json`;
        const candidates = [join(this.#generationDirectory, name)];
        try {
            for (const key of await readdir(this.#generationDirectory))
                if (key !== this.#key && FINGERPRINT.test(key))
                    candidates.push(join(this.#generationDirectory, key, name));
        }
        catch {
            // No directory for this host generation yet: nothing to seed from.
        }
        let newest;
        for (const path of candidates) {
            try {
                const modified = (await stat(path)).mtimeMs;
                const roster = await readVaultRoster(path);
                if (roster && (!newest || modified > newest.modified))
                    newest = { modified, roster };
            }
            catch {
                // A missing or unreadable older roster seeds nothing.
            }
        }
        return newest && vaultRosterSeed(newest.roster);
    }
    /**
     * Whether `roster` routes through an id this member's plugin uses for a
     * local row. Only a roster another process projected can: this process's
     * own projection gives such a route a new id. Rather than serve it, the
     * hub lists, and its own projection renames that route.
     */
    #collides(hooks, roster) {
        const reserved = hooks.projection().reservedRouteIds;
        return (!!reserved?.size && roster.rows.some((row) => reserved.has(row.routeId)));
    }
    /**
     * This member missed a list: due again on each of the next three ticks,
     * then after 2, 4, 8 ... ticks, up to the five-minute safety poll, so one
     * broken member file never keeps the hub listing every tick.
     */
    #markPending(entry) {
        const failures = (entry.pending?.failures ?? 0) + 1;
        const tick = Math.max(1, this.#options.pollIntervalMs ?? 5_000);
        const longest = Math.max(1, Math.ceil(SAFETY_POLL_MS / tick));
        const interval = failures <= PENDING_EVERY_TICK
            ? 1
            : Math.min(2 ** (failures - PENDING_EVERY_TICK), longest);
        entry.pending = { failures, wait: interval - 1 };
    }
    /** Retain kept receipts against every open member's roster in memory. */
    #retainUnion() {
        const custody = this.#current?.custody;
        if (!custody)
            return;
        custody.retain(this.#open().flatMap((entry) => entry.hooks?.roster()?.rows ?? []));
    }
    /**
     * Take member files another writer changed. The same view as in memory
     * means a decline, accept, reorder or quota reading, which moves no view:
     * it is installed, as a plain consumer's `authorize` and `decline` read
     * such a file back (`consumer.ts`, `authorize` and `decline`). A different
     * view, or a member with no roster in memory, means another process
     * committed a listing: the member is marked pending and the next tick
     * lists, then commits over that file or takes it, as a plain consumer's
     * refresh does (`refreshVaultRoster`, which serves a peer's roster while
     * the peer holds the discovery lease). Local reads only.
     */
    async #install() {
        const epoch = this.#epoch;
        for (const entry of this.#open()) {
            let file;
            try {
                file = await readVaultRoster(entry.path);
            }
            catch (error) {
                entry.hooks?.onError(error);
                continue;
            }
            if (epoch !== this.#epoch || this.#active !== true)
                return;
            const hooks = entry.hooks;
            if (!file || !hooks || entry.closed)
                continue;
            const content = JSON.stringify(file);
            if (content === entry.seen)
                continue;
            const memory = hooks.roster();
            if (!memory || memory.view !== file.view || this.#collides(hooks, file)) {
                entry.pending ??= { failures: 0, wait: 0 };
                continue;
            }
            const before = enabledRows(memory);
            entry.seen = content;
            hooks.install(file);
            if (enabledRows(hooks.roster()) !== before)
                this.#retainUnion();
        }
    }
    /**
     * Whether a tick must list now: the consumer's rule, once for every
     * member, and also when a pending member's wait is over. Called once per
     * tick, which is what counts a pending member's wait down.
     */
    #listDue() {
        let pending = false;
        for (const entry of this.#members.values()) {
            if (!entry.pending)
                continue;
            if (entry.pending.wait <= 0)
                pending = true;
            else
                entry.pending.wait--;
        }
        if (this.#watch?.watch.mode !== 'watching' || pending)
            return true;
        const now = (this.#options.now ?? Date.now)();
        return (this.#discoveredAt === undefined ||
            now - this.#discoveredAt >= SAFETY_POLL_MS);
    }
    /** Open the one vault watch on the hub's own lease, once per generation. */
    #openWatch() {
        const own = this.#own;
        const state = own && this.#leases.get(own);
        if (!own || !state || !this.#leaseLive(own) || this.#active !== true)
            return;
        const generation = state.generation;
        if (!this.#live(generation) || this.#watch?.generation === generation)
            return;
        const watch = state.custody.watchRoster({
            view: () => this.#committed?.view,
            onView: () => this.#track((async () => {
                // A refresh already in flight may have listed before the change was
                // announced, so wait for it and list again.
                while (this.#run)
                    await this.#run.promise.catch(() => { });
                if (!this.#live(generation))
                    return;
                await this.#list();
            })()),
            // The vault refused the watch: custody has dropped every kept receipt,
            // which every member served from, as a refused list would.
            onRefused: (error) => this.#everyone(error),
            // The watch alone failed; listing goes on and every member is served.
            onError: (error) => this.#error(error),
        });
        this.#watch = { generation, watch };
    }
    #error(error) {
        if (!this.#shutdown.signal.aborted)
            this.#options.onError?.(error);
    }
    /** A failure of every member's discovery: the hub's and each member's. */
    #everyone(error) {
        if (this.#shutdown.signal.aborted)
            return;
        this.#options.onError?.(error);
        for (const entry of this.#open())
            entry.hooks?.onError(error);
    }
    /** Each member's own commit error goes to that member's `onError` only. */
    #publish(outcome) {
        for (const [provider, error] of outcome?.errors ?? [])
            this.#members.get(provider)?.hooks?.onError(error);
    }
    /** One list the hub itself decided on, with its errors published. */
    async #list() {
        let outcome;
        try {
            outcome = await this.#refresh();
        }
        catch (error) {
            this.#everyone(error);
            return;
        }
        this.#publish(outcome);
    }
    async #tick() {
        try {
            if (await this.#readAuthority()) {
                await this.#install();
                if (this.#listDue())
                    await this.#list();
                this.#openWatch();
            }
        }
        catch (error) {
            this.#error(error);
        }
        if (this.#shutdown.signal.aborted)
            return;
        const delay = this.#options.pollIntervalMs ?? 5_000;
        if (delay <= 0)
            return;
        this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
            this.#timer = undefined;
            void this.#track(this.#tick());
        }, delay);
        this.#timer.unref?.();
    }
    /**
     * Start the hub's tick, which runs until `close()`. While vault mode is
     * off a tick only reads authority and makes no vault request.
     */
    start() {
        if (this.#started)
            return;
        this.#assertOpen();
        this.#started = true;
        void this.#track(this.#tick());
    }
    /**
     * List once and commit every member, as a tick does. Resolves once every
     * member's memory holds its new roster. Rejects when the list fails; a
     * member's own commit error goes to that member's `onError`.
     */
    async refresh() {
        this.#publish(await this.#refresh());
    }
    // --- accessors, without I/O ---
    /**
     * Rows the last discovery every member committed refused, with their fixed
     * codes, and how many rows it left to other plugins. Undefined while
     * unknown: before a complete discovery, and while vault mode is off.
     */
    refusals() {
        const committed = this.#committed;
        return (committed &&
            Object.freeze({
                view: committed.view,
                refused: committed.refused,
                notMine: committed.notMine,
            }));
    }
    /** The grant reach of the same discovery as `refusals()`. */
    grantReach() {
        return this.#committed?.reach;
    }
    /** How the hub learns about changes; `polling` until a watch is open. */
    watchState() {
        const open = this.#watch;
        return open && this.#live(open.generation) ? open.watch.mode : 'polling';
    }
    /** The shared custody's kept receipts, host-wide. */
    keptReceiptState() {
        return (this.#current?.custody?.keptReceiptState() ??
            Object.freeze({ active: false, since: null }));
    }
    /**
     * Stop the tick and the watch and close the connection. Members are not
     * closed; they fail `closed` from then on. Use `dispose()` to also allow
     * in-flight discovery up to two seconds to release its file handles.
     */
    close() {
        if (this.#shutdown.signal.aborted)
            return;
        this.#shutdown.abort(closed('Claustrum discovery hub is closed'));
        if (this.#timer)
            (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer);
        this.#timer = undefined;
        const current = this.#current;
        if (current)
            this.#end(current);
        this.#own = undefined;
        this.#watch?.watch.close();
        this.#watch = undefined;
    }
    /** Close immediately, then join background work for at most two seconds. */
    async dispose() {
        this.close();
        this.#disposing ??= drainShutdown(this.#pending, this.#warnShutdown);
        await this.#disposing;
    }
}
