import { type QuotaCommitTimer } from '../quota/commit-interval.js';
import { type QuotaObservation } from '../quota/index.js';
import { type QuotaReceipt, type VaultRosterFile } from './roster.js';
export type VaultQuotaPublication = {
    routeId: string;
    accountIdentity?: string;
    receipt?: QuotaReceipt;
    observation: QuotaObservation;
};
type Listener = (publication: VaultQuotaPublication) => void;
/** Retain the shared writer; the last consumer's close drains it. */
export declare function retainVaultQuotaWriter(path: string, listener: Listener, clock?: QuotaCommitTimer): () => Promise<void>;
/** Enqueue without filesystem work; each quota field retains its own receipt fence. */
export declare function enqueueVaultQuota(path: string, publication: VaultQuotaPublication): Promise<boolean>;
/** Overlay uncommitted observations when a consumer reloads the durable roster. */
export declare function pendingVaultQuota(path: string, roster: VaultRosterFile | undefined): VaultRosterFile | undefined;
/**
 * Whether this process holds quota readings for `path` that no commit of the
 * durable roster has written yet, so a reader of the file alone is not seeing
 * everything this process would publish.
 */
export declare function hasPendingVaultQuota(path: string): boolean;
/** Wait at most timeoutMs for detached publication; shutdown loss is acceptable. */
export declare function drainVaultQuota(path: string, timeoutMs?: number): Promise<void>;
export {};
