import type { PoolLockSpec } from './refresh-lock.js';
import { type FailureHook } from './rows.js';
import { type StoreRuntime } from './runtime.js';
import { type OAuthCredential, type PoolRow, type StoredCredential } from './schema.js';
/** What the injected provider refresh function returns. */
export interface ProviderRefreshResult {
    access: string;
    refresh: string;
    expires: number;
    expiresIn?: number;
    /** The account's wire identity, when the provider reports one. */
    identity?: string;
    /**
     * Provider state that changes with the new token (needs the store's
     * provider-state codec). It is merged with the row's value on disk
     * (`ProviderStateCodec.merge`) and written in the same state write as the
     * rotated credential, under the same commit fence. Left out, the row keeps
     * its value.
     */
    providerState?: unknown;
}
export type ProviderRefresh = (credential: OAuthCredential & {
    lastRefreshedAt?: number;
}, row: PoolRow) => Promise<ProviderRefreshResult>;
export interface RefreshOptions {
    /** The one provider-wide lock serialising every provider call. */
    providerLock?: PoolLockSpec;
    /** Taken after the provider-wide lock in this order, released in reverse. */
    extraLocks?: readonly PoolLockSpec[];
    /**
     * Awaited once an ordinary rotation is persisted and the store locks released.
     * Never called for `identity-contradicted`: its credential must not propagate
     * as the row's recorded account.
     */
    onPersisted?: (rowId: string, credential: StoredCredential) => void | Promise<void>;
    onFailure?: FailureHook;
    /**
     * Awaited before any lock is taken, on the locked re-read, and at commit
     * time under the store locks; a reason refuses the refresh there, leaving
     * the stored credential untouched and discarding any rotated material.
     */
    refuse?: (row: PoolRow) => string | undefined | Promise<string | undefined>;
}
export type RefreshOutcome = {
    status: 'rotated';
    rowId: string;
    credential: StoredCredential;
    identity?: string;
}
/**
 * The provider's successor credential is stored bound to expectedIdentity,
 * not returnedIdentity. The row stays disabled until the adapter supplies
 * an identity-validated replacement credential through replace.
 */
 | {
    status: 'identity-contradicted';
    rowId: string;
    expectedIdentity: string;
    returnedIdentity: string;
    credential: StoredCredential;
} | {
    status: 'refused';
    rowId: string;
    reason: string;
};
/**
 * Refreshes one OAuth row. Locks are taken in the fixed order row lock,
 * provider-wide lock, extra locks, and the store locks only around the
 * capture and the commit; ownership of every held lease is asserted after
 * each wait, immediately before the provider call and before each write.
 */
export declare function refreshRow(rt: StoreRuntime, id: string, provider: ProviderRefresh, options?: RefreshOptions): Promise<RefreshOutcome>;
