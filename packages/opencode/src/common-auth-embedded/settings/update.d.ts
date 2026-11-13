import type { SettingsDefinition } from './define.js';
import { type SettingsEdit, type UpdateResult } from './edit.js';
import type { OpenSettingsOptions } from './handle.js';
import type { GetOptions } from './resolve.js';
export type SettingsCurrent = {
    readonly status: 'missing';
} | {
    readonly status: 'ready';
    readonly document: Readonly<Record<string, unknown>>;
};
/** Compute edits synchronously from an immutable copy read under the write lock. */
export type SettingsUpdatePlan = (current: SettingsCurrent) => readonly SettingsEdit[];
/** Lock the canonical user file so symlink aliases serialize the same edits. */
export declare function updateSettings(definition: SettingsDefinition, options: OpenSettingsOptions, edits: readonly SettingsEdit[] | SettingsUpdatePlan, context: Pick<GetOptions, 'host' | 'model'>): Promise<UpdateResult>;
