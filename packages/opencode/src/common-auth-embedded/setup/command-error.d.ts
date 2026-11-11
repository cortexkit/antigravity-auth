import type { SetupHostEnrollment } from './types.js';
/**
 * Keeps the Pi install refusal message stable while exposing safe process details.
 * A clipped tail can start inside a credential, so discard its first line—or
 * the whole tail if it has no newline—before redacting.
 */
export declare class SetupCommandError extends Error {
    readonly step = "pi-install";
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stderrTail: string;
    constructor(details: {
        exitCode: number | null;
        signal: string | null;
        stderrTail: string;
        stderrTruncated?: boolean;
    });
}
/** The line setup prints for one host's outcome, e.g. `Pi: not connected`. */
export declare function setupEnrollmentLine({ host, outcome, access, }: SetupHostEnrollment): string;
/**
 * Remember which hosts a failed setup left connected to the vault, against the
 * thrown value. Only objects can carry a record; a thrown primitive is left as
 * it is, and the printed lines are then the only report.
 */
export declare function recordSetupEnrollment(failure: unknown, enrollment: readonly SetupHostEnrollment[]): void;
/**
 * The per-host vault enrollment outcomes a failed `runSetup` recorded for the
 * value it threw, or `undefined` when setup failed before any host's enrollment
 * began, or the value is not one setup threw (or is not an object).
 */
export declare function setupEnrollment(error: unknown): readonly SetupHostEnrollment[] | undefined;
