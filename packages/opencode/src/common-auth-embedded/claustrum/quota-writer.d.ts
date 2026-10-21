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
export declare function retainVaultQuotaWriter(path: string, listener: Listener): () => Promise<void>;
/** Enqueue without filesystem work; each quota field retains its own receipt fence. */
export declare function enqueueVaultQuota(path: string, publication: VaultQuotaPublication): Promise<boolean>;
/** Overlay uncommitted observations when a consumer reloads the durable roster. */
export declare function pendingVaultQuota(path: string, roster: VaultRosterFile | undefined): VaultRosterFile | undefined;
/** Wait at most timeoutMs for detached publication; shutdown loss is acceptable. */
export declare function drainVaultQuota(path: string, timeoutMs?: number): Promise<void>;
export {};
