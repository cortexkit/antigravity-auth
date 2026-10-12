import { type PoolFailurePhase, type PoolOperation, PoolOperationError } from './errors.js';
import { type PoolLogger } from './hooks.js';
import { type LockEnvironment, LockStack, type PoolLockOptions, type PoolLockSpec } from './refresh-lock.js';
import { type PoolRow, type ProviderStateCodec, type QuotaCodec, type StoredCredential } from './schema.js';
/** Named points on the write path, for crash and ownership injection. */
export type WriteStep = 'before-config-write' | 'after-config-write' | 'before-state-write' | 'after-state-write';
/** Awaitable pause points on the pull and refresh paths. */
export type HoldPoint = 'refresh-before-provider' | 'pull-before-request';
export interface StoreContext {
    provider: string;
    configPath: string;
    statePath: string;
    codec: QuotaCodec;
    /** The provider-state codec; without one no row shows a provider state. */
    providerState?: ProviderStateCodec;
    now: () => number;
    storeLocks: readonly PoolLockSpec[];
    lockDefaults: PoolLockOptions;
    lockEnv: LockEnvironment;
    logger?: PoolLogger;
    onStep?: (step: WriteStep, info: {
        operation: PoolOperation;
        rowId: string | undefined;
    }) => void | Promise<void>;
    hold?: (point: HoldPoint, rowId: string) => void | Promise<void>;
    /** Ids whose per-row entry a library write dropped in this process. */
    removedIds: Set<string>;
    /**
     * When true, rows whose credential stamp is not bound load `unbound` and
     * the operations that use a credential refuse them (see
     * `OpenPoolStoreOptions.requireCredentialStamps`).
     */
    requireCredentialStamps?: boolean;
    requireRemovedFingerprint?: boolean;
}
export interface Snapshot {
    configExists: boolean;
    stateExists: boolean;
    config: Record<string, unknown>;
    state: Record<string, unknown>;
    rows: PoolRow[];
}
export type ReadResult = ({
    status: 'ready';
} & Snapshot) | {
    status: 'pending-migration';
    config: Record<string, unknown>;
} | {
    status: 'error';
    file: 'config' | 'state';
    reason: string;
    kind?: 'snapshot-contended';
    retryable?: true;
};
/**
 * Validate config/state/config bytes without locks. Roster replacement writes
 * config before deleting old state credentials. Re-read a changed config so an
 * old roster cannot be paired with state from which its accounts were removed.
 */
export declare function readPool(ctx: StoreContext): Promise<ReadResult>;
/** The refusal for a pool that is not ready, as a failure value. */
export declare function notReadyError(result: Exclude<ReadResult, {
    status: 'ready';
}>, operation: PoolOperation, rowId: string | undefined, phase?: PoolFailurePhase): PoolOperationError;
/** What an operation has written so far; decides the failure phase. */
export interface Progress {
    writes: number;
    /** The roster config was renamed into place, or its committed receipt was found. */
    publicationDecided?: true;
    /** The credential the operation's state write put on disk, once it has. */
    committed?: StoredCredential;
}
/**
 * One locked read-modify-write. The store locks are pushed onto the caller's
 * lock stack, so the ownership assertion before each write covers the outer
 * row, provider-wide and extra locks as well; they are released when the
 * transaction ends, whatever happens.
 */
