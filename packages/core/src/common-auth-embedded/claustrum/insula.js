import { resolve } from 'node:path';
import { storeIdentity } from '@cortexkit/claustrum-client';
// A static import: claustrum-client already loads subc-client whenever
// /claustrum is imported, so loading it lazily saves nothing, and a dynamic
// import makes bundlers emit a separate chunk that a running host loses when
// its dist folder is rebuilt underneath it.
import { SubcClient } from '@cortexkit/subc-client';
import { classifyVaultFailure } from './availability.js';
import { ChangeNoticeReader, CoalescedRead, RESUBSCRIBE_BACKOFF_MS, WATCH_RETRY_MS, } from './watch.js';
/** Constructing this transport opens no connection; getUsage opens one per call. */
export function insulaUsageTransport(options) {
    const identity = options.identity ??
        storeIdentity(options.projectRoot ?? process.cwd(), options.storagePath ?? process.cwd());
    return {
        connectionFile: options.connectionFile,
        async getUsage() {
            let client;
            let expired = false;
            let timer;
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('insula usage timeout')), 3_000);
                timer.unref?.();
            });
            const request = (async () => {
                client = options.connector
                    ? await options.connector({
                        connectionFile: options.connectionFile,
                        handshakeTimeoutMs: Math.min(options.handshakeTimeoutMs ?? 3_000, 3_000),
                    })
                    : await SubcClient.connect({
                        connectionFile: options.connectionFile,
                        handshakeTimeoutMs: Math.min(options.handshakeTimeoutMs ?? 3_000, 3_000),
                    });
                // A slow connector may resolve after the whole-call deadline. It still
                // owns a socket, which must not survive or open a route after fallback.
                if (expired) {
                    client.close();
                    throw new Error('insula usage timeout');
                }
                // Managed call() retries warming routes. A single routeOpen/request
                // instead lets the plugin fall back as soon as the daemon refuses.
                const route = await client.routeOpen({ kind: 'management_surface', module_id: 'insula' }, identity);
                return await client.request(route, { method: 'usage.get', params: {} });
            })();
            try {
                return await Promise.race([request, timeout]);
            }
            finally {
                expired = true;
                clearTimeout(timer);
                client?.close();
            }
        },
        watchUsage(onNotice) {
            // The watch holds its own connection for as long as it is open: each
            // usage.get above opens and closes a short-lived one, and the scoped
            // credential connection is never shared with insula. The method name
            // alone makes the request a watch; subc-client does not yet set the
            // SUBSCRIPTION flag, and insula does not require it.
            let client;
            let subscription;
            let stopped = false;
            const closed = (async () => {
                let deadline;
                const timeout = new Promise((_resolve, reject) => {
                    deadline = setTimeout(
                    // Coded as a timeout, so InsulaQuotaSource treats a watch that could
                    // not open in time as an unreachable insula and tries again later,
                    // not as a refusal.
                    () => reject(Object.assign(new Error('insula watch timeout'), {
                        code: 'timeout',
                    })), 3_000);
                    deadline.unref?.();
                });
                const open = (async () => {
                    const handshakeTimeoutMs = Math.min(options.handshakeTimeoutMs ?? 3_000, 3_000);
                    const connected = options.connector
                        ? await options.connector({
                            connectionFile: options.connectionFile,
                            handshakeTimeoutMs,
                        })
                        : await SubcClient.connect({
                            connectionFile: options.connectionFile,
                            handshakeTimeoutMs,
                        });
                    client = connected;
                    // A connection that arrives after stop() or after the open deadline
                    // must not keep a route or socket alive.
                    if (stopped) {
                        connected.close();
                        return;
                    }
                    const route = await connected.routeOpen({ kind: 'management_surface', module_id: 'insula' }, identity);
                    if (stopped) {
                        connected.close();
                        return;
                    }
                    subscription = connected.subscribe(route, { method: 'usage.watch' }, onNotice);
                })();
                try {
                    await Promise.race([open, timeout]);
                }
                catch (error) {
                    stopped = true;
                    throw error;
                }
                finally {
                    clearTimeout(deadline);
                }
                if (subscription)
                    await subscription.closed;
            })().finally(() => {
                stopped = true;
                client?.close();
            });
            return {
                stop() {
                    if (stopped)
                        return;
                    stopped = true;
                    subscription?.unsubscribe();
                    client?.close();
                },
                closed,
            };
        },
    };
}
const MINUTE = 60_000;
const MAX_AGE = 4 * MINUTE;
// consumer-contract.md:331 refetches a slot after 60 s. Two such intervals
// bound our willingness to wait, not a claim that insula completed its sweep.
const COLD_WAIT = 2 * MINUTE;
const sources = new Map();
// Keep only the minute budget after the last owner closes, so project churn
// cannot reset the bound. Expired budgets are pruned on the next tick.
const attempts = new Map();
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeUsageNotice(body) {
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    }
    catch {
        return undefined;
    }
    if (!record(value) ||
        typeof value.kind !== 'string' ||
        typeof value.epoch !== 'string' ||
        value.epoch.length === 0 ||
        typeof value.seq !== 'number' ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 1 ||
        (value.provider !== undefined && typeof value.provider !== 'string'))
        return undefined;
    return {
        kind: value.kind,
        epoch: value.epoch,
        seq: value.seq,
        ...(typeof value.provider === 'string' && { provider: value.provider }),
    };
}
function refusalCode(error) {
    return error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string'
        ? error.code
        : undefined;
}
export class InsulaQuotaSource {
    transport;
    key;
    #entries = [];
    #available = false;
    #completeProviders = new Set();
    #coldSince = new Map();
    /** Every usage.get, polled or watch-driven, shares this one slot. */
    #reads = new CoalescedRead(async () => {
        try {
            const reply = await this.transport.getUsage();
            if (!record(reply) ||
                !Array.isArray(reply.result) ||
                reply.error !== undefined)
                throw new Error('unavailable insula usage');
            // Each response is a snapshot, not a delta. Only completeProviders
            // asserts completeness; neither pending nor the entry count does.
            this.#entries = reply.result.filter((entry) => record(entry) && typeof entry.provider === 'string');
            this.#available =
                this.#entries.length === reply.result.length &&
                    (reply.completeProviders === undefined ||
                        (Array.isArray(reply.completeProviders) &&
                            reply.completeProviders.every((value) => typeof value === 'string')));
            this.#completeProviders = new Set(this.#available && Array.isArray(reply.completeProviders)
                ? reply.completeProviders
                : []);
            for (const provider of this.#completeProviders)
                this.#coldSince.delete(provider);
        }
        catch {
            // Refusal is absence, even if the previous reading was still young.
            this.#entries = [];
            this.#available = false;
            this.#completeProviders.clear();
        }
    }, () => { });
    #reader = new ChangeNoticeReader();
    #mode = 'polling';
    #watchers = 0;
    /**
     * How many registered watchers read every provider. Watchers limited to one
     * provider are counted per provider in `#providers` instead.
     */
    #everyProvider = 0;
    #providers = new Map();
    #watch;
    #timer;
    #timers = {};
    /**
     * How many accepted watches in a row have closed; each one doubles the wait
     * before the next re-subscribe. Reset once a watch brings a second notice.
     */
    #closes = 0;
    constructor(transport, key) {
        this.transport = transport;
        this.key = key;
    }
    /**
     * The background poll: at most one usage.get per minute per daemon and
     * enrollment token. While a watch is open it reads nothing, because insula's
     * notices announce every new reading. If insula stops announcing an account,
     * that account's last entry grows older than the freshness limit `current()`
     * applies, `current()` returns nothing for it, and the plugin falls back to
     * its own provider poll for that account.
     */
    refresh(now) {
        if (this.#reads.running)
            return this.#reads.running;
        if (this.#mode === 'watching')
            return Promise.resolve();
        for (const [key, time] of attempts) {
            if (now - time >= MINUTE)
                attempts.delete(key);
        }
        const lastAttempt = attempts.get(this.key);
        if (lastAttempt !== undefined && now - lastAttempt < MINUTE)
            return Promise.resolve();
        // Reserve the minute before I/O, so concurrent projects cannot each poll.
        attempts.set(this.key, now);
        return this.#reads.request();
    }
    /** How this source currently learns about usage changes, for logs. */
    watchMode() {
        return this.#mode;
    }
    /**
     * Hold a `usage.watch` open while any watcher wants it, and re-read
     * usage.get when a notice says something changed. Watchers of one source
     * share one watch, since insula admits only 64 per process. Returns the
     * release; the last release closes the watch.
     */
    watch(options = {}) {
        this.#watchers++;
        const provider = options.provider;
        if (provider === undefined)
            this.#everyProvider++;
        else
            this.#providers.set(provider, (this.#providers.get(provider) ?? 0) + 1);
        if (this.#watchers === 1) {
            this.#timers = options;
            this.#open();
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            if (provider === undefined)
                this.#everyProvider--;
            else {
                const left = (this.#providers.get(provider) ?? 1) - 1;
                if (left > 0)
                    this.#providers.set(provider, left);
                else
                    this.#providers.delete(provider);
            }
            if (--this.#watchers === 0)
                this.#stopWatch();
        };
    }
    #stopWatch() {
        if (this.#timer)
            (this.#timers.clearTimeoutImpl ?? clearTimeout)(this.#timer);
        this.#timer = undefined;
        const watch = this.#watch;
        this.#watch = undefined;
        watch?.handle?.stop();
        this.#mode = 'polling';
    }
    #later(delay) {
        this.#timer = (this.#timers.setTimeoutImpl ?? setTimeout)(() => {
            this.#timer = undefined;
            if (this.#watchers > 0 && !this.#watch)
                this.#open();
        }, delay);
        this.#timer.unref?.();
    }
    #open() {
        const watchUsage = this.transport.watchUsage;
        if (!watchUsage) {
            // A custom transport that cannot watch: poll exactly as before.
            this.#mode = 'fallback';
            return;
        }
        this.#mode = 'polling';
        this.#reader.restart();
        const watch = { notices: 0 };
        this.#watch = watch;
        let handle;
        try {
            handle = watchUsage.call(this.transport, (body) => this.#notice(watch, body));
        }
        catch (error) {
            this.#closed(watch, error);
            return;
        }
        watch.handle = handle;
        handle.closed.then(() => this.#closed(watch, undefined), (error) => this.#closed(watch, error));
    }
    #notice(watch, body) {
        // Frames already in transport can arrive after a local stop.
        if (this.#watch !== watch)
            return;
        watch.notices++;
        if (watch.notices === 1)
            this.#mode = 'watching';
        // A second notice means the watch stayed up past its acceptance.
        if (watch.notices === 2)
            this.#closes = 0;
        const notice = decodeUsageNotice(body);
        // An unreadable notice may hide any change: treat it as a break, and
        // make the next notice read as one too.
        if (!notice)
            this.#reader.restart();
        const continuous = notice ? this.#reader.continuous(notice) : false;
        // The first notice of every watch names no provider, so it always reads:
        // nothing was watched before it. After a gap or a new epoch notices were
        // lost, so read even when this notice names another provider.
        if (!continuous ||
            notice?.provider === undefined ||
            this.#everyProvider > 0 ||
            this.#providers.has(notice.provider))
            void this.#reads.request();
    }
    #closed(watch, error) {
        if (this.#watch !== watch)
            return;
        this.#watch = undefined;
        const code = refusalCode(error);
        if (code === 'unknown_method' || code === 'usage_watch_limit') {
            // An insula that predates usage.watch, or one already holding 64
            // watches: poll exactly as before until every watcher has released.
            this.#mode = 'fallback';
            return;
        }
        if (watch.notices > 0) {
            // An accepted watch that closed (insula shut down, or the connection
            // dropped) gets one new watch, whose first notice reads usage.get.
            const delay = Math.min(RESUBSCRIBE_BACKOFF_MS * 2 ** Math.min(this.#closes, 16), WATCH_RETRY_MS);
            this.#closes++;
            this.#mode = 'polling';
            this.#later(delay);
            return;
        }
        // Closed before any notice, so never accepted: read once to learn
        // whether insula answers at all, then poll as before. A refusal insula
        // answered stands until every watcher has released. A close it did not
        // explain (a
        // dropped connection, a timeout, a stream ended at once while insula
        // shuts down) earns one new watch much later.
        this.#mode = 'fallback';
        void this.#reads.request();
        if (error === undefined || classifyVaultFailure(error) === 'unreachable')
            this.#later(WATCH_RETRY_MS);
    }
    current(provider, accountId, now) {
        for (const entry of this.#entries) {
            if (entry.provider !== provider ||
                typeof entry.account !== 'string' ||
                entry.account.trim() !== accountId)
                continue;
            if (entry.stale !== undefined ||
                entry.errorClass !== undefined ||
                !record(entry.usage))
                continue;
            const fetchedAt = typeof entry.fetchedAt === 'string'
                ? Date.parse(entry.fetchedAt)
                : Number.NaN;
            if (!Number.isFinite(fetchedAt) || now - fetchedAt >= MAX_AGE)
                continue;
            return {
                entry,
                context: {
                    fetchedAt,
                    ...(typeof entry.source === 'string' && { source: entry.source }),
                },
            };
        }
        return undefined;
    }
    /** Cache-only background lookup; current() retains its original miss behavior. */
    lookup(provider, accountId, now) {
        if (!this.#available)
            return { miss: 'unreachable' };
        const entry = this.#entries.find((value) => value.provider === provider &&
            typeof value.account === 'string' &&
            value.account.trim() === accountId);
        // An unlabelled error describes the provider's credential path, not an
        // unrelated labelled account. Never borrow another account's verdict.
        const errorClass = (entry ??
            this.#entries.find((value) => value.provider === provider &&
                value.account === undefined &&
                value.errorClass !== undefined))?.errorClass;
        if (errorClass === 'upstream_failed')
            return { miss: 'upstream-failed' };
        if (errorClass === 'credential_absent' ||
            errorClass === 'credential_unusable' ||
            errorClass === 'credential_rejected')
            return { miss: 'credential' };
        if (errorClass !== undefined)
            return { miss: 'unreachable' };
        if (entry) {
            const fetchedAt = typeof entry.fetchedAt === 'string'
                ? Date.parse(entry.fetchedAt)
                : Number.NaN;
            if (!record(entry.usage) || !Number.isFinite(fetchedAt))
                return { miss: 'unreachable' };
            const reading = {
                entry,
                context: {
                    fetchedAt,
                    ...(typeof entry.source === 'string' && { source: entry.source }),
                },
            };
            // Kept usage must not trigger a provider poll after a non-local failure.
            // Only an explicitly local failure permits fallback; unknown causes do not.
            if (entry.stale !== undefined &&
                (!record(entry.stale) ||
                    entry.stale.class !== 'local_source_unavailable'))
                return { miss: 'upstream-failed', reading };
            return now >= fetchedAt + MAX_AGE || entry.stale !== undefined
                ? { miss: 'stale', reading }
                : { reading };
        }
        if (this.#completeProviders.has(provider))
            return { miss: 'absent' };
        const since = this.#coldSince.get(provider) ?? now;
        this.#coldSince.set(provider, since);
        return { miss: now - since >= COLD_WAIT ? 'unreachable' : 'cold' };
    }
}
export function acquireInsulaQuotaSource(transport, tokenPath) {
    const key = JSON.stringify([
        resolve(transport.connectionFile),
        resolve(tokenPath),
    ]);
    let shared = sources.get(key);
    if (!shared) {
        shared = { source: new InsulaQuotaSource(transport, key), refs: 0 };
        sources.set(key, shared);
    }
    shared.refs++;
    let released = false;
    return {
        source: shared.source,
        release() {
            if (released)
                return;
            released = true;
            if (--shared.refs === 0)
                sources.delete(key);
        },
    };
}
