export { quotaCodec } from './codec.js';
export { formatQuota, isQuotaStale, NO_LIMITS_REPORTED, NO_QUOTA_READING, QUOTA_STALE_AFTER_MS, quotaCreditsText, quotaTextParts, quotaWindowName, quotaWindowParts, } from './format.js';
export { ALL_SCOPE, DEFAULT_REQUIRED_LABELS, decodeQuotaMap, emptyQuotaMap, isQuotaCredits, isQuotaMap, } from './map.js';
export { isQuotaObservation, mergeQuotaObservation, QuotaCodecError, } from './merge.js';
export { budgetExhaustedResetAt, futureResetAt, projectQuota, readsExhausted, } from './projection.js';
