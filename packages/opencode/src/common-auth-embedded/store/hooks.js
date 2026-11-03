import { AsyncLocalStorage } from 'node:async_hooks';
import { PoolReentryError } from './errors.js';
/**
 * Set while a store hook runs, recording whether its store locks are released.
 * Async context is inherited by every timer, promise and continuation inside the hook,
 * so work a hook schedules is inside the guarded region too.
 */
const insideHook = new AsyncLocalStorage();
const insideCodec = new AsyncLocalStorage();
/** Refuses a row operation or refresh called from inside a hook. */
export function assertNotInsideHook(operation) {
    if (insideHook.getStore() !== undefined)
        throw new PoolReentryError(operation);
}
/** Namespace writes need only the store locks, not the row lock a hook may retain. */
export function assertLimitsWriteAllowed() {
    if (insideHook.getStore()?.storeLocksReleased === false ||
        insideCodec.getStore())
        throw new PoolReentryError('updateLimitsNamespace');
}
/** Codecs may run under store locks even when no asynchronous hook is active. */
export function runInsideCodec(fn) {
    return insideCodec.run(true, fn);
}
export function runInsideHook(operation, fn, storeLocksReleased = false) {
    return insideHook.run({
        operation,
        storeLocksReleased: storeLocksReleased &&
            insideHook.getStore()?.storeLocksReleased !== false,
    }, async () => await fn());
}
/**
 * Runs a failure hook. A hook that throws never replaces the failure it was
 * handed: its exception is logged and discarded.
 */
export async function callFailureHook(operation, hook, rowId, error, logger) {
    if (!hook)
        return;
    try {
        await runInsideHook(operation, () => hook(rowId, error), true);
    }
    catch (hookError) {
        logger?.warn('store failure hook threw; the original failure stands', {
            operation,
            rowId,
            error: hookError instanceof Error ? hookError.message : String(hookError),
        });
    }
}
