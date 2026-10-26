import type { OpenCodeGeneration, SetupIO, SetupPlugin } from './types.js';
export interface PlannedWrite {
    path: string;
    content: string;
    changed: boolean;
    existingLocalEntries?: string[];
    existingNpmEntries?: string[];
}
/** Edit only array entries so unrelated JSONC text, including comments, survives. */
export declare function updatePluginConfig(text: string, key: 'plugin' | 'plugins', pkg: string, version: string): string;
export declare function planOpenCodeRegistration(plugin: SetupPlugin, generation: OpenCodeGeneration, io?: SetupIO): PlannedWrite[];
export declare function registerOpenCode(writes: readonly PlannedWrite[], beforeWrite?: () => Promise<void>): Promise<void>;
export declare function registerPi(plugin: SetupPlugin, executable: string, io?: SetupIO): Promise<void>;
