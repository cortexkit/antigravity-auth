export interface AtomicWriteOptions {
    serialize?: (value: unknown) => string;
    beforeRename?: () => Promise<void>;
    /** Test seam for forcing staging-name collisions; defaults to randomUUID. */
    stageName?: () => string;
    /** Sync the staged file and, after rename, its parent directory. Opt-in. */
    durable?: boolean;
}
/** Internal classification of fsync failures, including a failure after rename. */
export declare class AtomicSyncError extends Error {
    constructor(cause: unknown);
}
export declare function writeJsonAtomic(path: string, value: unknown, options?: AtomicWriteOptions): Promise<void>;
/**
 * Notify internal callers at the rename. The store records committed writes
 * and removed ids here, because a later directory sync cannot undo the rename.
 */
export declare function writeJsonAtomicTracked(path: string, value: unknown, options: AtomicWriteOptions, onRenamed?: () => void): Promise<void>;
/** Make an already renamed file and its directory durable without rewriting bytes. */
export declare function syncJsonFile(path: string): Promise<void>;
