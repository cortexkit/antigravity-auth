import { ClaustrumCredentialError } from '@cortexkit/claustrum-client';
import { SocketClosedError, SocketTimeoutError, SubcCallError, } from '@cortexkit/subc-client';
import { ClaustrumConsumerError } from './errors.js';
/**
 * Codes from claustrum-client's decoder and its subc transport. A retry action
 * alone is not evidence of an outage: even transient vault refusals must win
 * over a previously served credential. New codes fail closed until reviewed.
 */
export const VAULT_FAILURE_CLASSES = Object.freeze({
    ECONNREFUSED: 'unreachable',
    ENOENT: 'unreachable',
    ECONNRESET: 'unreachable',
    EPIPE: 'unreachable',
    ETIMEDOUT: 'unreachable',
    transport_error: 'unreachable',
    unavailable: 'unreachable',
    timeout: 'unreachable',
    route_closed: 'unreachable',
    daemon_draining: 'unreachable',
    connection_closed: 'unreachable',
    connection_dropped: 'unreachable',
    request_deadline: 'unreachable',
    deadline_exceeded_no_drop_observed: 'unreachable',
    module_reloading: 'unreachable',
    module_warming: 'unreachable',
    target_unavailable: 'unreachable',
    module_timeout: 'unreachable',
    invalid_response: 'answered',
    invalid_record_version: 'answered',
    invalid_expiry: 'answered',
    invalid_status: 'answered',
    invalid_params: 'answered',
    ttl_unsatisfiable: 'answered',
    not_found: 'answered',
    enrollment_revoked: 'answered',
    enrollment_invalid: 'answered',
    grant_denied: 'answered',
    credential_unavailable: 'answered',
    needs_reauth: 'answered',
    declined: 'answered',
    disabled: 'answered',
    identity_changed: 'answered',
    closed: 'answered',
    client_closed: 'answered',
    pending_exists: 'answered',
    pending_queue_full: 'answered',
    already_consumed: 'answered',
    superseded: 'answered',
    stale_generation: 'answered',
    missing_identity: 'answered',
    invalid_control_body: 'answered',
    unknown_module: 'answered',
    module_removed: 'answered',
    capability_denied: 'answered',
    unknown_channel: 'unreachable',
    stale_route_epoch: 'unreachable',
    capability_forbidden: 'answered',
    capability_unprovided: 'answered',
    capability_ambiguous: 'answered',
    invalid_capability_identifier: 'answered',
    binary_body_required: 'answered',
    binary_call_requires_call_binary: 'answered',
    corr_exhausted: 'answered',
    late_route_cleanup_failed: 'answered',
    reverse_request_capability_not_declared: 'answered',
    stale_route_handle: 'answered',
    reverse_request_unhandled: 'answered',
    handler_error: 'answered',
    health_error: 'answered',
    duplicate_module_id: 'answered',
    route_rejected: 'answered',
    lock_busy: 'answered',
    owner_invalid: 'answered',
    renewal_failed: 'answered',
    unsupported_platform: 'answered',
    EACCES: 'answered',
    EPERM: 'answered',
    ERR_PRIVATE_FILES_SECURITY: 'answered',
});
/**
 * An injected adapter may throw this ONLY when its connection/transport is
 * unreachable, including a failed connect before getScoped. Do not wrap an
 * adapter shutdown, cancellation, validation error or vault refusal in it.
 * Its fixed message cannot echo enrollment or credential material, and its
 * kind stays `unavailable` for callers handling ClaustrumConsumerError.
 */
export class ClaustrumUnreachableError extends ClaustrumConsumerError {
    constructor() {
        super('unavailable', 'Claustrum scoped operation unavailable');
        this.name = 'ClaustrumUnreachableError';
    }
}
export function classifyVaultFailure(error) {
    if (error instanceof ClaustrumUnreachableError ||
        error instanceof SocketClosedError ||
        error instanceof SocketTimeoutError)
        return 'unreachable';
    const code = error instanceof ClaustrumCredentialError || error instanceof SubcCallError
        ? error.code
        : error instanceof Error && 'code' in error
            ? error.code
            : undefined;
    if (typeof code !== 'string' || !Object.hasOwn(VAULT_FAILURE_CLASSES, code))
        return 'answered';
    return VAULT_FAILURE_CLASSES[code];
}
