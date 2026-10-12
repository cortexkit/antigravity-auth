import type { Attribution } from './attribution.js';
import type { PoolLockSpec } from './refresh-lock.js';
import { type FailureHook, type ProtectFn } from './rows.js';
import { type StoreRuntime } from './runtime.js';
export interface PublishPlan {
    operationId: string;
    remove: Array<{
        id: string;
        attribution: Attribution;
        fingerprint?: string;
    }>;
    finalize: Array<{
        id: string;
        attribution: Attribution;
        reservation: string;
        enabled: boolean;
        disabledReason?: string;
    }>;
    order: string[];
}
export interface PublicationReceipt {
    operationId: string;
    planDigest: string;
    phase: 'committed' | 'cleaned';
    removed: Array<{
        id: string;
        credentialEpoch: number;
    }>;
    finalized: Array<{
        id: string;
        credentialEpoch: number;
        reservation: string;
        enabled: boolean;
    }>;
}
export interface PublishOptions {
    protect?: ProtectFn;
    extraLocks?: PoolLockSpec[];
    providerLock?: PoolLockSpec;
    onFailure?: FailureHook;
}
export interface PublishResult {
    outcome: 'published' | 'cleaned' | 'already-cleaned';
    receipt: PublicationReceipt;
}
export declare function publication(rt: StoreRuntime, operationId: string): Promise<PublicationReceipt | undefined>;
export declare function publishRoster(rt: StoreRuntime, plan: PublishPlan, options?: PublishOptions): Promise<PublishResult>;
