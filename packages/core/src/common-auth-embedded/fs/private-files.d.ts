import { rename } from 'node:fs/promises';
import type { PosixOwnerOnlyPathAsyncOptions } from '@cortexkit/private-files';
export declare const windowsPrivateFiles: boolean;
type Backend = typeof import('@cortexkit/private-files');
type Kind = 'file' | 'directory';
/** Tests inject a backend here; production always imports the private-files package. */
export declare function setPrivateFilesBackendForTest(api?: Backend): void;
/** The fixed `reason` of a refusal because the Windows native addon did not load. */
export declare const PRIVATE_FILES_UNAVAILABLE_REASON = "native-addon-unavailable";
export declare class PrivateFileError extends Error {
    readonly path: string;
    readonly stage: string;
    readonly code: string;
    readonly win32Code?: number;
    readonly reason?: string;
    published: boolean;
    durabilityConfirmed: boolean;
    fileDurable: boolean;
    attempts: number;
    elapsedMs: number;
    orphanPath?: string;
    constructor(path: string, stage: string, cause: unknown);
}
export declare function privateOperation<T>(path: string, stage: string, operation: () => Promise<T>): Promise<T>;
/** Tests only: policy options used by safe-parent checks that pass none. */
export declare function setSafeParentOptionsForTest(options?: PosixOwnerOnlyPathAsyncOptions): void;
/** Existing containing directories use the shared entry-integrity policy, not secret-file permissions. */
export declare function verifySafeDirectory(path: string, options?: PosixOwnerOnlyPathAsyncOptions): Promise<void>;
/** Repair only the specific owned secret file supplied by a caller, never an existing directory tree. */
export declare function verifyPrivate(path: string, kind: Kind, migrate?: boolean): Promise<void>;
/** Create missing components privately; inspect existing ancestors without modifying them. */
export declare function ensurePrivateDirectory(path: string, _migrate?: boolean, options?: PosixOwnerOnlyPathAsyncOptions): Promise<void>;
export declare function readPrivateText(path: string, migrate?: boolean): Promise<string>;
export declare function readPrivateBuffer(path: string, migrate?: boolean): Promise<Buffer>;
export declare function createPrivateBytes(path: string, bytes: string): Promise<void>;
export declare function createPrivateDirectoryExclusive(path: string): Promise<void>;
export interface ReplaceOptions {
    beforeRename?: () => Promise<void>;
    /** Absolute monotonic deadline, for an expiring lease. */
    deadline?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    rename?: typeof rename;
}
/** Retry Windows rename sharing/access errors within a budget; they never prove lease contention. */
export declare function replaceWindowsFile(from: string, to: string, options?: ReplaceOptions): Promise<{
    attempts: number;
    elapsedMs: number;
}>;
export interface PrivateWriteOutcome {
    path: string;
    stage: string;
    published: boolean;
    fileDurable: boolean;
    durabilityConfirmed: boolean;
    attempts: number;
    elapsedMs: number;
    code?: string;
    win32Code?: number;
}
export declare function writePrivateAtomic(path: string, bytes: string, options?: ReplaceOptions & {
    stagePath?: string;
    onRenamed?: () => void;
    durable?: boolean;
    durability?: 'file-only-on-windows';
    onOutcome?: (outcome: PrivateWriteOutcome) => void;
}): Promise<void>;
export {};
