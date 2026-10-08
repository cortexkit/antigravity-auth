import { type ClaustrumClientOptions } from '@cortexkit/claustrum-client';
import type { ClaustrumScopedClient } from './custody.js';
export { ClaustrumCredentialError, type ClaustrumReporterSource, type EnrollmentTokenFile, } from '@cortexkit/claustrum-client';
export { ClaustrumConsumer, type ClaustrumConsumerOptions, type SendOptions, } from './consumer.js';
export { type AccountIdentitySource, type ClaustrumFamily, type ClaustrumScopedAttempt, type ClaustrumScopedClient, ClaustrumScopedCustody, type ClaustrumScopedIdentity, decideScopedRetryAfter401, type IdentityParser, isScopedCredentialRotation, type ScopedRetryReason, SERVING_MARGIN_MS, type SkippedVaultReason, type SkippedVaultRecord, type VaultCredential, type VaultCredentialType, type VaultInventory, } from './custody.js';
export { type ClaustrumEnrollmentClient, type ClaustrumEnrollmentConnection, ClaustrumEnrollmentManager, type ClaustrumEnrollmentPaths, type ClaustrumEnrollmentResetResult, type ClaustrumEnrollmentStatus, classifyEnrollmentError, connectClaustrumEnrollmentClient, type EnrollmentDisposition, enrollmentName, getClaustrumEnrollmentPaths, hostEnrollmentPaths, RETRYABLE_ENROLLMENT_CODES, readClaustrumEnrollmentStatus, readClaustrumEnrollmentToken, resetClaustrumEnrollmentState, TERMINAL_ENROLLMENT_CODES, } from './enrollment.js';
export { ClaustrumConsumerError, type ClaustrumConsumerFailureKind, type ClaustrumLogger, } from './errors.js';
export { assertHostSlotMatchesMode, assertNotCustodyPlaceholder, CUSTODY_PLACEHOLDER_PREFIX, classifyHostSlot, custodyPlaceholder, custodyPlaceholderKey, type HostSlotContent, isCustodyPlaceholder, isCustodyPlaceholderValue, } from './host-slot.js';
export { acceptAccount, type DeclinedAccount, declineAccount, isDeclined, } from './interlock.js';
export { type AccountMapper, acceptVaultRoute, DEFAULT_ROUTE_PREFIX, declineVaultRoute, type MutateVaultRosterOptions, mutateVaultRoster, type ProjectionOptions, projectVaultRoster, type QuotaReceipt, readVaultRoster, recordVaultQuota, refreshVaultRoster, resolveVaultPrimary, type VaultPrimary, type VaultPrimaryBinding, type VaultPrimaryUnavailableReason, type VaultRosterFile, type VaultRosterLockContext, type VaultRosterRow, vaultRoutingRows, } from './roster.js';
/**
 * Connect the client that lists and fetches this consumer's vault credentials
 * on the request path. `connectionFile` is required: this library
 * reads no environment, so the plugin resolves the vault's connection file.
 */
export declare function connectClaustrumScopedClient(options: ClaustrumClientOptions & {
    connectionFile: string;
}): Promise<ClaustrumScopedClient>;
