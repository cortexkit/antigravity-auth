import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Internal classification of fsync failures, including a failure after rename. */
export class AtomicSyncError extends Error {
    constructor(cause) {
        super('file or directory sync failed', { cause });
        this.name = 'AtomicSyncError';
    }
}
export async function writeJsonAtomic(path, value, options = {}) {
    await writeJsonAtomicTracked(path, value, options);
}
/**
 * Notify internal callers at the rename. The store records committed writes
 * and removed ids here, because a later directory sync cannot undo the rename.
 */
export async function writeJsonAtomicTracked(path, value, options, onRenamed) {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${(options.stageName ?? randomUUID)()}.tmp`;
    let handle;
    let created = false;
    try {
        handle = await open(tempPath, 'wx', 0o600);
        created = true;
        await handle.writeFile(options.serialize
            ? options.serialize(value)
            : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.chmod(0o600);
        if (options.durable) {
            try {
                await handle.sync();
            }
            catch (cause) {
                throw new AtomicSyncError(cause);
            }
        }
        await handle.close();
        handle = undefined;
        await options.beforeRename?.();
        await rename(tempPath, path);
        created = false;
        onRenamed?.();
        if (options.durable) {
            const directory = await open(dirname(path), 'r');
            try {
                await directory.sync();
            }
            catch (cause) {
                throw new AtomicSyncError(cause);
            }
            finally {
                await directory.close();
            }
        }
    }
    finally {
        await handle?.close().catch(() => { });
        // A failed write can leave partial bytes, but a collision is not ours to remove.
        if (created)
            await rm(tempPath, { force: true }).catch(() => { });
    }
}
/** Make an already renamed file and its directory durable without rewriting bytes. */
export async function syncJsonFile(path) {
    const file = await open(path, 'r');
    try {
        await file.sync();
    }
    finally {
        await file.close();
    }
    const directory = await open(dirname(path), 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
