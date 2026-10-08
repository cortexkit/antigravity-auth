import { type PoolOperation, PoolOperationError } from './errors.js';
import { type ReadResult, type StoreContext } from './mutate.js';
import type { PoolLockOptions, PoolLockSpec } from './refresh-lock.js';
import { type PoolRow } from './schema.js';
/** Where a pull was fired from; `load` fires at most once per process per row. */
export type PullReason = 'load' | 'add' | 'replace' | 'admission';
/** What every operation module shares. */
export interface StoreRuntime {
    ctx: StoreContext;
    providerLock: PoolLockSpec;
    rowLockOptions: Partial<PoolLockOptions>;
    firePull(id: string, reason: PullReason): void;
}
/**
 * The row lock's (name, path): keyed by the row's recorded wire identity when
 * known, else its local id, beside the state file. The key is prefixed and
 * URL-encoded so it can never name a store lock or leave the directory.
 */
export declare function rowLockSpec(rt: StoreRuntime, row: Pick<PoolRow, 'id' | 'identity'>): PoolLockSpec;
/** An unlocked read that must find a ready pool holding the row. */
export declare function readRow(rt: StoreRuntime, operation: PoolOperation, id: string): Promise<{
    result: Extract<ReadResult, {
        status: 'ready';
    }>;
    row: PoolRow;
}>;
export declare function unknownRow(operation: PoolOperation, id: string): PoolOperationError;
/**
 * Refuses a row the store was told to distrust: opened with
 * `requireCredentialStamps`, a row whose credential stamp is not bound loads
 * `unbound` (see `PoolRow.unbound`). Called on every locked read of the row
 * an operation acts on, before it calls a provider or writes, so a credential
 * another writer swapped in while the operation waited is refused too.
 */
export declare function requireBound(operation: PoolOperation, row: PoolRow): void;
export declare function refusal(operation: PoolOperation, id: string, kind: PoolOperationError['kind'], message: string, retryable?: boolean): PoolOperationError;
