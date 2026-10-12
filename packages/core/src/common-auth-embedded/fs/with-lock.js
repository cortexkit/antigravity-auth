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
export async function withLock(target, options, fn) {
    const started = performance.now();
    for (;;) {
        const lock = await acquireRefreshFileLock({
            path: target,
            name: options.name,
            ttlMs: options.ttlMs,
            renew: options.renew ?? false,
        });
        if (lock) {
            try {
                return await fn(lock);
            }
            finally {
                await lock.release();
            }
        }
        const remaining = options.timeoutMs - (performance.now() - started);
        if (remaining <= 0) {
            throw new LockContentionError({
                target,
                name: options.name,
                timeoutMs: options.timeoutMs,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.ceil(remaining))));
    }
}
