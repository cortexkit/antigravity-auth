import { PrivateFileError } from './private-files.js';
/** A failed open is not evidence of deletion until the same path disappears. */
export declare class DisappearedLockRecordError extends Error {
    readonly path: string;
    readonly code = "ENOENT";
    constructor(path: string, cause: unknown);
}
export declare function isWindowsAccessDeniedRead(error: unknown, paths: readonly string[]): error is PrivateFileError;
/**
 * An exclusive create at the lock or eviction-directory name can fail with
 * ACCESS_DENIED (5) while a holder's delete of that name is still pending. No
 * reread settles a create refusal, so callers retry only under their existing
 * bound and never infer staleness from it. owner.json is deliberately not a
 * candidate: a marker directory created exclusively a moment ago cannot hold a
 * delete-pending old owner.json, so a 5 there is a real refusal and the caller
 * removes the directory it just created.
 */
export declare function isWindowsAccessDeniedCreate(error: unknown, paths: readonly string[], stage: 'create' | 'directory-create'): error is PrivateFileError;
export declare function readLockRecord<T>(path: string, read: () => Promise<T>): Promise<T>;
