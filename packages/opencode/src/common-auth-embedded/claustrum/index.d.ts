import { type ClaustrumClientOptions } from '@cortexkit/claustrum-client';
import type { ClaustrumScopedClient } from './custody.js';
export { ClaustrumCredentialError, type ClaustrumReporterSource, type EnrollmentTokenFile, } from '@cortexkit/claustrum-client';
export { ClaustrumUnreachableError, classifyVaultFailure, VAULT_FAILURE_CLASSES, type VaultFailureClass, } from './availability.js';
export { ClaustrumConsumer, type ClaustrumConsumerOptions, type ClaustrumWatchState, type SendOptions, } from './consumer.js';
export { type AccountIdentitySource, type ClaustrumFamily, type ClaustrumRosterWatch, type ClaustrumRosterWatchOptions, type ClaustrumScopedAttempt, type ClaustrumScopedClient, ClaustrumScopedCustody, type ClaustrumScopedIdentity, decideScopedRetryAfter401, type IdentityParser, isScopedCredentialRotation, KEPT_RECEIPT_MARGIN_MS, type KeptReceiptState, type ScopedRetryReason, SERVING_MARGIN_MS, type SkippedVaultReason, type SkippedVaultRecord, type VaultCredential, type VaultCredentialType, type VaultGrantReach, type VaultGrantTuple, type VaultInventory, } from './custody.js';
export { type ClaustrumEnrollmentClient, type ClaustrumEnrollmentConnection, type ClaustrumEnrollmentDisconnectResult, ClaustrumEnrollmentManager, type ClaustrumEnrollmentPaths, type ClaustrumEnrollmentResetResult, type ClaustrumEnrollmentStatus, classifyEnrollmentError, connectClaustrumEnrollmentClient, disconnectClaustrumEnrollment, type EnrollmentDisposition, enrollmentAuthority, enrollmentName, getClaustrumEnrollmentPaths, hostEnrollmentPaths, RETRYABLE_ENROLLMENT_CODES, readClaustrumEnrollmentStatus, readClaustrumEnrollmentToken, resetClaustrumEnrollmentState, TERMINAL_ENROLLMENT_CODES, } from './enrollment.js';
export { ClaustrumConsumerError, type ClaustrumConsumerFailureKind, type ClaustrumLogger, } from './errors.js';
export { assertHostSlotMatchesMode, assertNotCustodyPlaceholder, CUSTODY_PLACEHOLDER_PREFIX, classifyHostSlot, custodyPlaceholder, custodyPlaceholderKey, type HostSlotContent, isCustodyPlaceholder, isCustodyPlaceholderValue, } from './host-slot.js';
export { acquireInsulaQuotaSource, type InsulaQuotaContext, type InsulaQuotaLookup, type InsulaQuotaMiss, type InsulaQuotaOptions, type InsulaQuotaReading, type InsulaQuotaResult, type InsulaQuotaSource, type InsulaUsageEntry, type InsulaUsageTransport, type InsulaUsageWatch, type InsulaUsageWindow, type InsulaWatchOptions, } from './insula.js';
export { acceptAccount, type DeclinedAccount, declineAccount, isDeclined, } from './interlock.js';
export { drainVaultQuota } from './quota-writer.js';
export { type AccountMapper, acceptVaultRoute, DEFAULT_ROUTE_PREFIX, declineVaultRoute, type MutateVaultRosterOptions, mutateVaultRoster, type ProjectionOptions, projectVaultRoster, type QuotaReceipt, type ReorderVaultRosterOptions, type ReorderVaultRosterResult, readVaultRoster, recordVaultAccountQuota, recordVaultQuota, refreshVaultRoster, reorderVaultRoster, resolveVaultPrimary, type VaultPrimary, type VaultPrimaryBinding, type VaultPrimaryUnavailableReason, type VaultRosterFile, type VaultRosterLockContext, type VaultRosterRow, vaultRoutingRows, } from './roster.js';
export { type ChangeNotice, ChangeNoticeReader, RESUBSCRIBE_BACKOFF_MS, SAFETY_POLL_MS, ScopedRosterWatch, type ScopedRosterWatchOptions, type ScopedWatchEnd, type ScopedWatchHandle, type ScopedWatchNoticeShape, type ScopedWatchSource, WATCH_RETRY_MS, type WatchMode, } from './watch.js';
/**
 * Connect the client that lists and fetches this consumer's vault credentials
 * on the request path. `connectionFile` is required: this library
 * reads no environment, so the plugin resolves the vault's connection file.
 */
export declare function connectClaustrumScopedClient(options: ClaustrumClientOptions & {
    connectionFile: string;
}): Promise<ClaustrumScopedClient>;