export declare class Transaction {
    private readonly ctx;
    readonly snapshot: Snapshot;
    private readonly locks;
    private readonly progress;
    readonly info: {
        operation: PoolOperation;
        rowId: string | undefined;
    };
    config: Record<string, unknown>;
    state: Record<string, unknown>;
    constructor(ctx: StoreContext, snapshot: Snapshot, locks: LockStack, progress: Progress, info: {
        operation: PoolOperation;
        rowId: string | undefined;
    });
    /**
     * The rows as every reader loads them: a row torn between the writes of a
     * replace is shown as that replace leaves it once completed (see
     * `PoolRow.torn`).
     */
    rows(): PoolRow[];
    row(id: string): PoolRow | undefined;
    /** Read the config marker, or an orphan's stamp; never use a caller's reservation. */
    reservation(id: string): unknown;
    assertNotStaged(id: string): void;
    roster(): unknown[];
    /** The first roster row with this id (the one the pool loads). */
    rosterRow(id: string): Record<string, unknown> | undefined;
    /**
     * Drops every roster row carrying this id. The row's per-row entry goes with
     * it on the next `commitConfig`, which drops entries for ids no longer in
     * the roster. Returns how many roster rows were dropped.
     */
    dropRosterRows(id: string): number;
    entries(): Record<string, unknown>;
    entry(id: string): Record<string, unknown> | undefined;
    setEntry(id: string, entry: Record<string, unknown>): void;
    /**
     * Writes the config of every row torn between the writes of a replace, or
     * of a write giving it its first identity, as that write would have left it
     * (see `completeTornRows`), in one config
     * write ahead of the operation's own. The write is counted apart from the
     * operation's: it is setup, like a pull giving a row its entry, so a later
     * refusal still reports `before-first-write`.
     */
    completeTorn(): Promise<void>;
    stateAccount(id: string): Record<string, unknown> | undefined;
    /** Drops the row's credential and runtime fields from the state file's accounts. */
    dropStateAccount(id: string): void;
    setStateAccount(id: string, fields: Record<string, unknown>): void;
    /**
     * Writes the config: legacy `version: 1` and the legacy roster beside
     * `commonAuthPool`, every other top-level key and every unrecognised pool
     * key untouched. Entries for ids no longer in the roster are dropped here,
     * and remembered so the id is not reused in this process. Every id the
     * write drops (a roster row the files held when the transaction read them,
     * or an entry left without one) has its epoch recorded in the config (see
     * `retireEpochsIn`), which is what keeps a later `add` of the id, from any
     * process, past every epoch an attribution could name.
     */
    commitConfig(options?: {
        counted?: boolean;
        durable?: boolean;
        publicationDecision?: boolean;
    }): Promise<void>;
    /** Writes the state: every unrecognised top-level and per-row key kept. */
    commitState(committed?: StoredCredential, options?: {
        durable?: boolean;
    }): Promise<void>;
    assertAll(): Promise<void>;
    syncState(): Promise<void>;
    markPublicationDecision(): void;
    syncConfig(): Promise<void>;
    private write;
}
/** What `initializePool` did. */
export type InitializeOutcome = 'initialized' | 'already-ready';
/**
 * Adds the pool key to a config that holds a legacy roster without one, under
 * the store-lock list, in one config write: `commonAuthPool` with the schema
 * version and no row entries, the legacy roster and every other top-level key
 * kept, except the keys named in `dropKeys`. The state file is not touched.
 * This is the only write the store makes to a pending-migration config; it is
 * where a plugin's migration starts, and every later row goes through the
 * ordinary operations. A config that is already a pool is left alone; a load
 * error refuses.
 */
export declare function initializePool(ctx: StoreContext, dropKeys: readonly string[]): Promise<InitializeOutcome>;
/**
 * Runs `fn` under the store-lock list. The pool must be ready: a pending
 * migration or a load error refuses before anything is written. Unless
 * `completeTorn` is false, rows torn between the writes of a replace are
 * completed first, so `fn` never sees one; the writes that only record
 * readings or reorder the roster opt out and leave such rows as they are.
 */
export declare function withTransaction<T>(ctx: StoreContext, locks: LockStack, progress: Progress, info: {
    operation: PoolOperation;
    rowId: string | undefined;
}, fn: (tx: Transaction) => Promise<T>, options?: {
    completeTorn?: boolean;
}): Promise<T>;
/** Maps anything thrown inside an operation onto the one failure value. */
export declare function toFailure(error: unknown, operation: PoolOperation, rowId: string | undefined, progress: Progress): PoolOperationError;
/**
 * The frame every lock-holding operation runs in: failures are mapped onto
 * the failure value, handed to the failure hook while the outer locks are
 * still held (the store locks are already released), and rethrown; every
 * lock is released afterwards. `rowId` is undefined for an operation that
 * names no row (`reorder`).
 */
export declare function runOperation<T, R extends string | undefined = string>(ctx: StoreContext, operation: PoolOperation, rowId: R, onFailure: ((rowId: R, error: PoolOperationError) => void | Promise<void>) | undefined, body: (locks: LockStack, progress: Progress) => Promise<T>): Promise<T>;
