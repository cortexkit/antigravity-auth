import { AsyncLocalStorage } from 'node:async_hooks';
import { PoolReentryError } from './errors.js';
/**
 * Set while a hook of a lock-holding operation runs. Async context is
 * inherited by every timer, promise and continuation created inside the hook,
 * so work a hook schedules is inside the guarded region too.
 */
const insideHook = new AsyncLocalStorage();
/** Refuses a row operation or refresh called from inside a hook. */
export function assertNotInsideHook(operation) {
    if (insideHook.getStore() !== undefined)
        throw new PoolReentryError(operation);
}
export function runInsideHook(operation, fn) {
    return insideHook.run(operation, async () => await fn());
}
/**
 * Runs a failure hook. A hook that throws never replaces the failure it was
 * handed: its exception is logged and discarded.
 */
export async function callFailureHook(operation, hook, rowId, error, logger) {
    if (!hook)
        return;
    try {
        await runInsideHook(operation, () => hook(rowId, error));
    }
    catch (hookError) {
        logger?.warn('store failure hook threw; the original failure stands', {
            operation,
            rowId,
            error: hookError instanceof Error ? hookError.message : String(hookError),
        });
    }
}
