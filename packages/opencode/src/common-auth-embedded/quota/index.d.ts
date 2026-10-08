export type { QuotaCodec } from './codec.js';
export { quotaCodec } from './codec.js';
export type { CreditBudgetCleared, CreditBudgetEntry, CreditBudgetReading, QuotaAbsentEntry, QuotaEntry, QuotaMap, QuotaReadingEntry, QuotaRetiredEntry, } from './map.js';
export { ALL_SCOPE, DEFAULT_REQUIRED_LABELS, emptyQuotaMap, isQuotaMap, } from './map.js';
export type { ObservedBudget, ObservedPair, ObservedReading, QuotaObservation, } from './merge.js';
export { isQuotaObservation, mergeQuotaObservation, QuotaCodecError, } from './merge.js';
export type { ExhaustionReset, ProjectedBudget, ProjectedLimit, ProjectedQuota, } from './projection.js';
export { budgetExhaustedResetAt, futureResetAt, projectQuota, readsExhausted, } from './projection.js';
