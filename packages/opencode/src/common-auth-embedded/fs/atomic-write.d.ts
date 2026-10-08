export interface AtomicWriteOptions {
    serialize?: (value: unknown) => string;
    beforeRename?: () => Promise<void>;
    /** Test seam for forcing staging-name collisions; defaults to randomUUID. */
    stageName?: () => string;
}
export declare function writeJsonAtomic(path: string, value: unknown, options?: AtomicWriteOptions): Promise<void>;
