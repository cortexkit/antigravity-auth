import type { StoredCredential } from './schema.js';
/** Every library operation that can fail, as named in the failure value. */
export type PoolOperation = 'initialize' | 'add' | 'replace' | 'rotate' | 'disable' | 'enable' | 'remove' | 'reorder' | 'updateSettings' | 'recordIdentity' | 'updateProviderState' | 'refresh' | 'pull';
/**
 * How far an operation got before it failed.
 *
 * `before-first-write`: nothing was written; both files are as they were.
 * `after-first-write`: the operation's first file write landed and a later one
 * did not; what that first write left is on disk and is never rolled back
 * (add: a state entry no roster row names, which no reader loads; replace:
 * the new credential stamped ahead of the config, which readers show as a
 * torn row and the next store write on it completes; rotate: the rotated
 * credential beside the old per-row entry). `pull`: a quota pull, or the
 * recording of its result, failed.
 */
export type PoolFailurePhase = 'before-first-write' | 'after-first-write' | 'pull';
/**
 * Why an operation failed. `lock-contention` and `lock-ownership` are the two
 * lock outcomes (a wait that ran out, and a lease found lost); the rest are
 * refusals and failures of the operation itself.
 */
export type PoolFailureKind = 'lock-contention' | 'lock-ownership' | 'pending-migration' | 'load-error' | 'unknown-row' | 'invalid-row' | 'invalid-input' | 'id-exists' | 'id-removed' | 'type-mismatch' | 'no-credential' | 'row-disabled' | 'row-protected' | 'duplicate-identity' | 'identity-mismatch' | 'identity-contradicted' | 'endpoint-mismatch' | 'row-key-changed' | 'invalid-order' | 'refresh-stamp-ahead' | 'unbound-credential' | 'attribution' | 'provider' | 'pull' | 'invalid-quota' | 'invalid-provider-state' | 'after-persist-hook' | 'unexpected';
/**
 * The single failure value of every store operation. `committed` is present
 * only when the operation had already written a credential to the state file
 * before it failed (a partial rotation or refresh): it is the credential now
 * on disk, so a caller never has to re-read the files to learn it.
 */
export declare class PoolOperationError extends Error {
    readonly operation: PoolOperation;
    readonly rowId: string | undefined;
    readonly phase: PoolFailurePhase;
    readonly retryable: boolean;
    readonly kind: PoolFailureKind;
    readonly committed: StoredCredential | undefined;
    constructor(details: {
        operation: PoolOperation;
        rowId?: string;
        phase: PoolFailurePhase;
        retryable: boolean;
        kind: PoolFailureKind;
        committed?: StoredCredential;
        message?: string;
        cause?: unknown;
    });
}
/**
 * Thrown when a row operation or a refresh is called from inside a hook of a
 * lock-holding operation (or from any continuation created inside one). It is
 * thrown before any lock is taken or waited for.
 */
export declare class PoolReentryError extends Error {
    readonly operation: PoolOperation;
    constructor(operation: PoolOperation);
}
