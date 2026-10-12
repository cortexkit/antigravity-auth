import type { Attribution } from './attribution.js';
import { PoolOperationError } from './errors.js';
import { type Transaction } from './mutate.js';
import { type ProviderStateWrite, type RowTransitionMutator, type UpdateProviderStateResult } from './provider-state.js';
import type { PoolLockSpec } from './refresh-lock.js';
import { type StoreRuntime } from './runtime.js';
import { type CredentialBinding, type PoolCredential, type PoolRow, type RotateCredential, type StagedStamp, type StoredCredential } from './schema.js';
import { type StampedTransition } from './torn.js';
export type FailureHook = (rowId: string, error: PoolOperationError) => void | Promise<void>;
export interface RowOperationOptions {
    /** Called once, awaited, on every non-success path, before locks release. */
    onFailure?: FailureHook;
    /** The provider-wide lock, when an operation may change identity keying. */
    providerLock?: PoolLockSpec;
    /**
     * Further locks taken after the row lock and the provider-wide lock, in
     * this order, before the store locks: the same place `refresh` takes its
     * extra locks, so a caller holding legacy locks around a row write and a
     * refresh of that row acquire them in one order and cannot deadlock.
     */
    extraLocks?: readonly PoolLockSpec[];
}
export interface RowProjection {
    id: string;
    type: 'oauth' | 'api';
    label?: string;
    enabled: boolean;
    disabledReason?: string;
    identity?: string;
    credentialEpoch?: number;
    stamp?: PoolRow['stamp'];
    staged?: {
        reservation: string;
    };
    torn?: true;
    invalid?: 'roster' | 'entry';
}
export interface ProtectView {
    id: string;
    row?: RowProjection;
    rows: RowProjection[];
    config: Readonly<Record<string, unknown>>;
}
export type ProtectFn = (view: ProtectView) => string | undefined | Promise<string | undefined>;
export interface AddOptions extends RowOperationOptions {
    onExisting?: 'rotate' | 'refuse' | 'stage-duplicate';
    protect?: ProtectFn;
}
export declare function protectIn(tx: Transaction, id: string, protect?: ProtectFn): Promise<void>;
/** Options of `replace` and `rotate`. Without `attribution` a call behaves as before. */
export interface RowWriteOptions extends RowOperationOptions {
    /**
     * The credential epoch and recorded identity the caller read the row at
     * when it decided on this write; an identity left out means the row had
     * none. Compared exactly, under the row and store locks, before any write
     * or replacement hook, including the completion of an interrupted replace.
     * The call is refused (`attribution`, retryable, nothing written) once the
     * row holds another epoch or identity, so a write decided on an older
     * credential never overwrites the one that replaced it. `disable`, `enable`,
     * `recordQuota` and `updateProviderState` take the same fence.
     */
    attribution?: Attribution;
}
/**
 * Options of `disable`, `enable` and `remove`. The provider-wide lock guards
 * changes to the recorded identity a row lock is named by; none of these
 * three records an identity, so none takes it. The extra locks are taken
 * where every other row write takes them, after the row lock and before the
 * store locks.
 */
export type RowToggleOptions = Pick<RowOperationOptions, 'onFailure' | 'extraLocks'>;
/** What a `remove` protect predicate is shown, read under every lock. */
export interface RemoveView {
    /**
     * The row as loaded; undefined when the roster no longer holds the id and
     * only its state-file entry is left (an add or removal interrupted between writes).
     */
    row: PoolRow | undefined;
    /** The config file as read under the store locks. */
    config: Readonly<Record<string, unknown>>;
    /** The state file as read under the store locks. */
    state: Readonly<Record<string, unknown>>;
}
export interface RemoveOptions extends RowToggleOptions {
    /** Exact reservation required to remove a row that is still staged. */
    staged?: {
        reservation: string;
    };
    /**
     * The credential the removal was decided for (since 0.11.7). Checked under
     * every lock, before `protect` and before anything is written or repaired:
     * - a roster row must be bound to its credential stamp, not torn, and hold
     *   exactly this epoch and recorded identity (absence included);
     * - an orphan (only a state-file entry left, by a removal or add
     *   interrupted between its writes) must carry a stamp this store can bind
     *   to the credential beside it, and that stamp must name exactly this
     *   epoch and identity.
     * Epochs only grow per id (a removal records the dropped epoch, and a later
     * add of the id starts past it), so an orphan an interrupted later add
     * left under the same id never matches the epoch of the row the caller
     * meant to remove. A mismatch refuses with kind `attribution`, an orphan
     * or row with no bindable stamp with kind `unbound-credential`; both leave
     * the files byte for byte unchanged. Without it, `remove` drops whatever
     * the id holds, as before.
     *
     * The epoch survives a refresh or `rotate`, so it names a credential
     * lineage, not one token: a caller that must remove only an exact token
     * still checks the loaded credential in `protect`.
     */
    attribution?: Attribution;
    /**
     * Awaited under every lock before anything is written; a reason refuses
     * the removal (kind `row-protected`) with both files unchanged. The store
     * keeps no record of a plugin's in-flight work, so this is where a plugin
     * refuses an id it reserves or one its own pending-operation record (kept
     * in the config or state file) still names: reading that record from the
     * locked files here cannot race a writer that holds the store locks.
     */
    protect?: (id: string, view: RemoveView) => string | undefined | Promise<string | undefined>;
}
export type RemoveResult = {
    id: string;
    /**
     * `removed`: the roster row was dropped (and its state entry, if any).
     * `completed`: only a state-file entry was left, by a removal interrupted
     * between its config and state writes or an add interrupted before its
     * config write, and it is now dropped.
     */
    outcome: 'removed' | 'completed';
};
/**
 * Options of `reorder`. It names no row, so its failure hook is handed only
 * the failure; it takes no row lock and no provider-wide lock, so the extra
 * locks are taken first, then the store locks.
 */
