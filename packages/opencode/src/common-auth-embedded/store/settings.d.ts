import { PoolOperationError } from './errors.js';
import type { PoolLockSpec } from './refresh-lock.js';
import type { StoreRuntime } from './runtime.js';
/**
 * Top-level config keys the pool owns: the legacy `version`, the legacy
 * roster (`accounts`) and the pool's own key. A settings write never reads
 * them into the settings it hands out and refuses a result that sets them,
 * so the roster and the per-row entries change only through row operations.
 */
export declare const POOL_OWNED_KEYS: readonly string[];
/** The plugin's settings: every top-level config key except the pool-owned ones. */
export type PoolSettings = Record<string, unknown>;
export type SettingsRead = {
    status: 'ready';
    settings: PoolSettings;
}
/**
 * The config still holds a legacy roster with no pool key. Its settings
 * read the same way; `updateSettings` refuses until the pool is initialized.
 */
 | {
    status: 'pending-migration';
    settings: PoolSettings;
} | {
    status: 'error';
    file: 'config' | 'state';
    reason: string;
};
/**
 * Receives a private copy of the current settings and either edits it in
 * place (returning nothing) or returns the complete next settings object.
 * It runs under the store locks, so it must not call back into the store:
 * a store operation called from inside it is refused (`PoolReentryError`).
 */
export type SettingsMutator = (settings: PoolSettings) => PoolSettings | undefined | Promise<PoolSettings | undefined>;
/**
 * Options of `updateSettings`. It names no row, so its failure hook is
 * handed only the failure; like `reorder` it takes the extra locks, then the
 * store locks, and no row or provider-wide lock.
 */
export interface UpdateSettingsOptions {
    /** Called once, awaited, on every non-success path, before the extra locks release. */
    onFailure?: (error: PoolOperationError) => void | Promise<void>;
    /** Locks taken, in this order, before the store locks. */
    extraLocks?: readonly PoolLockSpec[];
}
export type UpdateSettingsResult = {
    /** The settings now on disk. */
    settings: PoolSettings;
    /** `unchanged` when the mutator left the settings as they were; nothing was written. */
    outcome: 'updated' | 'unchanged';
};
/** Reads the settings without taking a lock or writing anything. */
export declare function readPoolSettings(rt: StoreRuntime): Promise<SettingsRead>;
/**
 * One locked read-modify-write of the plugin's settings in the config file
 * the pool lives in. The pool must be ready (a pending migration or a load
 * error refuses before the mutator runs). A mutator result that sets a
 * pool-owned key refuses (`invalid-input`) with nothing written; a result
 * equal to the current settings writes nothing. The state file is never
 * touched, and the pool-owned keys are written back exactly as read.
 */
export declare function updatePoolSettings(rt: StoreRuntime, mutator: SettingsMutator, options?: UpdateSettingsOptions): Promise<UpdateSettingsResult>;
