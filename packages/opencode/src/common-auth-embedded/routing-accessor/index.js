/**
 * Optional THALAMUS routing for vault mode and advisory turn notes for request
 * shaping. Account ids are vault account ids, not local pool rows. Nothing is
 * persisted here; plugins on routes the runner does not serve get no turn notes.
 */
import { isCacheWarmStopReason, } from './cache-policy.js';
import { routingHandle } from './handle.js';
export { CACHE_WARM_STOP_REASONS, isCacheWarmStopReason, reportCacheTouch, reportCacheWarmStopped, sessionCachePolicy, sessionToolWait, } from './cache-policy.js';
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function billingCache(value) {
    if (!isObject(value) || Array.isArray(value))
        return;
    const { ttlMs, implicit, warming } = value;
    const cache = {};
    // Conflicting lifetime claims cannot prove what the request cached.
    if (!(ttlMs !== undefined && implicit !== undefined)) {
        if (typeof ttlMs === 'number' && Number.isSafeInteger(ttlMs) && ttlMs > 0) {
            cache.ttl_ms = ttlMs;
        }
        else if (implicit === true) {
            cache.implicit = true;
        }
    }
    if (isObject(warming) && !Array.isArray(warming)) {
        const { on, stopReason } = warming;
        if (typeof on === 'boolean') {
            cache.warming = {
                on,
                ...(!on && isCacheWarmStopReason(stopReason)
                    ? { stop_reason: stopReason }
                    : {}),
            };
        }
    }
    return Object.keys(cache).length > 0 ? cache : undefined;
}
function billingUsage(value) {
    if (!isObject(value) || Array.isArray(value))
        return;
    const usage = {};
    for (const [inputKey, payloadKey] of [
        ['input', 'input'],
        ['output', 'output'],
        ['cacheRead', 'cache_read'],
        ['cacheWrite', 'cache_write'],
        ['cacheWrite5m', 'cache_write_5m'],
        ['cacheWrite1h', 'cache_write_1h'],
        ['reasoning', 'reasoning'],
    ]) {
        const count = value[inputKey];
        if (typeof count === 'number' &&
            Number.isSafeInteger(count) &&
            count >= 0) {
            usage[payloadKey] = count;
        }
    }
    const reasoningIncludedInOutput = value.reasoningIncludedInOutput;
    if (typeof reasoningIncludedInOutput === 'boolean') {
        usage.reasoning_included_in_output = reasoningIncludedInOutput;
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
}
/**
 * Read advisory input for request shaping, in landing order, without persisting
 * it. If no routing handle is available or the runner does not serve the route,
 * returns [].
 */
export function turnNotes(sessionId) {
    try {
        const handle = routingHandle(sessionId);
        if (!handle)
            return [];
        const read = handle.turn_notes;
        if (typeof read !== 'function')
            return [];
        const answer = read.call(handle);
        if (isObject(answer) && typeof answer.then === 'function') {
            void Promise.resolve(answer).catch(() => { });
            return [];
        }
        if (!Array.isArray(answer))
            return [];
        const notes = [];
        const encoder = new TextEncoder();
        for (const entry of answer) {
            try {
                if (!isObject(entry) || Array.isArray(entry))
                    continue;
                const afterToolUseId = entry.after_tool_use_id;
                const text = entry.text;
                if (typeof afterToolUseId !== 'string' ||
                    afterToolUseId.length === 0 ||
                    typeof text !== 'string' ||
                    // A whitespace-only note says nothing and a provider may refuse it.
                    text.trim().length === 0 ||
                    encoder.encode(text).byteLength > 16_384)
                    continue;
                notes.push({ afterToolUseId, text });
            }
            catch {
                // One unreadable note entry must not hide its valid neighbours.
            }
        }
        return notes;
    }
    catch {
        // Turn notes are optional and must not break request shaping.
        return [];
    }
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
        const request = {
            provider: input.provider,
            modelId: input.modelId,
        };
        const cap = input.holdWaitMaxS;
        if (typeof cap === 'number' && Number.isFinite(cap)) {
            request.hold_wait_max_s = Math.max(0, Math.floor(cap));
        }
        const pending = accountFor.call(handle, request, { deadlineMs });
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
 * Report a vault request, billing result or turn-note event without waiting for
 * routing. Only contract fields are sent, and all accessor failures are ignored.
 * Headers must already be limited to rate-limit headers by the caller; values
 * are not filtered or redacted here.
 */
export function reportRouting(input) {
    try {
        const handle = routingHandle(input.sessionId);
        if (!handle)
            return;
        const report = handle.report;
        if (typeof report !== 'function')
            return;
        let payload;
        if ('kind' in input) {
            switch (input.kind) {
                case 'billing': {
                    const { attemptId, requestKind, credentialId, provider, model, outcome, accountId, providerRequestId, providerResponseId, userMessageId, status, attempt, chargeBasis, usage: inputUsage, usageByModel: inputUsageByModel, cache: inputCache, } = input;
                    if (!isNonEmptyString(attemptId) ||
                        !isNonEmptyString(credentialId) ||
                        !isNonEmptyString(provider) ||
                        !isNonEmptyString(model) ||
                        (requestKind !== 'primary' &&
                            requestKind !== 'title' &&
                            requestKind !== 'compaction' &&
                            requestKind !== 'generate' &&
                            requestKind !== 'keep_warm' &&
                            requestKind !== 'prime') ||
                        (outcome !== 'completed' &&
                            outcome !== 'cut' &&
                            outcome !== 'failed'))
                        return;
                    const usage = billingUsage(inputUsage);
                    const cache = billingCache(inputCache);
                    const usageByModel = [];
                    if (Array.isArray(inputUsageByModel)) {
                        for (const entry of inputUsageByModel) {
                            if (!isObject(entry) || Array.isArray(entry))
                                continue;
                            const modelUsed = entry.modelUsed;
                            if (!isNonEmptyString(modelUsed))
                                continue;
                            const modelUsage = billingUsage(entry.usage);
                            // Thalamus rejects the whole report when an entry has no usage
                            // object, so an entry without a valid reading is dropped.
                            if (!modelUsage)
                                continue;
                            usageByModel.push({ model_used: modelUsed, usage: modelUsage });
                        }
                    }
                    payload = {
                        kind: 'billing',
                        attempt_id: attemptId,
                        request_kind: requestKind,
                        credential_id: credentialId,
                        provider,
                        model,
                        outcome,
                        ...(isNonEmptyString(accountId) ? { account_id: accountId } : {}),
                        ...(isNonEmptyString(providerRequestId)
                            ? { provider_request_id: providerRequestId }
                            : {}),
                        ...(isNonEmptyString(providerResponseId)
                            ? { provider_response_id: providerResponseId }
                            : {}),
                        ...(isNonEmptyString(userMessageId)
                            ? { user_message_id: userMessageId }
                            : {}),
                        ...(typeof status === 'number' &&
                            Number.isInteger(status) &&
                            status >= 0
                            ? { status }
                            : {}),
                        ...(typeof attempt === 'number' &&
                            Number.isInteger(attempt) &&
                            attempt >= 1
                            ? { attempt }
                            : {}),
                        ...(chargeBasis === 'subscription_included' ||
                            chargeBasis === 'metered_api'
                            ? { charge_basis: chargeBasis }
                            : {}),
                        ...(usage ? { usage } : {}),
                        ...(usageByModel.length > 0
                            ? { usage_by_model: usageByModel }
                            : {}),
                        ...(cache ? { cache } : {}),
                    };
                    break;
                }
                case 'turn_notes_supported': {
                    const { model, supported } = input;
                    if (typeof model !== 'string' ||
                        model.length === 0 ||
                        typeof supported !== 'boolean')
                        return;
                    payload = {
                        kind: 'turn_notes_supported',
                        model,
                        supported,
                    };
                    break;
                }
                case 'turn_note_skipped': {
                    const { after_tool_use_id, reason } = input;
                    if (typeof after_tool_use_id !== 'string' ||
                        after_tool_use_id.length === 0 ||
                        (reason !== 'anchor_missing' &&
                            reason !== 'before_user_message' &&
                            reason !== 'unsupported_model' &&
                            reason !== 'not_oauth'))
                        return;
                    payload = {
                        kind: 'turn_note_skipped',
                        after_tool_use_id,
                        reason,
                    };
                    break;
                }
                default:
                    return;
            }
        }
        else {
            const identity = {
                account_id: input.accountId,
                ...(input.credentialId !== undefined
                    ? { credential_id: input.credentialId }
                    : {}),
            };
            switch (input.outcome) {
                case 'served':
                    payload = { ...identity, outcome: 'served', headers: input.headers };
                    break;
                case 'exhausted': {
                    const { window, pool } = input;
                    if (window !== '5h' && window !== '7d')
                        return;
                    // An undefined pool means the whole account, as an omitted one does.
                    if (pool !== undefined &&
                        (typeof pool !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(pool)))
                        return;
                    payload = {
                        ...identity,
                        outcome: 'exhausted',
                        window,
                        ...(pool ? { pool } : {}),
                        ...(input.resetsAt !== undefined
                            ? { resets_at: input.resetsAt }
                            : {}),
                    };
                    break;
                }
                default:
                    return;
            }
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
