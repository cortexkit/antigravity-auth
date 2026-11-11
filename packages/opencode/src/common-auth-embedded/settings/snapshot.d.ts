import { type SettingsDefinition } from './define.js';
import { type SettingsParseResult } from './parse.js';
export type ReportReason = 'unknown-key' | 'override-not-allowed' | 'user-only-in-project' | 'invalid-value' | 'invalid-schema-version' | 'newer-version-key-ignored' | 'duplicate-key' | 'unparseable' | 'unreadable';
export interface ReportEntry {
    file: {
        kind: 'user' | 'project' | 'legacy-project';
        path: string;
    };
    keyPath: string[];
    reason: ReportReason;
    detail?: string;
}
export interface SettingsSnapshot {
    file: ReportEntry['file'];
    /** Only usable values remain; override objects retain their allowed keys. */
    settings: Record<string, unknown>;
    entries: ReportEntry[];
    schemaVersion: number;
    newer: boolean;
    hasDuplicates: boolean;
    parsed: SettingsParseResult;
}
/** Validate all overrides now, including values for hosts not requested later. */
export declare function buildSettingsSnapshot(definition: SettingsDefinition, file: ReportEntry['file'], parsed: SettingsParseResult): SettingsSnapshot;
