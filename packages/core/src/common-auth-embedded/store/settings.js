import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from '../fs/atomic-write.js';
import { PoolOperationError } from './errors.js';
import { assertNotInsideHook, runInsideHook } from './hooks.js';
import { notReadyError, readPool, runOperation } from './mutate.js';
import { isRecord, POOL_KEY } from './schema.js';
/**
 * Top-level config keys the pool owns: the legacy `version`, the legacy
 * roster (`accounts`) and the pool's own key. A settings write never reads
 * them into the settings it hands out and refuses a result that sets them,
 * so the roster and the per-row entries change only through row operations.
 */
export const POOL_OWNED_KEYS = Object.freeze([
    'version',
    'accounts',
    POOL_KEY,
]);
function settingsOf(config) {
    const settings = {};
    for (const [key, value] of Object.entries(config))
        if (!POOL_OWNED_KEYS.includes(key))
            defineKey(settings, key, value);
    return settings;
}
/** Sets a key as an own data property, so a `__proto__` key stays a plain key. */
function defineKey(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}
/**
 * The next config: the pool-owned keys exactly as read, every settings key
 * from `next` in its existing position, settings keys `next` dropped left
 * out, and new settings keys appended.
 */
function composeConfig(config, next) {
    const out = {};
    for (const [key, value] of Object.entries(config)) {
        if (POOL_OWNED_KEYS.includes(key))
            defineKey(out, key, value);
        else if (Object.hasOwn(next, key))
            defineKey(out, key, next[key]);
    }
    for (const [key, value] of Object.entries(next))
        if (!Object.hasOwn(config, key))
            defineKey(out, key, value);
    return out;
}
function settingsRefusal(message) {
    return new PoolOperationError({
        operation: 'updateSettings',
        phase: 'before-first-write',
        retryable: false,
        kind: 'invalid-input',
        message,
    });
}
/** Reads the settings without taking a lock or writing anything. */
export async function readPoolSettings(rt) {
    const result = await readPool(rt.ctx);
    if (result.status === 'error')
        return result;
    return { status: result.status, settings: settingsOf(result.config) };
}
/**
 * One locked read-modify-write of the plugin's settings in the config file
 * the pool lives in. The pool must be ready (a pending migration or a load
 * error refuses before the mutator runs). A mutator result that sets a
 * pool-owned key refuses (`invalid-input`) with nothing written; a result
 * equal to the current settings writes nothing. The state file is never
 * touched, and the pool-owned keys are written back exactly as read.
 */
export async function updatePoolSettings(rt, mutator, options = {}) {
    assertNotInsideHook('updateSettings');
    const { ctx } = rt;
    const onFailure = options.onFailure;
    return runOperation(ctx, 'updateSettings', undefined, onFailure && ((_rowId, error) => onFailure(error)), async (locks, progress) => {
        for (const extra of options.extraLocks ?? [])
            await locks.acquire(extra);
        // `mark` is where the store locks start on the lock stack. They are
        // released at the end of this block, so `onFailure` runs holding only
        // the caller's extra locks, as it does for every other store operation.
        const mark = locks.held.length;
        try {
            for (const spec of ctx.storeLocks)
                await locks.acquire(spec);
            const result = await readPool(ctx);
            if (result.status !== 'ready')
                throw notReadyError(result, 'updateSettings', undefined);
            const current = settingsOf(result.config);
            const draft = structuredClone(current);
            const returned = await runInsideHook('updateSettings', () => mutator(draft));
            const next = returned === undefined ? draft : returned;
            if (!isRecord(next))
                throw settingsRefusal('the settings mutator must produce an object');
            const owned = POOL_OWNED_KEYS.filter((key) => Object.hasOwn(next, key));
            if (owned.length > 0)
                throw settingsRefusal(`settings cannot set the pool-owned key(s) ${owned.join(', ')}`);
            if (isDeepStrictEqual(next, current))
                return { settings: current, outcome: 'unchanged' };
            const config = composeConfig(result.config, next);
            const info = { operation: 'updateSettings', rowId: undefined };
            await writeJsonAtomic(ctx.configPath, config, {
                beforeRename: async () => {
                    await ctx.onStep?.('before-config-write', info);
                    await locks.assertAll();
                },
            });
            progress.writes++;
            await ctx.onStep?.('after-config-write', info);
            return { settings: settingsOf(config), outcome: 'updated' };
        }
        finally {
            await locks.releaseTo(mark);
        }
    });
}
