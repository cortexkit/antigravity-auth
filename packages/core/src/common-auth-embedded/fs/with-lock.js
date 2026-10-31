import { join, resolve } from 'node:path';
import { PrivateFileError, windowsPrivateFiles } from './private-files.js';
import { acquireRefreshFileLock } from './refresh-file-lock.js';
export function lockPathFor(target, name) {
    return `${target}.${name}.lock`;
}
export class LockContentionError extends Error {
    details;
    constructor(details) {
        super(`Timed out acquiring ${details.name} lock for ${details.target}`);
        this.name = 'LockContentionError';
        this.details = details;
    }
}
export class LockOwnershipError extends Error {
    details;
    constructor(details) {
        super(`Lost ${details.name} lock for ${details.target}`);
        this.name = 'LockOwnershipError';
        this.details = details;
    }
}
function isChangingLockRead(error, target, name) {
    if (!windowsPrivateFiles ||
        !(error instanceof PrivateFileError) ||
        error.reason !== 'io-error' ||
        (error.win32Code !== 32 && error.win32Code !== 303) ||
        (error.stage !== 'read' && error.stage !== 'verify'))
        return false;
    const path = resolve(lockPathFor(target, name));
    return error.path === path || error.path === join(path, 'owner.json');
}
export async function withLock(target, options, fn) {
    const started = performance.now();
    for (;;) {
        options.signal?.throwIfAborted();
        let lock;
        let changingReadError;
        try {
            lock = await acquireRefreshFileLock({
                path: target,
                name: options.name,
                ttlMs: options.ttlMs,
                renew: options.renew ?? false,
                ...(options.onStep ? { onStep: options.onStep } : {}),
                ...(options.onRenewalTimer
                    ? { onRenewalTimer: options.onRenewalTimer }
                    : {}),
            });
        }
        catch (error) {
            if (!isChangingLockRead(error, target, options.name))
                throw error;
            // Sharing violations (32) and delete-pending opens (303) do not reveal
            // ownership or expiry. Retry exclusive creation, never infer a stale lock.
            lock = null;
            changingReadError = error;
        }
        if (lock) {
            try {
                options.signal?.throwIfAborted();
                return await fn(lock);
            }
            finally {
                await lock.release(options.signal);
            }
        }
        const remaining = options.timeoutMs - (performance.now() - started);
        if (remaining <= 0) {
            // Keep persistent native IO failures distinguishable from a live holder.
            if (changingReadError)
                throw changingReadError;
            throw new LockContentionError({
                target,
                name: options.name,
                timeoutMs: options.timeoutMs,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.ceil(remaining))));
    }
}
