import { isQuotaMap } from './map.js';
import { mergeQuotaObservation } from './merge.js';
/**
 * The quota codec the account-pool store (the `/store` subpath) takes when it
 * is opened: `validate` checks a stored per-row quota map and `merge` applies
 * an observation to one, so the store persists the map without interpreting
 * it.
 */
export const quotaCodec = Object.freeze({
    validate: isQuotaMap,
    merge: mergeQuotaObservation,
});