export interface ReorderOptions {
    /** Called once, awaited, on every non-success path, before the extra locks release. */
    onFailure?: (error: PoolOperationError) => void | Promise<void>;
    /** Locks taken, in this order, before the store locks. */
    extraLocks?: readonly PoolLockSpec[];
}
export type ReorderResult = {
    /** The roster order now on disk. */
    ids: string[];
    /** `unchanged` when the roster was already in this order; nothing was written. */
    outcome: 'reordered' | 'unchanged';
};
export interface AddInput {
    id: string;
    credential: PoolCredential;
    identity?: string;
    label?: string;
    disabled?: {
        reason: string;
    };
    stage?: {
        reservation: string;
    };
    /**
     * Provider state for the credential, written in the same state write as
     * the credential (needs the store's provider-state codec). On an `add`
     * that rotates a row already holding this secret it is merged with the
     * row's value (`ProviderStateCodec.merge`); left out, that row keeps its
     * value.
     */
    providerState?: unknown;
}
/** What `replace` and `rotate` take beside the credential. */
export interface CredentialWriteInput {
    identity?: string;
    /**
     * Provider state written in the same state write as the credential. For
     * `rotate` it is merged with the row's value; left out, the row keeps its
     * value. For `replace` see `ProviderStateCodec.onReplace`.
     */
    providerState?: unknown;
}
export type AddResult = {
    /** The row holding the credential; an existing row's id on a re-add. */
    id: string;
    outcome: 'added' | 'added-disabled' | 'completed' | 'rotated' | 'exists';
    credential: StoredCredential;
    credentialEpoch: number;
};
/**
 * Build the credential and its state entry without writing. The stamp records
 * the credential's epoch, identity and API endpoint so readers can verify that
 * they belong together. A replacement records the new epoch and account; a
 * rotation keeps the current epoch, account and quota. Pending writes are read
 * as completed when choosing those fields, even while disk config is behind.
 * Endpoint checks and provider-state encoding finish here, before any repair.
 */
declare function planRotationIn(rt: StoreRuntime, tx: Transaction, id: string, given: RotateCredential, extra?: {
    stamp?: number;
    clearErrors?: boolean;
    binding?: CredentialBinding;
    identity?: string;
    providerState?: ProviderStateWrite;
    /** Config transition persisted with the successor credential for crash recovery. */
    transition?: StampedTransition;
    staged?: StagedStamp;
}): {
    stored: StoredCredential;
    account: Record<string, unknown>;
};
/** Validate the endpoint and encode provider state and its stamp before committing state. */
export declare function rotateIn(rt: StoreRuntime, tx: Transaction, id: string, given: RotateCredential, extra?: Parameters<typeof planRotationIn>[4]): Promise<StoredCredential>;
export declare function validateAttribution(operation: PoolOperationError['operation'], id: string, fence: Attribution | undefined): void;
/** Exact recorded identity, including absence, is part of a credential fence. */
export declare function assertRowAttribution(operation: PoolOperationError['operation'], id: string, row: PoolRow | undefined, fence: Attribution): void;
export declare function addRow(rt: StoreRuntime, input: AddInput, options?: AddOptions): Promise<AddResult>;
export declare function replaceRow(rt: StoreRuntime, id: string, credential: PoolCredential, input?: CredentialWriteInput, options?: RowWriteOptions): Promise<{
    id: string;
    credential: StoredCredential;
    credentialEpoch: number;
}>;
export declare function rotateRow(rt: StoreRuntime, id: string, credential: RotateCredential, input?: CredentialWriteInput, options?: RowWriteOptions): Promise<{
    id: string;
    credential: StoredCredential;
}>;
/**
 * Options of `disable` and `enable`. A call that passes neither
 * `attribution` nor `providerState` behaves exactly as it did before 0.7.0.
 */
