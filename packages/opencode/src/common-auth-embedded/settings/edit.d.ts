import type { SettingsDefinition } from './define.js';
export type SettingsEdit = {
    setting: string;
    path?: readonly string[];
} & ({
    value: unknown;
    remove?: never;
} | {
    remove: true;
    value?: never;
});
export interface UpdateResult {
    outcome: 'updated' | 'unchanged';
}
interface EditContext {
    host: string;
    model?: string;
}
/** Pure JSONC edit engine; the writer restores the BOM and owns durable I/O. */
export declare function applySettingsEdits(definition: SettingsDefinition, source: string, edits: readonly SettingsEdit[], context: EditContext): UpdateResult & {
    text: string;
    hasBom: boolean;
};
export {};
