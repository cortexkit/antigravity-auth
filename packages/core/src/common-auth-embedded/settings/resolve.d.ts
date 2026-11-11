import type { SettingDeclaration, SettingsDefinition } from './define.js';
import { type ValueOf } from './descriptors.js';
import type { SettingsSnapshot } from './snapshot.js';
export interface GetOptions {
    readonly host: string;
    readonly model?: string;
    readonly project?: string;
}
/** The caller selects the project snapshot for the requested project, if any. */
export interface ResolutionSnapshots {
    readonly user?: SettingsSnapshot;
    readonly project?: SettingsSnapshot;
}
/** Resolve sanitized snapshots without reading files or adding report entries. */
export declare function resolveSetting<S extends Readonly<Record<string, SettingDeclaration>>, K extends keyof S & string>(definition: SettingsDefinition<S>, name: K, options: GetOptions, snapshots?: ResolutionSnapshots): ValueOf<S[K]['value']>;
