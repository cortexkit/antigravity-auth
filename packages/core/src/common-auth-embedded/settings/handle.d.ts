import type { ChannelLogger } from '../logger/engine.js';
import type { SettingDeclaration, SettingsDefinition } from './define.js';
import { type ValueOf } from './descriptors.js';
import type { SettingsEdit, UpdateResult } from './edit.js';
import { type GetOptions } from './resolve.js';
import { type ReportEntry } from './snapshot.js';
import { type SettingsUpdatePlan } from './update.js';
export interface LegacyProjectSource {
    readonly path: string;
    read(text: string): unknown;
}
export interface OpenSettingsOptions {
    readonly file: string;
    readonly log: Pick<ChannelLogger, 'warn' | 'info'>;
    readonly separateInstall: boolean;
    readonly createMissing?: boolean;
    readonly lockTimeoutMs?: number;
    readonly legacyProject?: (project: string) => LegacyProjectSource | undefined;
}
export interface SettingsHandle<S extends Readonly<Record<string, SettingDeclaration>> = Readonly<Record<string, SettingDeclaration>>> {
    read(options?: {
        readonly project?: string;
    }): Promise<void>;
    get<K extends keyof S & string>(name: K, options: GetOptions): Promise<ValueOf<S[K]['value']>>;
    report(): ReportEntry[];
    update(edits: readonly SettingsEdit[] | SettingsUpdatePlan, options: Pick<GetOptions, 'host' | 'model'>): Promise<UpdateResult>;
    watch(onChange: () => void): () => void;
}
/** Internal test hook; not part of the settings package exports. */
export declare function resetSettingsReportedForTest(): void;
export declare function openSettings<S extends Readonly<Record<string, SettingDeclaration>>>(definition: SettingsDefinition<S>, options: OpenSettingsOptions): SettingsHandle<S>;