export interface RowTransitionOptions extends RowToggleOptions {
    protect?: ProtectFn;
    /**
     * The credential epoch and recorded identity the caller's evidence for the
     * transition was obtained under (as `recordQuota`'s attribution: an
     * identity left out means the row had none). The call is refused
     * (`attribution`, retryable, nothing written) once the row holds another
     * epoch or identity, so a provider's late answer about a replaced
     * credential never disables, or switches back on, the row now holding its
     * successor.
     */
    attribution?: Attribution;
    /**
     * A provider-state change made in the same transaction as the transition,
     * under the rules of `updateProviderState` (codec validation, the stamp
     * rebound to the value, `unbound-credential` for a row no stamp of this
     * store can bind it to); it requires `attribution`. The value and the
     * enabled flag land together: no reader, and no crash at any write point,
     * shows one without the other. Returning `DECLINE_TRANSITION` declines the
     * whole call and writes nothing.
     */
    providerState?: RowTransitionMutator;
}
export interface RowTransitionResult {
    id: string;
    /** The provider-state mutator declined: nothing was written. */
    declined?: true;
    /**
     * Set when a provider-state mutator ran and did not decline: what it did
     * to the value, as `updateProviderState` reports it.
     */
    providerStateOutcome?: UpdateProviderStateResult['outcome'];
    /** The provider state the row now holds, when a mutator ran and left one. */
    providerState?: unknown;
}
/**
 * Marks a row disabled with a reason. See `RowTransitionOptions` for the
 * attributed form, which may change the provider state with it.
 */
export declare function disableRow(rt: StoreRuntime, id: string, reason: string, options?: RowTransitionOptions): Promise<RowTransitionResult>;
/**
 * Clears a row's `enabled: false` and its `disabledReason` in one config
 * write. An identity-contradicted row refuses with `identity-contradicted`
 * until the caller validates a replacement's identity and supplies it to replace.
 * An OAuth row whose recorded identity another enabled OAuth row holds
 * stays disabled and the call refuses (`duplicate-identity`): the same rule
 * that makes `add` store such a row disabled. Enabling a row that is already
 * enabled writes nothing. See `RowTransitionOptions` for the attributed
 * form, which may change the provider state with it.
 */
export declare function enableRow(rt: StoreRuntime, id: string, options?: RowTransitionOptions): Promise<RowTransitionResult>;
/**
 * Deletes a row: its roster row and per-row entry (quota, epoch; the identity
 * lives in the roster row) in one config write, then its credential and
 * runtime fields in one state write. The config goes first, so a crash
 * between the two leaves a row every reader already sees as removed, with
 * only an orphaned state entry that no reader loads; calling `remove` again
 * drops that entry (`completed`). As with every id the store drops, the id is
 * not reused by `add` in this process, and the config write records the
 * row's credential epoch, so an `add` of the id in any other process starts
 * past it (see `nextAddEpochIn`).
 */
export declare function removeRow(rt: StoreRuntime, id: string, options?: RemoveOptions): Promise<RemoveResult>;
/** An attributed removal of a roster row: bound, not torn, same epoch and identity. */
export declare function assertBoundRowAttribution(id: string, row: PoolRow, fence: Attribution, operation?: PoolOperationError['operation']): void;
/**
 * Sets the roster order in one config write. `ids` must name every roster id
 * exactly once; anything else refuses (`invalid-order`) before writing. The
 * roster rows, the per-row entries and the state file are left as they are:
 * only the order of the legacy `accounts` array changes, which older readers
 * load as is. It takes the extra locks, then the store locks, and no row or
 * provider-wide lock, since no row's credential, identity or quota changes.
 * An order equal to the current one writes nothing.
 */
export declare function reorderRows(rt: StoreRuntime, ids: readonly string[], options?: ReorderOptions): Promise<ReorderResult>;
/**
 * Records the wire identity an identity lookup found for a row's credential.
 * `attribution` is the credential epoch the lookup was issued for (a row
 * without an entry is at epoch 1): a lookup that completes after the row was
 * replaced is refused (`attribution`), as a quota reading would be, so the
 * first credential's account is never recorded on the second credential. A
 * row already recorded for another account refuses (`identity-mismatch`):
 * that is a replacement, not something learnt about the same credential.
 */
export declare function recordRowIdentity(rt: StoreRuntime, id: string, identity: string, attribution: Pick<Attribution, 'credentialEpoch'>, options?: RowOperationOptions): Promise<{
    id: string;
    disabled: string[];
}>;
export {};
