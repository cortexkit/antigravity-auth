import { acquireRefreshFileLock } from '../fs/refresh-file-lock.js';
import { LockContentionError } from '../fs/with-lock.js';
/**
 * Store lock defaults: a 15 000 ms bounded wait retried every 50 ms plus
 * jitter, and a renewed 10 000 ms lease.
 */
export const POOL_LOCK_DEFAULTS = Object.freeze({
    ttlMs: 10_000,
    timeoutMs: 15_000,
    retryMs: 50,
    renew: true,
});
/**
 * Takes one lock, retrying while a live holder has it until `timeoutMs` has
 * passed on the real clock, then throws `LockContentionError`. The lease is
 * asserted as owned once acquired, so a caller never proceeds on a lease that
 * expired during the wait.
 */
export async function acquirePoolLock(spec, defaults, env) {
    const emit = (type) => {
        try {
            const result = env.onLockEvent?.({
                type,
                name: spec.name,
                path: spec.path,
            });
            if (result &&
                (typeof result === 'object' || typeof result === 'function') &&
                'then' in result &&
                typeof result.then === 'function') {
                void Promise.resolve(result).catch(() => { });
            }
        }
        catch {
            // Lock observers must not affect acquisition or release.
        }
    };
    const options = { ...defaults, ...definedOnly(spec) };
    const started = performance.now();
    for (;;) {
        const lock = await acquireRefreshFileLock({
            name: spec.name,
            path: spec.path,
            ttlMs: options.ttlMs,
            now: env.now,
            renew: options.renew,
            onContended: () => emit('contended'),
            ...(options.renewIntervalMs !== undefined
                ? { renewIntervalMs: options.renewIntervalMs }
                : {}),
            ...(env.onLockStep
                ? {
                    onStep: (step) => env.onLockStep?.({ name: spec.name, path: spec.path }, step),
                }
                : {}),
        });
        if (lock) {
            emit('acquired');
            const held = {
                name: spec.name,
                path: spec.path,
                assertOwned: () => lock.assertOwned(),
                release: async () => {
                    await lock.release();
                    emit('released');
                },
            };
            try {
                await held.assertOwned();
            }
            catch (error) {
                await held.release();
                throw error;
            }
            return held;
        }
        const remaining = options.timeoutMs - (performance.now() - started);
        if (remaining <= 0) {
            throw new LockContentionError({
                target: spec.path,
                name: spec.name,
                timeoutMs: options.timeoutMs,
            });
        }
        const jitter = Math.floor(Math.random() * (options.retryMs + 1));
        await new Promise((resolve) => setTimeout(resolve, Math.min(options.retryMs + jitter, remaining)));
    }
}
function definedOnly(spec) {
    const out = {};
    if (spec.ttlMs !== undefined)
        out.ttlMs = spec.ttlMs;
    if (spec.timeoutMs !== undefined)
        out.timeoutMs = spec.timeoutMs;
    if (spec.retryMs !== undefined)
        out.retryMs = spec.retryMs;
    if (spec.renew !== undefined)
        out.renew = spec.renew;
    if (spec.renewIntervalMs !== undefined)
        out.renewIntervalMs = spec.renewIntervalMs;
    return out;
}
/**
 * Locks taken in order and released in reverse. Every acquisition re-asserts
 * the leases already held, because a wait is exactly when an earlier lease
 * can expire unnoticed.
 */
export class LockStack {
    defaults;
    env;
    held = [];
    constructor(defaults, env) {
        this.defaults = defaults;
        this.env = env;
    }
    async acquire(spec) {
        const lock = await acquirePoolLock(spec, this.defaults, this.env);
        this.held.push(lock);
        await this.assertAll();
        return lock;
    }
    async assertAll() {
        for (const lock of this.held)
            await lock.assertOwned();
    }
    /** Releases every lock taken after `mark` (a length of `held`), newest first. */
    async releaseTo(mark) {
        while (this.held.length > mark) {
            const lock = this.held.pop();
            await lock?.release().catch(() => { });
        }
    }
    async releaseAll() {
        await this.releaseTo(0);
    }
}
