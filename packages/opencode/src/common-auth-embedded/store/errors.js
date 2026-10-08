/**
 * The single failure value of every store operation. `committed` is present
 * only when the operation had already written a credential to the state file
 * before it failed (a partial rotation or refresh): it is the credential now
 * on disk, so a caller never has to re-read the files to learn it.
 */
export class PoolOperationError extends Error {
    operation;
    rowId;
    phase;
    retryable;
    kind;
    committed;
    constructor(details) {
        super(details.message ??
            `${details.operation} failed (${details.kind}, ${details.phase})`, details.cause === undefined ? undefined : { cause: details.cause });
        this.name = 'PoolOperationError';
        this.operation = details.operation;
        this.rowId = details.rowId;
        this.phase = details.phase;
        this.retryable = details.retryable;
        this.kind = details.kind;
        this.committed = details.committed;
    }
}
/**
 * Thrown when a row operation or a refresh is called from inside a hook of a
 * lock-holding operation (or from any continuation created inside one). It is
 * thrown before any lock is taken or waited for.
 */
export class PoolReentryError extends Error {
    operation;
    constructor(operation) {
        super(`${operation} was called from inside a store hook; hand it to the caller's continuation instead`);
        this.name = 'PoolReentryError';
        this.operation = operation;
    }
}
