import { recordQuota } from './attribution.js';
import { PoolOperationError } from './errors.js';
import { toFailure, withTransaction } from './mutate.js';
import { LockStack } from './refresh-lock.js';
import { requireBound } from './runtime.js';
/**
 * Fires quota pulls without ever making a caller wait for one. A pull first
 * gives a row without a per-row entry its entry at epoch 1 (its own locked
 * config write), then captures the credential and the attribution tuple in
 * one locked read, requests the observation, and records it only if
 * attribution still holds. Failures go to the store's pull failure hook.
 */
export class PullScheduler {
    rt;
    hook;
    onFailure;
    firedAtLoad;
    logger;
    inflight = new Set();
    constructor(rt, hook, onFailure, 
    /** Rows a load-time pull has fired for in this process. */
    firedAtLoad, logger) {
        this.rt = rt;
        this.hook = hook;
        this.onFailure = onFailure;
        this.firedAtLoad = firedAtLoad;
        this.logger = logger;
    }
    fire(id, reason) {
        if (!this.hook)
            return;
        if (reason === 'load') {
            if (this.firedAtLoad.has(id))
                return;
            this.firedAtLoad.add(id);
        }
        const run = this.run(id, reason);
        this.inflight.add(run);
        void run.finally(() => this.inflight.delete(run));
    }
    /** Resolves once every pull fired so far has settled. */
    async settled() {
        while (this.inflight.size > 0)
            await Promise.allSettled([...this.inflight]);
    }
    async run(id, reason) {
        const rt = this.rt();
        const { ctx } = rt;
        const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv);
        const progress = { writes: 0 };
        try {
            const request = await withTransaction(ctx, locks, progress, { operation: 'pull', rowId: id }, async (tx) => {
                const row = tx.row(id);
                // A row that would pull but for its unbound credential refuses, so
                // the failure hook hears of it instead of the pull vanishing.
                if (row?.unbound &&
                    row.enabled &&
                    row.type === 'oauth' &&
                    row.credential &&
                    !row.invalid)
                    requireBound('pull', row);
                // Disabled, API-key and credential-less rows never pull.
                if (!row?.candidate || row.type !== 'oauth')
                    return undefined;
                if (!row.hasEntry) {
                    tx.setEntry(id, { credentialEpoch: 1, needsFirstReading: true });
                    await tx.commitConfig();
                }
                const current = tx.row(id);
                if (!current?.credential || current.credentialEpoch === undefined)
                    return undefined;
                return {
                    id,
                    credential: current.credential,
                    credentialEpoch: current.credentialEpoch,
                    ...(current.identity !== undefined
                        ? { identity: current.identity }
                        : {}),
                    reason,
                };
            });
            await locks.releaseAll();
            if (!request) {
                this.firedAtLoad.delete(id);
                return;
            }
            await ctx.hold?.('pull-before-request', id);
            let observation;
            try {
                observation = await this.hook?.(request);
            }
            catch (cause) {
                throw new PoolOperationError({
                    operation: 'pull',
                    rowId: id,
                    phase: 'pull',
                    retryable: true,
                    kind: 'pull',
                    message: 'the quota pull rejected',
                    cause,
                });
            }
            await recordQuota(rt, id, {
                credentialEpoch: request.credentialEpoch,
                ...(request.identity !== undefined
                    ? { identity: request.identity }
                    : {}),
            }, observation);
        }
        catch (error) {
            // Needs-first-reading stays set; a later load may fire again.
            this.firedAtLoad.delete(id);
            const failure = toFailure(error, 'pull', id, progress);
            if (this.onFailure) {
                try {
                    await this.onFailure(id, failure);
                }
                catch (hookError) {
                    this.logger?.warn('pull failure hook threw', {
                        rowId: id,
                        error: hookError instanceof Error
                            ? hookError.message
                            : String(hookError),
                    });
                }
            }
            else {
                this.logger?.warn('quota pull failed', {
                    rowId: id,
                    kind: failure.kind,
                });
            }
        }
        finally {
            await locks.releaseAll();
        }
    }
}
