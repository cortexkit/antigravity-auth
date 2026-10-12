export interface QuotaCodec {
    readonly validate: (value: unknown) => boolean;
    readonly merge: (stored: unknown, observation: unknown) => unknown;
}
/**
 * The quota codec the account-pool store (the `/store` subpath) takes when it
 * is opened: `validate` checks a stored per-row quota map and `merge` applies
 * an observation to one, so the store persists the map without interpreting
 * it.
 */
export declare const quotaCodec: QuotaCodec;
