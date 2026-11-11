import { join, resolve } from 'node:path';
import { isWindowsAccessDeniedCreate, isWindowsAccessDeniedRead, } from './lock-record.js';
import { isWindowsSharingViolation, windowsPrivateFiles, } from './private-files.js';
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
export function isChangingLockRecord(error, target, name) {
    const path = resolve(lockPathFor(target, name));
    const paths = [path, join(path, 'owner.json')];
    return (((isWindowsSharingViolation(error) ||
        isWindowsAccessDeniedRead(error, paths)) &&
        (error.stage === 'read' || error.stage === 'verify') &&
        paths.includes(error.path)) ||
        (windowsPrivateFiles &&
            (isWindowsAccessDeniedCreate(error, [path], 'create') ||
                isWindowsAccessDeniedCreate(error, [`${path}.evicting`], 'directory-create'))));
}
export async function withLock(target, options, fn) {
    const started = performance.now();
    let changingRecordError;
    for (;;) {
        options.signal?.throwIfAborted();
        let lock;
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
            changingRecordError = undefined;
        }
        catch (error) {
            if (!isChangingLockRecord(error, target, options.name))
                throw error;
            // Ambiguous reads or creates reveal neither ownership nor expiry. Retry
            // exclusive creation within the same deadline, never infer staleness from IO.
            lock = null;
            changingRecordError ??= error;
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
            if (changingRecordError)
                throw changingRecordError;
            throw new LockContentionError({
                target,
                name: options.name,
                timeoutMs: options.timeoutMs,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.ceil(remaining))));
    }
}
