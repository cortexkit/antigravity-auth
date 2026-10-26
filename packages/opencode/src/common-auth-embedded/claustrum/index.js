// Claustrum vault custody shared by the auth plugins: scoped enrollment (run
// from setup), discovery of this consumer's vault accounts as rows for this
// package's `/routing` subpath, per-send authorization, 401 reporting, the
// declined-account interlock and the host-slot guard. Needs the optional
// peer `@cortexkit/claustrum-client`.
import { ClaustrumClient, } from '@cortexkit/claustrum-client';
import { ClaustrumUnreachableError } from './availability.js';
import { insulaUsageTransport } from './insula.js';
export { ClaustrumCredentialError, } from '@cortexkit/claustrum-client';
export { ClaustrumUnreachableError, classifyVaultFailure, VAULT_FAILURE_CLASSES, } from './availability.js';
export { ClaustrumConsumer, DEFAULT_CONNECT_TIMEOUT_MS, } from './consumer.js';
export { ClaustrumScopedCustody, decideScopedRetryAfter401, isScopedCredentialRotation, KEPT_RECEIPT_MARGIN_MS, SERVING_MARGIN_MS, } from './custody.js';
export { ClaustrumEnrollmentManager, classifyEnrollmentError, connectClaustrumEnrollmentClient, disconnectClaustrumEnrollment, enrollmentAuthority, enrollmentName, getClaustrumEnrollmentPaths, hostEnrollmentPaths, RETRYABLE_ENROLLMENT_CODES, readClaustrumEnrollmentStatus, readClaustrumEnrollmentToken, resetClaustrumEnrollmentState, TERMINAL_ENROLLMENT_CODES, } from './enrollment.js';
export { ClaustrumConsumerError, } from './errors.js';
export { assertHostSlotMatchesMode, assertNotCustodyPlaceholder, CUSTODY_PLACEHOLDER_PREFIX, classifyHostSlot, custodyPlaceholder, custodyPlaceholderKey, isCustodyPlaceholder, isCustodyPlaceholderValue, } from './host-slot.js';
export { ClaustrumDiscoveryHub, } from './hub.js';
export { acquireInsulaQuotaSource, } from './insula.js';
export { acceptAccount, declineAccount, isDeclined, } from './interlock.js';
export { drainVaultQuota } from './quota-writer.js';
export { acceptVaultRoute, DEFAULT_ROUTE_PREFIX, declineVaultRoute, mutateVaultRoster, projectVaultRoster, readVaultRoster, recordVaultAccountQuota, recordVaultQuota, refreshVaultRoster, reorderVaultRoster, resolveVaultPrimary, vaultRosterSeed, vaultRoutingRows, } from './roster.js';
export { ChangeNoticeReader, RESUBSCRIBE_BACKOFF_MS, SAFETY_POLL_MS, ScopedRosterWatch, WATCH_RETRY_MS, } from './watch.js';
/** How long `connectClaustrumScopedClient` waits by default. */
export const SCOPED_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Connect the client that lists and fetches this consumer's vault credentials
 * on the request path. `connectionFile` is required: this library
 * reads no environment, so the plugin resolves the vault's connection file.
 *
 * The wait is bounded by `connectTimeoutMs` (default 10 s) so a connect that
 * never settles cannot leave a consumer with a pending connection forever; the
 * caller then gets an unreachable error and may try again. A socket handshake
 * has its own limit, but local reads before it (the connection file) do not,
 * and a client that arrives after this deadline is closed, not returned.
 */
export async function connectClaustrumScopedClient(options) {
    const { connectTimeoutMs, ...client } = options;
    const limit = connectTimeoutMs ?? SCOPED_CONNECT_TIMEOUT_MS;
    const connecting = ClaustrumClient.connect(client);
    let expired = false;
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            expired = true;
            reject(new ClaustrumUnreachableError());
        }, limit);
        timer.unref?.();
    });
    try {
        const client = await Promise.race([connecting, deadline]);
        return Object.assign(client, { insula: insulaUsageTransport(options) });
    }
    catch (error) {
        // A connection that arrives after the deadline still owns a socket.
        void connecting.then((client) => client.close(), () => { });
        throw error;
    }
    finally {
        if (!expired && timer)
            clearTimeout(timer);
    }
}
