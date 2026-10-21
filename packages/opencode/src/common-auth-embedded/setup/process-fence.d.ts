import type { CommandRunner, ProcessFence, SetupEnvironment } from './types.js';
export interface ProcessInspectionStep {
    step: 'tasklist' | 'CIM' | 'ps';
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    durationMs: number;
}
export declare class ProcessInspectionError extends Error implements ProcessInspectionStep {
    readonly code = "process-inspection-failed";
    readonly step: ProcessInspectionStep['step'];
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly durationMs: number;
    constructor(details: ProcessInspectionStep);
    get refusalText(): string;
}
export declare class ProcessFenceViolationError extends Error {
    readonly activeHosts: Array<{
        pid: number;
        command: string;
    }>;
    constructor(activeHosts: Array<{
        pid: number;
        command: string;
    }>);
}
/** List processes before filtering hosts; Windows PID 0 is a valid idle-process row. */
export declare function listSetupProcesses(runner?: CommandRunner, options?: {
    platform?: string;
    env?: SetupEnvironment;
    onStep?: (details: ProcessInspectionStep) => void;
    /** False skips the Windows PowerShell query for Node and Bun command lines. */
    inspectRuntimes?: boolean;
    /**
     * The process to leave out, the running setup itself. Defaults to
     * `process.pid`; tests pass a value no listed process can have, because in
     * a container this process can hold any small PID a fixture uses.
     */
    selfPid?: number;
}): Promise<Array<{
    pid: number;
    command: string;
}>>;
export declare function createProcessFence(runner?: CommandRunner, options?: {
    platform?: string;
    selfPid?: number;
}): ProcessFence;
export declare function assertHostsStopped(fence: ProcessFence, env?: SetupEnvironment): Promise<void>;
