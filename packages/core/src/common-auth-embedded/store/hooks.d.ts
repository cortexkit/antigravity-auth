import { type PoolOperation } from './errors.js';
/** Refuses a row operation or refresh called from inside a hook. */
export declare function assertNotInsideHook(operation: PoolOperation): void;
/** Namespace writes need only the store locks, not the row lock a hook may retain. */
export declare function assertLimitsWriteAllowed(): void;
/** Codecs may run under store locks even when no asynchronous hook is active. */
export declare function runInsideCodec<T>(fn: () => T): T;
export declare function runInsideHook<T>(operation: PoolOperation, fn: () => Promise<T> | T, storeLocksReleased?: boolean): Promise<T>;
export interface PoolLogger {
    warn(message: string, data?: unknown): void;
}
/**
 * Runs a failure hook. A hook that throws never replaces the failure it was
 * handed: its exception is logged and discarded.
 */
export declare function callFailureHook<E, R extends string | undefined>(operation: PoolOperation, hook: ((rowId: R, error: E) => void | Promise<void>) | undefined, rowId: R, error: E, logger: PoolLogger | undefined): Promise<void>;
