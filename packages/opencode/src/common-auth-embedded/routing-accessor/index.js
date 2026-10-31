// Optional THALAMUS routing for vault mode only. Account ids here are vault
// account ids; local pool rows are not known to the routing engine.
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function routingHandle(sessionId) {
    // The bridge can load after the auth plugin, so never cache the accessor.
    const routing = Reflect.get(globalThis, Symbol.for('cortexkit.routing'));
    if (typeof routing !== 'function')
        return undefined;
    const handle = routing(sessionId);
    return isObject(handle) ? handle : undefined;
}
function selectionFor(answer, candidates) {
    if (!isObject(answer))
        return undefined;
    const accountId = answer.account_id;
    const credentialId = answer.credential_id;
    if (typeof accountId !== 'string')
        return undefined;
    if (credentialId !== undefined && typeof credentialId !== 'string') {
        return undefined;
    }
    const candidate = candidates.find((route) => route.accountId === accountId &&
        (credentialId === undefined || route.credentialId === credentialId));
    if (!candidate)
        return undefined;
    const hold = answer.hold;
    const retryAfterMs = isObject(hold) ? hold.retry_after_ms : undefined;
    if (typeof retryAfterMs === 'number' &&
        Number.isFinite(retryAfterMs) &&
        retryAfterMs >= 0) {
        return { candidate, hold: { retry_after_ms: retryAfterMs } };
    }
    return { candidate };
}
/**
 * Ask routing for an eligible vault route. Any failure or unfamiliar answer
 * yields undefined so the plugin can keep its own choice. This does not admit
 * routes: callers must exclude vault refusals and killswitch-blocked accounts.
 */
export async function askRouting(input) {
    let timer;
    try {
        const handle = routingHandle(input.sessionId);
        if (!handle)
            return undefined;
        const accountFor = handle.accountFor;
        if (typeof accountFor !== 'function')
            return undefined;
        const requested = input.deadlineMs ?? 500;
        const deadlineMs = Number.isNaN(requested)
            ? 500
            : Math.min(2000, Math.max(1, requested));
        const expired = new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), deadlineMs);
            timer.unref();
        });
        const pending = accountFor.call(handle, { provider: input.provider, modelId: input.modelId }, { deadlineMs });
        if (!isObject(pending) || typeof pending.then !== 'function')
            return undefined;
        const answer = await Promise.race([pending, expired]);
        return selectionFor(answer, input.candidates);
    }
    catch {
        // The process-global bridge is optional and must not break authentication.
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Report a vault request without waiting for routing. Only contract fields are
 * sent, and all accessor failures are ignored. Headers must already be limited
 * to rate-limit headers by the caller; values are not filtered or redacted here.
 */
export function reportRouting(input) {
    try {
        const handle = routingHandle(input.sessionId);
        if (!handle)
            return;
        const report = handle.report;
        if (typeof report !== 'function')
            return;
        const identity = {
            account_id: input.accountId,
            ...(input.credentialId !== undefined
                ? { credential_id: input.credentialId }
                : {}),
        };
        let payload;
        switch (input.outcome) {
            case 'served':
                payload = { ...identity, outcome: 'served', headers: input.headers };
                break;
            case 'exhausted':
                payload = {
                    ...identity,
                    outcome: 'exhausted',
                    window: input.window,
                    ...(input.resetsAt !== undefined
                        ? { resets_at: input.resetsAt }
                        : {}),
                };
                break;
            default:
                return;
        }
        // A broken bridge may return a rejected promise despite its void contract.
        const pending = report.call(handle, payload);
        if (isObject(pending) && typeof pending.then === 'function') {
            void Promise.resolve(pending).catch(() => { });
        }
    }
    catch {
        // Reporting must never change the result of an auth request.
    }
}
