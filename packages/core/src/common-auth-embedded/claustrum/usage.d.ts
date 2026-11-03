import type { ClaustrumLogger } from './errors.js';
/** Reply quota metadata, never authorization headers or bearer material. */
export interface ClaustrumUsageReading {
    provider: string;
    observedAtMs: number;
    headers?: Record<string, string>;
    frame?: unknown;
    account?: string;
}
/** Structural to also typecheck with the claustrum-client 0.6.2 peer minimum. */
export interface ScopedUsageSource {
    reportUsageScoped?(input: {
        credentialId: string;
        reading: Record<string, unknown>;
        enrollmentToken?: string;
    }): Promise<void>;
}
export interface ClaustrumUsageReportState {
    readonly pending: number;
    readonly inFlight: boolean;
    readonly dropped: number;
}
/** One queue per custody connection, shared by every hub member on it. */
export declare class ScopedUsageReporter {
    #private;
    private readonly options;
    constructor(options: {
        client: ScopedUsageSource;
        owns: (credentialId: string) => boolean;
        token: () => Promise<string>;
        logger: ClaustrumLogger;
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
    });
    state(): ClaustrumUsageReportState;
    report(credentialId: string, reading: ClaustrumUsageReading): void;
    forget(credentialId: string): void;
    /** Start the final flush; the custody's existing shutdown drain bounds it. */
    close(): Promise<void> | undefined;
    drop(): void;
}
