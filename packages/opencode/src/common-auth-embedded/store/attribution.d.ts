import { type StoreRuntime } from './runtime.js';
/**
 * What a pull or refresh captured about its row (named by id alongside) when
 * it was issued. A result applies only while the row with that id still has
 * this credential epoch and this recorded identity; a replaced credential
 * bumps the epoch, so work issued for the old one is discarded.
 *
 * The epoch names one credential lineage of the row: a credential given by
 * `add` or `replace`, through every refresh and `rotate` of it, which keep
 * the epoch. Since 0.8.0 that holds across removal too: a row added under an
 * id the pool held before starts past every epoch that id held (the store
 * records them when it drops a row, in the config file, so every process
 * sees it), so an attribution taken for a removed row is refused once the id
 * is added again, even with the same identity. Writers older than 0.8.0
 * start a re-added id at epoch 1 again, and a writer that does not know the
 * pool can remove and re-add a row without the store seeing it; work
 * attributed across either may still apply to the new credential.
 */
export interface Attribution {
    credentialEpoch: number;
    identity?: string;
}
/**
 * Merges a quota observation into a row's stored map under the store locks,
 * after attribution passes. Needs no row lock, so it is permitted from
 * inside hooks. Clears needs-first-reading on success.
 */
export declare function recordQuota(rt: StoreRuntime, id: string, attribution: Attribution, observation: unknown): Promise<void>;
