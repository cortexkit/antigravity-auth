// Claustrum vault custody shared by the auth plugins: scoped enrollment (run
// from setup), discovery of this consumer's vault accounts as rows for this
// package's `/routing` subpath, per-send authorization, 401 reporting, the
// declined-account interlock and the host-slot guard. Needs the optional
// peer `@cortexkit/claustrum-client`.
import { ClaustrumClient, } from '@cortexkit/claustrum-client';
import { insulaUsageTransport } from './insula.js';
export { ClaustrumCredentialError, } from '@cortexkit/claustrum-client';
export { ClaustrumUnreachableError, classifyVaultFailure, VAULT_FAILURE_CLASSES, } from './availability.js';
export { ClaustrumConsumer, } from './consumer.js';
export { ClaustrumScopedCustody, decideScopedRetryAfter401, isScopedCredentialRotation, KEPT_RECEIPT_MARGIN_MS, SERVING_MARGIN_MS, } from './custody.js';
export { ClaustrumEnrollmentManager, classifyEnrollmentError, connectClaustrumEnrollmentClient, disconnectClaustrumEnrollment, enrollmentAuthority, enrollmentName, getClaustrumEnrollmentPaths, hostEnrollmentPaths, RETRYABLE_ENROLLMENT_CODES, readClaustrumEnrollmentStatus, readClaustrumEnrollmentToken, resetClaustrumEnrollmentState, TERMINAL_ENROLLMENT_CODES, } from './enrollment.js';
export { ClaustrumConsumerError, } from './errors.js';
export { assertHostSlotMatchesMode, assertNotCustodyPlaceholder, CUSTODY_PLACEHOLDER_PREFIX, classifyHostSlot, custodyPlaceholder, custodyPlaceholderKey, isCustodyPlaceholder, isCustodyPlaceholderValue, } from './host-slot.js';
export { acquireInsulaQuotaSource, } from './insula.js';
export { acceptAccount, declineAccount, isDeclined, } from './interlock.js';
export { drainVaultQuota } from './quota-writer.js';
export { acceptVaultRoute, DEFAULT_ROUTE_PREFIX, declineVaultRoute, mutateVaultRoster, projectVaultRoster, readVaultRoster, recordVaultAccountQuota, recordVaultQuota, refreshVaultRoster, resolveVaultPrimary, vaultRoutingRows, } from './roster.js';
export { ChangeNoticeReader, RESUBSCRIBE_BACKOFF_MS, SAFETY_POLL_MS, ScopedRosterWatch, WATCH_RETRY_MS, } from './watch.js';
/**
 * Connect the client that lists and fetches this consumer's vault credentials
 * on the request path. `connectionFile` is required: this library
 * reads no environment, so the plugin resolves the vault's connection file.
 */
export async function connectClaustrumScopedClient(options) {
    const client = await ClaustrumClient.connect(options);
    return Object.assign(client, { insula: insulaUsageTransport(options) });
}
