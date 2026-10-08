import { type Attribution } from './attribution.js';
import type { PoolOperationError } from './errors.js';
import type { PoolLogger } from './hooks.js';
import { type HoldPoint, type InitializeOutcome, type StoreContext } from './mutate.js';
import { type ProviderStateMutator, type UpdateProviderStateResult } from './provider-state.js';
import { type PullHook } from './pull.js';
import { type ProviderRefresh, type RefreshOptions, type RefreshOutcome } from './refresh.js';
import { type LockEnvironment, type PoolLockOptions, type PoolLockSpec } from './refresh-lock.js';
import { type AddInput, type AddResult, type CredentialWriteInput, type RemoveOptions, type RemoveResult, type ReorderOptions, type ReorderResult, type RowOperationOptions, type RowToggleOptions, type RowTransitionOptions, type RowTransitionResult, type RowWriteOptions } from './rows.js';
import { type PoolCredential, type PoolRow, type ProviderStateCodec, type QuotaCodec, type RotateCredential, type StoredCredential } from './schema.js';
import { type SettingsMutator, type SettingsRead, type UpdateSettingsOptions, type UpdateSettingsResult } from './settings.js';
export interface OpenPoolStoreOptions {
    /** The provider every row of this pool belongs to; keys the provider-wide lock. */
    provider: string;
    configPath: string;
    statePath: string;
    quota: QuotaCodec;
    /**
     * The codec of the provider state kept beside each row's credential (see
     * `ProviderStateCodec`). Without it no row shows a provider state, and
     * every write that would set one refuses (`invalid-input`); writes that
     * leave it alone keep the value on disk as it is, and `replace` clears it.
     */
    providerState?: ProviderStateCodec;
    /**
     * Refuse every credential this store did not stamp (default false, which
     * loads unstamped and mis-stamped credentials as older writers left them).
     * When true, a row whose `stamp` is not `bound` loads `unbound` and is no
     * candidate, and every operation that would use or keep its credential or
     * what was observed about it (`refresh`, quota pulls, `recordQuota`,
     * `recordIdentity`, `rotate`, and an `add` of the same secret or onto the
     * same credential-less row) refuses with `unbound-credential` before any
     * provider call or write, checked again under the locks and at commit.
     * Nothing makes such a row bound except `replace`, which starts a new
     * credential epoch and drops what was observed about the old one.
     * An interrupted add's state-only orphan is recovered only when its stamp
     * binds the stored and incoming material, including a supplied identity and
     * an API key's endpoint/header. Otherwise add refuses `unbound-credential`
     * without writing; `remove(id)` explicitly discards the orphan.
     */
    requireCredentialStamps?: boolean;
    /** Injected clock for leases, refresh stamps and `addedAt`. */
    now?: () => number;
    /**
     * Ordered store-lock list held across every read-modify-write. Defaults to
     * the older writers' `save` lock at the config path, then at the state path.
     */
    storeLocks?: readonly PoolLockSpec[];
    /** Defaults for every lock the store takes (see `POOL_LOCK_DEFAULTS`). */
    lockOptions?: Partial<PoolLockOptions>;
    /** Overrides for the row locks only. */
    rowLockOptions?: Partial<PoolLockOptions>;
    /** The provider-wide lock; defaults to `provider-<provider>` beside the state file. */
    providerLock?: PoolLockSpec;
    /** Quota pull hook, fired without being awaited. */
    pull?: PullHook;
    /** Receives every pull failure, since no caller awaits a pull. */
    onPullFailure?: (rowId: string, error: PoolOperationError) => void | Promise<void>;
    logger?: PoolLogger;
    /** Named write steps, awaited; a test seam for crash and ownership rows. */
    onStep?: StoreContext['onStep'];
    /** Awaitable hold points on the refresh and pull paths; a test seam. */
    hold?: (point: HoldPoint, rowId: string) => void | Promise<void>;
    onLockEvent?: LockEnvironment['onLockEvent'];
    onLockStep?: LockEnvironment['onLockStep'];
}
export type PoolLoad = {
    status: 'ready';
    schemaVersion: number;
    rows: PoolRow[];
} | {
    status: 'pending-migration';
    roster: unknown[];
} | {
    status: 'error';
    file: 'config' | 'state';
    reason: string;
};
export interface PoolStore {
    /** Reads the pool and fires first-reading pulls; never writes a file itself. */
    load(): Promise<PoolLoad>;
    /** Reads the pool without firing anything. */
    read(): Promise<PoolLoad>;
    /**
     * Turns a pending-migration config into an empty pool (the pool key with no
     * row entries) in one locked config write, dropping the named top-level
     * keys and keeping the rest. The start of a plugin's migration; a ready
     * pool is left alone. Failures carry operation `initialize`.
     */
    initialize(input?: {
        dropKeys?: readonly string[];
    }): Promise<{
        status: InitializeOutcome;
    }>;
    /**
     * Adds a row, or completes or rotates the row already holding the id or
     * the secret. A new row starts at credential epoch 1; since 0.8.0 one
     * whose id the pool held before starts one past the highest epoch that id
     * held (see `Attribution`), and an id that held `Number.MAX_SAFE_INTEGER`
     * refuses (`id-removed`) before writing.
     */
    add(input: AddInput, options?: RowOperationOptions): Promise<AddResult>;
    /**
     * Gives a row a new credential and a new credential epoch. Since 0.6.0 the
     * row's provider state is whatever `ProviderStateCodec.onReplace` returns;
     * without that hook it is `input.providerState`, else cleared.
     * Optional `attribution` fences the write on the prior credential under the
     * locks, before any write or replacement hook; see `RowWriteOptions`.
     */
    replace(id: string, credential: PoolCredential, input?: CredentialWriteInput, options?: RowWriteOptions): Promise<{
        id: string;
        credential: StoredCredential;
        credentialEpoch: number;
    }>;
    /**
     * Refreshes the secret a row holds without changing its account or
     * endpoint. Since 0.4.1 an API key may leave out `baseURL` and `authHeader`
     * to keep the row's, and one that gives another is refused
     * (`endpoint-mismatch`) before writing: that is a `replace`.
     * Takes the same optional attribution fence as `replace` (`RowWriteOptions`).
     */
    rotate(id: string, credential: RotateCredential, input?: CredentialWriteInput, options?: RowWriteOptions): Promise<{
        id: string;
        credential: StoredCredential;
    }>;
    /**
     * Changes a row's provider state without touching its credential (since
     * 0.6.0), under the row lock, `extraLocks` and the store locks. Refuses
     * (`attribution`) once the row has moved off the credential epoch or
     * identity in `fence`, and (`unknown-row`) once it is removed.
     */
    updateProviderState(id: string, fence: Attribution, mutator: ProviderStateMutator, options?: RowToggleOptions): Promise<UpdateProviderStateResult>;
    /**
     * Sets `enabled: false` and the entry's `disabledReason`. Takes the row
     * lock, then `extraLocks`, then the store locks (the row lock and
     * `extraLocks` since 0.2.3). Since 0.7.0 it may be fenced on the
     * credential the caller's evidence is about (`attribution`) and carry a
     * provider-state change that lands with it (`providerState`); see
     * `RowTransitionOptions`.
     */
    disable(id: string, reason: string, options?: RowTransitionOptions): Promise<RowTransitionResult>;
    /**
     * Clears `enabled: false` and `disabledReason` (since 0.2.3); refuses with
     * `duplicate-identity` when another enabled OAuth row holds the row's
     * identity. Locks as `disable`, and takes the same options since 0.7.0.
     */
    enable(id: string, options?: RowTransitionOptions): Promise<RowTransitionResult>;
    /**
     * Deletes the roster row, its per-row entry and its state-file credential
     * (since 0.2.3). Locks as `disable`; `protect` can refuse the id.
     */
    remove(id: string, options?: RemoveOptions): Promise<RemoveResult>;
    /**
     * Sets the roster order (since 0.2.4) in one config write. `ids` must name
     * every roster id exactly once; anything else refuses with `invalid-order`
     * and writes nothing. Takes `extraLocks`, then the store locks; no row or
     * provider-wide lock. Roster rows and their entries are left unchanged.
     */
    reorder(ids: readonly string[], options?: ReorderOptions): Promise<ReorderResult>;
    /**
     * The plugin's settings (since 0.2.6): every top-level key of the config
     * file except the pool-owned ones (`POOL_OWNED_KEYS`). Never writes.
     */
    readSettings(): Promise<SettingsRead>;
    /**
     * One locked write of the plugin's settings (since 0.2.6) beside the pool,
     * in the config file. Refuses a result that sets a pool-owned key
     * (`invalid-input`). Takes `extraLocks`, then the store locks.
     */
    updateSettings(mutator: SettingsMutator, options?: UpdateSettingsOptions): Promise<UpdateSettingsResult>;
    /**
     * Records the identity a lookup found for the row's credential. Since
     * 0.3.1 it takes the credential epoch the lookup was issued for, and
     * refuses a lookup that completes after the row was replaced
     * (`attribution`) or a row recorded for another account
     * (`identity-mismatch`).
     */
    recordIdentity(id: string, identity: string, attribution: Pick<Attribution, 'credentialEpoch'>, options?: RowOperationOptions): Promise<{
        id: string;
        disabled: string[];
    }>;
    refresh(id: string, provider: ProviderRefresh, options?: RefreshOptions): Promise<RefreshOutcome>;
    recordQuota(id: string, attribution: Attribution, observation: unknown): Promise<void>;
    /** Fires a pull for a row admission refused for want of a reading. */
    requestReading(id: string): void;
    /** Resolves once every pull fired so far has settled. */
    pullsSettled(): Promise<void>;
}
export declare function openPoolStore(options: OpenPoolStoreOptions): PoolStore;
