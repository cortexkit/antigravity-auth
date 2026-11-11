import type { ChannelLogger } from '../logger/engine.js';
import { type PoolLockSpec } from '../store/refresh-lock.js';
import type { SettingsDefinition } from './define.js';
export interface MoveSource {
    host: string;
    path: string;
    locks: PoolLockSpec[];
    read(text: string): unknown;
}
export type LegacySource = {
    host: string;
    path: string;
} & ({
    present: true;
    value: unknown;
} | {
    present: false;
});
export interface MapResult {
    entries: {
        source: number;
        setting: string;
        value: unknown;
    }[];
    unmapped: {
        source: number;
        key: string;
        reason: string;
    }[];
}
export interface MoveOptions {
    definition: SettingsDefinition;
    target: string;
    separateInstall: boolean;
    sources: MoveSource[];
    /**
     * Runs under the source locks. Do not acquire settings-move or any lock in
     * sources[].locks, directly or through a store operation. A second acquisition
     * waits for the first to release, so the move would wait on itself. Read live
     * account records without locking.
     */
    map(legacy: LegacySource[]): MapResult | Promise<MapResult>;
    fence(): boolean | Promise<boolean>;
    log: Pick<ChannelLogger, 'warn' | 'info'>;
}
export type MoveOutcome = 'moved' | 'done-already' | 'fence-closed' | 'aborted-target-appeared' | 'busy' | 'separate-install' | 'failed';
export interface MoveResult {
    outcome: MoveOutcome;
    unmapped: MapResult['unmapped'];
    differing: {
        setting: string;
        values: {
            source: number;
            host: string;
            value: unknown;
        }[];
    }[];
    noteFailures: {
        path: string;
        error: unknown;
    }[];
    postPublishFailures: {
        step: 'temp-unlink' | 'directory-sync' | 'lock-release';
        error: unknown;
    }[];
    cause?: unknown;
}
type StepHook = (step: 'locked' | 'staged' | 'before-publish', paths: {
    target: string;
    temp?: string;
}) => void | Promise<void>;
/** Internal test hook, not part of the settings subpath's public exports. */
export declare function setSettingsMoveStepHookForTest(hook?: StepHook): void;
/** Move legacy settings without replacing an existing target or changing a source. */
export declare function moveSettingsOnce(options: MoveOptions): Promise<MoveResult>;
export {};
