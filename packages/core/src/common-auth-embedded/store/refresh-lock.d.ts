import { acquireRefreshFileLock } from '../fs/refresh-file-lock.js';
type LockStep = NonNullable<Parameters<typeof acquireRefreshFileLock>[0]['onStep']> extends (step: infer S) => unknown ? S : never;
/** Tuning shared by every lock the store takes; each field is overridable. */
export interface PoolLockOptions {
    ttlMs: number;
    timeoutMs: number;
    retryMs: number;
    renew: boolean;
    renewIntervalMs?: number;
}
/** A lock: the (name, path) pair naming its file plus optional tuning. */
export interface PoolLockSpec extends Partial<PoolLockOptions> {
    name: string;
    path: string;
}
/**
 * Store lock defaults: a 15 000 ms bounded wait retried every 50 ms plus
 * jitter, and a renewed 10 000 ms lease.
 */
export declare const POOL_LOCK_DEFAULTS: Readonly<PoolLockOptions>;
export type LockEvent = {
    type: 'acquired' | 'released' | 'contended';
    name: string;
    path: string;
};
export interface LockEnvironment {
    now: () => number;
    onLockEvent?: (event: LockEvent) => void;
    onLockStep?: (lock: {
        name: string;
        path: string;
    }, step: LockStep) => void | Promise<void>;
}
export interface HeldLock {
    readonly name: string;
    readonly path: string;
    assertOwned(): Promise<void>;
    release(): Promise<void>;
}
/**
 * Takes one lock, retrying while a live holder has it until `timeoutMs` has
 * passed on the real clock, then throws `LockContentionError`. The lease is
 * asserted as owned once acquired, so a caller never proceeds on a lease that
 * expired during the wait.
 */
export declare function acquirePoolLock(spec: PoolLockSpec, defaults: PoolLockOptions, env: LockEnvironment): Promise<HeldLock>;
/**
 * Locks taken in order and released in reverse. Every acquisition re-asserts
 * the leases already held, because a wait is exactly when an earlier lease
 * can expire unnoticed.
 */
export declare class LockStack {
    private readonly defaults;
    private readonly env;
    readonly held: HeldLock[];
    constructor(defaults: PoolLockOptions, env: LockEnvironment);
    acquire(spec: PoolLockSpec): Promise<HeldLock>;
    assertAll(): Promise<void>;
    /** Releases every lock taken after `mark` (a length of `held`), newest first. */
    releaseTo(mark: number): Promise<void>;
    releaseAll(): Promise<void>;
}
export {};
