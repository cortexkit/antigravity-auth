// Claustrum vault custody shared by the auth plugins: scoped enrollment (run
// from setup), discovery of this consumer's vault accounts as rows for this
// package's `/routing` subpath, per-send authorization, 401 reporting, the
// declined-account interlock and the host-slot guard. Needs the optional
// peer `@cortexkit/claustrum-client`.
import { ClaustrumClient, } from '@cortexkit/claustrum-client';
export { ClaustrumCredentialError, } from '@cortexkit/claustrum-client';
export { ClaustrumConsumer, } from './consumer.js';
export { ClaustrumScopedCustody, decideScopedRetryAfter401, isScopedCredentialRotation, SERVING_MARGIN_MS, } from './custody.js';
export { ClaustrumEnrollmentManager, classifyEnrollmentError, connectClaustrumEnrollmentClient, enrollmentName, getClaustrumEnrollmentPaths, hostEnrollmentPaths, RETRYABLE_ENROLLMENT_CODES, readClaustrumEnrollmentStatus, readClaustrumEnrollmentToken, resetClaustrumEnrollmentState, TERMINAL_ENROLLMENT_CODES, } from './enrollment.js';
export { ClaustrumConsumerError, } from './errors.js';
export { assertHostSlotMatchesMode, assertNotCustodyPlaceholder, CUSTODY_PLACEHOLDER_PREFIX, classifyHostSlot, custodyPlaceholder, custodyPlaceholderKey, isCustodyPlaceholder, isCustodyPlaceholderValue, } from './host-slot.js';
export { acceptAccount, declineAccount, isDeclined, } from './interlock.js';
export { acceptVaultRoute, DEFAULT_ROUTE_PREFIX, declineVaultRoute, mutateVaultRoster, projectVaultRoster, readVaultRoster, recordVaultQuota, refreshVaultRoster, resolveVaultPrimary, vaultRoutingRows, } from './roster.js';
/**
 * Connect the client that lists and fetches this consumer's vault credentials
 * on the request path. `connectionFile` is required: this library
 * reads no environment, so the plugin resolves the vault's connection file.
 */
export function connectClaustrumScopedClient(options) {
    return ClaustrumClient.connect(options);
}
