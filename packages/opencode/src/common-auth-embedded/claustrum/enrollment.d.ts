import { type ClaustrumClientOptions as ClaustrumEnrollmentClientOptions, type EnrollmentPollOutcome, type EnrollmentTokenFile, writeEnrollmentTokenFile } from '@cortexkit/claustrum-client';
/**
 * Codes the vault's closed enrollment-refusal vocabulary marks permanent. The
 * client labels some module error frames transient/retry regardless, so the
 * producer's code takes precedence over the client's action for these.
 */
export declare const TERMINAL_ENROLLMENT_CODES: ReadonlySet<string>;
/** Codes that are always worth another ceremony tick, whatever the action says. */
export declare const RETRYABLE_ENROLLMENT_CODES: ReadonlySet<string>;
export type EnrollmentDisposition = 'terminal' | 'retry';
/**
 * Classify an enrollment transport refusal as `(code, disposition)`. The
 * vault's own code wins: a terminal code is terminal even when the client
 * says retry, queue saturation is retryable even when it says gone, and any
 * other code follows the client's action. Errors that are not producer
 * refusals return undefined and are the caller's to rethrow.
 */
export declare function classifyEnrollmentError(error: unknown): {
    code: string;
    disposition: EnrollmentDisposition;
} | undefined;
/**
 * The name a plugin proposes for one host, for example `openai-auth-opencode`.
 * Each host enrolls separately so the operator can revoke one without the other.
 */
export declare function enrollmentName(plugin: string, host: string): string;
export interface ClaustrumEnrollmentClient {
    enrollPropose(input: {
        name: string;
        requestSecretHash: string;
    }): Promise<{
        requestId: string;
    }>;
    enrollPoll(input: {
        requestId: string;
        requestSecret: string;
    }): Promise<EnrollmentPollOutcome>;
}
export interface ClaustrumEnrollmentConnection extends ClaustrumEnrollmentClient {
    close(): void;
}
/**
 * Connect the enrollment ceremony. Setup calls this; the request path never
 * does. `connectionFile` is required because this library reads no
 * environment and knows no host paths.
 */
export declare function connectClaustrumEnrollmentClient(options: ClaustrumEnrollmentClientOptions & {
    connectionFile: string;
}): Promise<ClaustrumEnrollmentConnection>;
export type ClaustrumEnrollmentStatus = {
    state: 'idle';
} | {
    state: 'pending';
    proposedName: string;
    requestId?: string;
    retryCode?: string;
} | {
    state: 'approved';
    proposedName: string;
    approvedName?: string;
    tokenGeneration: number;
} | {
    state: 'denied';
    proposedName: string;
} | {
    state: 'blocked';
    proposedName: string;
    code: string;
} | {
    state: 'unavailable';
    proposedName: string;
    code: string;
} | {
    state: 'busy';
};
export interface ClaustrumEnrollmentPaths {
    statePath: string;
    tokenPath: string;
}
/** The ceremony state file sits next to the token: `x.json` pairs with `x-state.json`. */
export declare function getClaustrumEnrollmentPaths(tokenPath: string): ClaustrumEnrollmentPaths;
/**
 * One host's token and state paths. Every host gets its own pair under the
 * plugin's state directory, so an OpenCode enrollment and a Pi enrollment can
 * be approved and revoked independently. A plugin-resolved override replaces
 * the default token path; a relative override resolves against `cwd`.
 */
export declare function hostEnrollmentPaths(input: {
    stateDir: string;
    host: string;
    override?: string;
    cwd?: string;
}): ClaustrumEnrollmentPaths;
/** Account-file paths are injectable for isolated setup tests; no environment overrides. */
export interface EnrollmentAncestorOptions {
    passwdPath?: string;
    groupPath?: string;
}
/**
 * Protect setup writes from directory replacement. Group write access is safe
 * only when local account records prove that the effective user's group is private.
 */
export declare function refuseWritableAncestor(parent: string, options?: EnrollmentAncestorOptions): Promise<void>;
export declare function readClaustrumEnrollmentStatus(paths: ClaustrumEnrollmentPaths, proposedName: string): Promise<ClaustrumEnrollmentStatus>;
/**
 * Read fresh bearer material for one scoped operation; never publish it.
 * Re-reading per operation is what lets an operator reissue a token on disk.
 */
export declare function readClaustrumEnrollmentToken(tokenPath: string): Promise<EnrollmentTokenFile>;
/**
 * The enrollment ceremony for one host. Run it from setup only: it proposes,
 * polls and persists, and every step can wait on an operator. The request
 * path reads the resulting token and never calls into this class.
 */
export declare class ClaustrumEnrollmentManager {
    #private;
    constructor(options: {
        client: ClaustrumEnrollmentClient;
        paths: ClaustrumEnrollmentPaths;
        proposedName: string;
        now?: () => number;
        mintSecret?: () => string;
        writeTokenFile?: typeof writeEnrollmentTokenFile;
        ancestorOptions?: EnrollmentAncestorOptions;
    });
    status(): Promise<ClaustrumEnrollmentStatus>;
    resetTerminal(): Promise<ClaustrumEnrollmentResetResult>;
    reconcile(): Promise<ClaustrumEnrollmentStatus>;
}
export type ClaustrumEnrollmentResetResult = 'reset' | 'idle' | 'refused-pending' | 'refused-approved' | 'busy';
/** Reset local terminal metadata without connecting to the credential daemon. */
export declare function resetClaustrumEnrollmentState(paths: ClaustrumEnrollmentPaths, proposedName: string): Promise<ClaustrumEnrollmentResetResult>;
