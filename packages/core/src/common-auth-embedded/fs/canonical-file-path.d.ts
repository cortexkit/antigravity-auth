import type * as syncFs from 'node:fs';
import type * as fs from 'node:fs/promises';
type FilePathFs = Pick<typeof fs, 'lstat' | 'readlink' | 'realpath'>;
type FilePathSyncFs = Pick<typeof syncFs, 'lstatSync' | 'readlinkSync' | 'realpathSync'>;
/**
 * Canonical path of a file that other processes may replace by write-and-rename.
 *
 * On Linux, Bun's realpath on such a file can answer "<file> (deleted)" (Bun
 * 1.3) or ENOENT (Bun 1.4) during the rename. So this resolves the folder with
 * realpath and appends the name, then follows a file symlink one readlink hop at
 * a time, at most 40 hops. A missing file resolves to its would-be path; a
 * dangling link or a loop throws. Pass `node:fs/promises` (or a test double).
 */
export declare function canonicalFilePath(file: string, fs: FilePathFs): Promise<string>;
/** Synchronous counterpart of canonicalFilePath; pass `node:fs`. */
export declare function canonicalFilePathSync(file: string, fs: FilePathSyncFs): string;
export {};
