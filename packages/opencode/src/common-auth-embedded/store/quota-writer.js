import { createLogger } from '../logger/index.js';
import { QUOTA_COMMIT_INTERVAL_MS, quotaCommitTimer, } from '../quota/commit-interval.js';
import { assertQuotaEpoch, assertQuotaRow, mergedQuota, } from './attribution.js';
import { PoolOperationError } from './errors.js';
import { toFailure, withTransaction } from './mutate.js';
import { LockStack } from './refresh-lock.js';
import { readRow, refusal } from './runtime.js';
import { entryIn } from './schema.js';
const COALESCE_MS = 100;
/**
 * The most readings one row keeps waiting for a flush. Hosts record a reading
 * about every 100 ms at most, so for them a queue this long means another
 * writer has held the store locks for many seconds. Reaching it starts
 * a flush at once instead of waiting for the coalescing timer or a retry
 * backoff; a further reading for the row waits for room (never dropping an
 * older one) for as long as the store's normal lock budget, and is then
 * refused with `lock-contention`, as the immediate writer would refuse it.
 */
export const POOL_QUOTA_QUEUE_LIMIT = 128;
// Readings are queued whole per row and applied at flush in arrival order
// through the codec's own merge, so the codec alone decides which fields a
// newer or older reading replaces. Like the roster writer, a reading stays
// queued until the flush that took it commits: one queued while a flush waits
// for its locks must survive that flush.
export class PoolQuotaWriter {
    rt;
    timeoutMs;
    clock;
    pending = new Map();
    warned = new Set();
    wake = new Set();
    logger;
    timer;
    committedAt;
    running;
    closing;
    closed = false;
    stopped = false;
    failures = 0;
    constructor(rt, timeoutMs = 1_000, clock = quotaCommitTimer) {
        this.rt = rt;
        this.timeoutMs = timeoutMs;
        this.clock = clock;
        this.logger = rt.ctx.logger ?? createLogger('store');
    }
    async record(id, attribution, observation) {
        try {
            this.assertOpen(id);
            assertQuotaEpoch(id, attribution);
            // Snapshot before the first await: callers may reuse their headers object.
            const publication = structuredClone({
                id,
                attribution,
                observation,
            });
            const { row, result } = await readRow(this.rt, 'pull', id);
            assertQuotaRow(id, publication.attribution, row);
            // Merge into what read() shows now, so a reading the codec refuses is
            // refused to its caller here, as the immediate writer would refuse it.
            mergedQuota(this.rt.ctx, id, this.overlayRow({ ...row, quota: entryIn(result.config, id)?.quota })
                .quota, publication.observation);
            await this.room(id);
            this.assertOpen(id);
            // No await between the room check and the push, so the cap holds.
            const queue = this.pending.get(id) ?? [];
            queue.push(publication);
            this.pending.set(id, queue);
            if (queue.length >= POOL_QUOTA_QUEUE_LIMIT)
                this.flushNow();
            else
                this.schedule(COALESCE_MS);
        }
        catch (error) {
            throw toFailure(error, 'pull', id, { writes: 0 });
        }
    }
    queued(id) {
        return this.pending.get(id)?.length ?? 0;
    }
    // Waits while the row's queue is full, flushing at once on every wake-up,
    // for at most the store's own lock acquisition budget.
    async room(id) {
        if (this.queued(id) < POOL_QUOTA_QUEUE_LIMIT)
            return;
        const { ctx } = this.rt;
        const budget = Math.max(0, ...ctx.storeLocks.map((spec) => spec.timeoutMs ?? ctx.lockDefaults.timeoutMs));
        const deadline = performance.now() + budget;
        while (this.queued(id) >= POOL_QUOTA_QUEUE_LIMIT) {
            this.assertOpen(id);
            this.flushNow();
            const left = deadline - performance.now();
            if (left <= 0)
                throw refusal('pull', id, 'lock-contention', `pool quota queue for ${id} is full (${POOL_QUOTA_QUEUE_LIMIT} readings) and the store locks stayed held`, true);
            await new Promise((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    this.wake.delete(done);
                    resolve();
                };
                const timer = setTimeout(done, left);
                this.wake.add(done);
            });
        }
    }
    assertOpen(id) {
        if (this.closed)
            throw refusal('pull', id, 'invalid-input', 'pool quota writer is closed');
    }
    // What read() and load() show: the stored map, then each queued reading of
    // the row still bound to it, in arrival order through the codec's merge.
    // A reading the codec now refuses is left out, as the flush drops it.
    overlayRow(row) {
        let next = row;
        for (const publication of this.pending.get(row.id) ?? []) {
            try {
                assertQuotaRow(row.id, publication.attribution, row);
                next = {
                    ...next,
                    quota: mergedQuota(this.rt.ctx, row.id, next.quota, publication.observation),
                    needsFirstReading: false,
                };
            }
            catch { }
        }
        return next;
    }
    overlay(rows) {
        return rows.map((row) => this.overlayRow(row));
    }
    schedule(delay) {
        if (this.running || this.timer || !this.pending.size || this.stopped)
            return;
        const remaining = this.closed
            ? 0
            : (this.committedAt ?? -Infinity) +
                QUOTA_COMMIT_INTERVAL_MS -
                this.clock.now();
        this.timer = this.clock.schedule(Math.max(delay, remaining), () => {
            this.timer = undefined;
            return this.flush();
        });
        if (!this.closed)
            this.timer.unref?.();
    }
    cancelTimer() {
        this.timer?.cancel();
        this.timer = undefined;
    }
    // A full queue overrides the interval: response handling must not wait for
    // a quota commit slot. A flush already running is left to finish.
    flushNow() {
        if (this.running)
            return;
        this.cancelTimer();
        this.flush();
    }
    flush() {
        if (this.running || this.stopped || !this.pending.size)
            return this.running ?? Promise.resolve();
        // Every queued reading, each row's in arrival order.
        const batch = [...this.pending.values()].flat();
        // Short lock attempts allow retries to pick up freshly queued readings and
        // bound shutdown even when the normal store acquisition budget is long.
        const ctx = {
            ...this.rt.ctx,
            storeLocks: this.rt.ctx.storeLocks.map((spec) => ({
                ...spec,
                timeoutMs: Math.min(spec.timeoutMs ?? this.rt.ctx.lockDefaults.timeoutMs, 100),
            })),
        };
        const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv);
        this.running = (async () => {
            try {
                await withTransaction(ctx, locks, { writes: 0 }, { operation: 'pull', rowId: undefined }, async (tx) => {
                    if (this.stopped)
                        return;
                    let changed = false;
                    for (const publication of batch) {
                        const { id, attribution, observation } = publication;
                        const witness = JSON.stringify([
                            id,
                            attribution.credentialEpoch,
                            attribution.identity,
                        ]);
                        try {
                            tx.assertNotStaged(id);
                            assertQuotaRow(id, attribution, tx.row(id));
                        }
                        catch (error) {
                            if (!(error instanceof PoolOperationError))
                                throw error;
                            if (!this.warned.has(witness)) {
                                this.warned.add(witness);
                                this.warn('pool quota publication dropped; account binding changed', { id, kind: error.kind });
                            }
                            continue;
                        }
                        const entry = tx.entry(id);
                        if (!entry)
                            continue;
                        let quota;
                        try {
                            quota = mergedQuota(ctx, id, entry.quota, observation);
                        }
                        catch (error) {
                            // The codec accepted this reading when it was queued, but not
                            // against what is stored now (another writer changed it).
                            // Drop only this reading: failing the transaction would retry
                            // the same refusal forever and hold back every other row.
                            const key = `codec:${witness}`;
                            if (!this.warned.has(key)) {
                                this.warned.add(key);
                                this.warn('pool quota publication dropped; the quota codec refused it', {
                                    id,
                                    error: error instanceof Error ? error.message : String(error),
                                });
                            }
                            continue;
                        }
                        tx.setEntry(id, { ...entry, quota, needsFirstReading: false });
                        changed = true;
                    }
                    if (changed && !this.stopped) {
                        await tx.commitConfig();
                        this.committedAt = this.clock.now();
                    }
                }, { completeTorn: false });
                const flushed = new Set(batch);
                for (const [id, queue] of this.pending) {
                    const rest = queue.filter((publication) => !flushed.has(publication));
                    if (rest.length)
                        this.pending.set(id, rest);
                    else
                        this.pending.delete(id);
                }
                this.failures = 0;
            }
            catch (error) {
                if (!this.stopped && this.failures++ === 0)
                    this.warn('pool quota publication delayed; retrying', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                // Retain the mailbox on failure, including fresher readings queued meanwhile.
            }
            finally {
                await locks.releaseAll();
                this.running = undefined;
                for (const wake of this.wake)
                    wake();
                const delay = this.failures
                    ? Math.min(5_000, 100 * 2 ** Math.min(this.failures, 6)) *
                        (0.5 + Math.random())
                    : COALESCE_MS;
                this.schedule(delay);
            }
        })();
        return this.running;
    }
    warn(message, data) {
        try {
            this.logger.warn(message, data);
        }
        catch {
            /* Logging cannot stop publication. */
        }
    }
    close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        this.closing = this.drain();
        return this.closing;
    }
    async drain() {
        this.cancelTimer();
        let deadline;
        let wake;
        const drained = new Promise((done) => {
            wake = () => {
                if (!this.pending.size)
                    done();
            };
            this.wake.add(wake);
            wake();
        });
        try {
            this.flush();
            await Promise.race([
                drained,
                new Promise((done) => {
                    deadline = setTimeout(done, Math.max(0, this.timeoutMs));
                }),
            ]);
        }
        finally {
            this.stopped = true;
            clearTimeout(deadline);
            this.cancelTimer();
            this.wake.delete(wake);
            if (this.pending.size)
                this.warn('pool quota drain timed out; pending readings left', {
                    accounts: this.pending.size,
                    readings: [...this.pending.values()].reduce((sum, queue) => sum + queue.length, 0),
                });
            this.pending.clear();
            // A reading waiting for room in a full queue is refused as closed when
            // the drain ends, not when its own lock budget runs out.
            for (const wake of this.wake)
                wake();
        }
    }
}
