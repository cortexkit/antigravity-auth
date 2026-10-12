import type { Attribution } from './attribution.js';
import type { PoolOperation } from './errors.js';
import { type Transaction } from './mutate.js';
import type { RowToggleOptions } from './rows.js';
import { type StoreRuntime } from './runtime.js';
import { type PoolRow, type ProviderStateCodec } from './schema.js';
/**
 * What a credential write does to the provider state beside it: `keep`
 * leaves the value on disk as it is (bound by the new stamp only if the old
 * stamp bound it to the same row, epoch and identity), `set` stores a value
 * the codec accepted, and `clear` deletes it.
 */
export type ProviderStateWrite = {
    kind: 'keep';
} | {
    kind: 'set';
    value: unknown;
} | {
    kind: 'clear';
};
/**
 * A provider state as the store will store it: a JSON round trip of it (so
 * its digest is the same once read back from disk), accepted by the codec.
 * Refused before anything is written when the store has no codec, the value
 * is not JSON, or the codec rejects it.
 */
export declare function acceptProviderState(codec: ProviderStateCodec | undefined, operation: PoolOperation, id: string, value: unknown, what?: string): unknown;
/**
 * The write for a value a credential write brings (`add` of a secret the
 * pool holds, `rotate`, a refresh): merged with the row's value on disk by
 * the codec's `merge` when both exist, else the incoming value as is.
 */
export declare function mergedProviderState(codec: ProviderStateCodec | undefined, operation: PoolOperation, id: string, onDisk: unknown, incoming: unknown): ProviderStateWrite;
/**
 * The provider state a replace leaves on the row, decided before anything is
 * written: whatever the codec's `onReplace` returns (undefined clears it), or
 * without that hook the value handed to `replace`, else nothing. The old
 * credential's value is never kept by default: it describes the account the
 * replaced credential belonged to.
 */
export declare function replacementProviderState(codec: ProviderStateCodec | undefined, row: PoolRow, credentialEpoch: number, identity: string | undefined, incoming: unknown): ProviderStateWrite;
/**
 * The provider-state digest the stamp of a credential write carries, and the
 * state-file fields it changes. `set` binds the new value; `keep` carries the
 * old stamp's digest forward only when that stamp bound it to this row as it
 * stood before the write (same credential lineage, the epoch being written,
 * the identity recorded before the write); `clear` binds nothing.
 */
export declare function providerStateCoverage(codec: ProviderStateCodec | undefined, write: ProviderStateWrite, prior: Record<string, unknown> | undefined, priorRow: PoolRow | undefined, credentialEpoch: number): string | undefined;
/**
 * Receives a private copy of the row's provider state (undefined when the row
 * shows none) and the row as loaded under the locks, and returns the next
 * provider state; returning undefined clears it, so a mutator that means to
 * keep the value returns it. It runs under the row lock and the store locks,
 * so it must not call back into the store (`PoolReentryError`).
 */
export type ProviderStateMutator = (current: unknown | undefined, row: PoolRow) => unknown | Promise<unknown>;
export type UpdateProviderStateResult = {
    id: string;
    /** The provider state now on disk; absent when the row has none. */
    providerState?: unknown;
    /**
     * `unchanged`: the mutator returned what the row already shows (or cleared
     * a row that holds none); nothing was written.
     */
    outcome: 'updated' | 'cleared' | 'unchanged';
};
/**
 * Changes a row's provider state without touching its credential, in one
 * state-file write under the row lock, the caller's extra locks and the
 * store locks. `fence` is what the caller read the row at: the write is
 * refused (`attribution`, retryable) when the row has since moved to another
 * credential epoch or recorded identity, and (`unknown-row`) once it is
 * removed, so a writer that read the row before a replace or a removal never
 * lands its value on the new credential or brings a removed row's state back.
 *
 * The value is bound by the stamp already beside the credential. When its
 * credential-bound part is unchanged the stamp is left byte for byte as it
 * is; otherwise only the stamp's provider-state digest changes, so the
 * credential's stamp status never moves. With `requireCredentialStamps`, an
 * unbound row refuses (`unbound-credential`) as every other strict path
 * does. Without it, a row whose stamp was not written by this store with this
 * credential at the row's epoch and identity refuses the same way: no stamp
 * could bind the value, so no reader would ever show it. A `rotate` or
 * `replace` stamps such a row.
 */
export declare function updateProviderStateRow(rt: StoreRuntime, id: string, fence: Attribution, mutator: ProviderStateMutator, options?: RowToggleOptions): Promise<UpdateProviderStateResult>;
/**
 * Returned by the provider-state mutator of an attributed `disable` or
 * `enable` to decline the whole transition: nothing is written, neither the
 * provider state nor the row's enabled flag, and the call resolves with
 * `declined: true`. A mutator declines when the state it is shown is newer
 * than what its caller saw, such as an eligibility recorded after the
 * request whose refusal is being acted on. It is a value of its own because
 * `undefined` already means "clear the provider state". `Symbol.for` keeps it
 * equal across two copies of this module loaded in one process.
 */
export declare const DECLINE_TRANSITION: unique symbol;
/**
 * The provider-state mutator of an attributed `disable` or `enable`: as
 * `ProviderStateMutator`, and it may also return `DECLINE_TRANSITION`.
 */
export type RowTransitionMutator = (current: unknown | undefined, row: PoolRow) => unknown | typeof DECLINE_TRANSITION | Promise<unknown | typeof DECLINE_TRANSITION>;
/**
 * What a provider-state mutator asks of a row, worked out under the locks
 * before anything is written. `changed` carries the row's whole next
 * state-file account entry (the value, and the stamp rebound to it when its
 * credential-bound part moved); `value` is the next value, absent when it is
 * cleared.
 */
export type ProviderStatePlan = {
    kind: 'declined';
} | {
    kind: 'unchanged';
    value?: unknown;
} | {
    kind: 'changed';
    value?: unknown;
    account: Record<string, unknown>;
};
/**
 * Runs a provider-state mutator for a row loaded under every lock and
 * already checked by the caller (present, valid, inside its attribution
 * fence), and plans the write. Refuses (`no-credential`) a row holding no
 * credential, and (`unbound-credential`) one whose credential carries no
 * stamp of this store at the row's epoch and identity: no stamp could bind
 * the value, so no reader would ever show it. `DECLINE_TRANSITION` is
 * honoured only when `declinable` is set; elsewhere it is not JSON and is
 * refused as such.
 */
export declare function planProviderStateIn(tx: Transaction, codec: ProviderStateCodec, operation: PoolOperation, row: PoolRow, mutator: ProviderStateMutator | RowTransitionMutator, declinable?: boolean): Promise<ProviderStatePlan>;
