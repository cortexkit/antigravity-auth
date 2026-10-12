export { quotaCodec } from './codec.js';
export { formatQuota, NO_LIMITS_REPORTED, NO_QUOTA_READING, QUOTA_STALE_AFTER_MS, quotaTextParts, quotaWindowName, } from './format.js';
export { ALL_SCOPE, DEFAULT_REQUIRED_LABELS, emptyQuotaMap, isQuotaMap, } from './map.js';
export { isQuotaObservation, mergeQuotaObservation, QuotaCodecError, } from './merge.js';
export { budgetExhaustedResetAt, futureResetAt, projectQuota, readsExhausted, } from './projection.js';
