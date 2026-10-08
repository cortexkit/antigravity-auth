export declare function lockPathFor(target: string, name: string): string;
export declare class LockContentionError extends Error {
    readonly details: {
        target: string;
        name: string;
        timeoutMs: number;
    };
    constructor(details: {
        target: string;
        name: string;
        timeoutMs: number;
    });
}
export interface LockOwnershipDetails {
    target: string;
    name: string;
    expectedOwnerId?: string;
    observedOwnerId?: string;
    observedExpiresAt?: number;
}
export declare class LockOwnershipError extends Error {
    readonly details: LockOwnershipDetails;
    constructor(details: LockOwnershipDetails);
}
export interface LockOptions {
    name: string;
    ttlMs: number;
    timeoutMs: number;
    renew?: boolean;
}
export declare function withLock<T>(target: string, options: LockOptions, fn: (lock: {
    assertOwned(): Promise<void>;
}) => Promise<T>): Promise<T>;
