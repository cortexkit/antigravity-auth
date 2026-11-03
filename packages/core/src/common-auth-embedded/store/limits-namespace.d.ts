import type { StoreRuntime } from './runtime.js';
import type { PoolRow } from './schema.js';
/** Row IDs, credential epochs and identities only; mutators never receive credentials. */
export type PoolLimitsRow = Pick<PoolRow, 'id' | 'credentialEpoch' | 'identity'>;
export type PoolLimitsMutator = (envelope: unknown, rows: readonly PoolLimitsRow[]) => unknown | Promise<unknown>;
/** A namespace merge and its check of current row bindings share one locked config snapshot. */
export declare function updatePoolLimitsNamespace(rt: StoreRuntime, mutator: PoolLimitsMutator): Promise<void>;
