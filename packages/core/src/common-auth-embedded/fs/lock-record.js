import { resolve } from 'node:path';
import { PrivateFileError } from './private-files.js';
/** A failed open is not evidence of deletion until the same path disappears. */
export class DisappearedLockRecordError extends Error {
    path;
    code = 'ENOENT';
    constructor(path, cause) {
        super(`Lock record disappeared: ${path}`, { cause });
        this.path = path;
    }
}
export function isWindowsAccessDeniedRead(error, paths) {
    return (error instanceof PrivateFileError &&
        error.reason === 'io-error' &&
        error.win32Code === 5 &&
        (error.stage === 'read' || error.stage === 'verify') &&
        paths.some((path) => resolve(path) === error.path));
}
/**
 * An exclusive create at the lock or eviction-directory name can fail with
 * ACCESS_DENIED (5) while a holder's delete of that name is still pending. No
 * reread settles a create refusal, so callers retry only under their existing
 * bound and never infer staleness from it. owner.json is deliberately not a
 * candidate: a marker directory created exclusively a moment ago cannot hold a
 * delete-pending old owner.json, so a 5 there is a real refusal and the caller
 * removes the directory it just created.
 */
export function isWindowsAccessDeniedCreate(error, paths, stage) {
    return (error instanceof PrivateFileError &&
        error.reason === 'io-error' &&
        error.win32Code === 5 &&
        error.stage === stage &&
        paths.some((path) => resolve(path) === error.path));
}
export async function readLockRecord(path, read) {
    try {
        return await read();
    }
    catch (error) {
        if (!isWindowsAccessDeniedRead(error, [path]))
            throw error;
        // Windows commonly maps STATUS_DELETE_PENDING to ACCESS_DENIED (5),
        // which can also mean a permission refusal, not a sharing violation.
        // Only a successful fresh read or ENOENT resolves that ambiguity. A
        // persistent refusal escapes to the caller's existing deadline/backoff.
        try {
            return await read();
        }
        catch (recheckError) {
            if (recheckError.code === 'ENOENT')
                throw new DisappearedLockRecordError(path, error);
            throw error;
        }
    }
}
