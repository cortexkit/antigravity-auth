import { PoolOperationError } from './errors.js';
import type { PoolLogger } from './hooks.js';
import { type PullReason, type StoreRuntime } from './runtime.js';
import type { StoredCredential } from './schema.js';
/** What a pull is issued with: the credential and its attribution tuple. */
export interface PullRequest {
    id: string;
    credential: StoredCredential;
    credentialEpoch: number;
    identity?: string;
    reason: PullReason;
}
export type PullHook = (request: PullRequest) => Promise<unknown>;
/**
 * Fires quota pulls without ever making a caller wait for one. A pull first
 * gives a row without a per-row entry its entry at epoch 1 (its own locked
 * config write), then captures the credential and the attribution tuple in
 * one locked read, requests the observation, and records it only if
 * attribution still holds. Failures go to the store's pull failure hook.
 */
export declare class PullScheduler {
    private readonly rt;
    private readonly hook;
    private readonly onFailure;
    /** Rows a load-time pull has fired for in this process. */
    private readonly firedAtLoad;
    private readonly logger;
    private readonly inflight;
    constructor(rt: () => StoreRuntime, hook: PullHook | undefined, onFailure: ((rowId: string, error: PoolOperationError) => void | Promise<void>) | undefined, 
    /** Rows a load-time pull has fired for in this process. */
    firedAtLoad: Set<string>, logger: PoolLogger | undefined);
    fire(id: string, reason: PullReason): void;
    /** Resolves once every pull fired so far has settled. */
    settled(): Promise<void>;
    private run;
}
