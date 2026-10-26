export declare function isLostMarkerRaceError(error: unknown): boolean;
export interface LockLoss {
    readonly reason: 'taken-over' | 'expired' | 'unreadable' | 'renewal-failed' | 'marker-lost';
    readonly expectedOwnerId: string;
    readonly observedOwnerId?: string;
    readonly observedExpiresAt?: number;
}
export interface RefreshFileLock {
    readonly ownerId: string;
    assertOwned(): Promise<void>;
    release(): Promise<void>;
    /** Resolves once on detected loss; remains pending after an owner's release. */
    whenLost(): Promise<LockLoss>;
    hasLost(): boolean;
}
type RefreshFileLockOptions = {
    name: string;
    ttlMs: number;
    /**
     * File the lock is named after. Required: the lock and the write it guards
     * must target the same file, and a default resolved in here could only ever
     * be one host's path.
     */
    path: string;
    renew?: boolean;
    renewIntervalMs?: number;
    /** Notifies a live-owner refusal without awaiting; observer failures are ignored. */
    onContended?: () => void;
    /** Synchronous, never awaited; throws and returned promise/thenable rejections are isolated. */
    onRenewalTimer?: (event: 'scheduled' | 'cancelled') => void;
    onStep?: (step: 'stale-marker-stat' | 'stale-marker-claimed' | 'stale-lock-observed' | 'lease-contention-read-ready' | 'lock-read-ready' | 'lock-missing' | 'stale-lock-confirmed' | 'stale-lock-removed' | 'stale-lock-recreated' | 'eviction-marker-acquired' | 'renewal-owner-confirmed' | 'renewal-marker-unavailable' | 'renewal-write-fenced' | 'renewal-write-ready' | 'renewal-write-finished' | 'relinquish-read' | 'renewal-finished' | 'release-owner-confirmed') => void | Promise<void>;
};
/** Filesystem leases share wall time across all callers and processes. */
export declare function acquireRefreshFileLock(options: RefreshFileLockOptions): Promise<RefreshFileLock | null>;
/** @internal Clock seam for lease tests; not exported by the package's fs entry point. */
export declare function acquireRefreshFileLockWithClock(options: RefreshFileLockOptions & {
    now?: () => number;
}): Promise<RefreshFileLock | null>;
export {};
