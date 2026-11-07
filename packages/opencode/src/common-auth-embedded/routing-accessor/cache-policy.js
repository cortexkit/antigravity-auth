import { routingHandle } from './handle.js';
const warned = new Set();
// Inspect descriptors rather than values so warning deduplication cannot invoke
// a broken bridge's getters a second time. Do not print policy contents.
function shape(value, seen = new Set()) {
    if (typeof value !== 'object' || value === null) {
        return `${typeof value}:${String(value)}`;
    }
    if (seen.has(value))
        return 'cycle';
    seen.add(value);
    return `${Array.isArray(value) ? 'array' : 'object'}:{${Object.entries(Object.getOwnPropertyDescriptors(value))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, descriptor]) => `${key}:${'value' in descriptor ? shape(descriptor.value, seen) : 'accessor'}`)
        .join(',')}}`;
}
function invalid(kind, value) {
    let fingerprint = 'unreadable';
    try {
        fingerprint = shape(value);
    }
    catch {
        // Uninspectable proxies share one diagnostic shape, without invoking getters.
    }
    try {
        const key = `${kind}:${fingerprint}`;
        if (!warned.has(key)) {
            warned.add(key);
            console.warn(`[common-auth] Ignoring invalid session ${kind} policy`);
        }
    }
    catch {
        // A broken warning sink must not break a request either.
    }
    return null;
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rejectAsync(value) {
    if (typeof value.then !== 'function')
        return false;
    // Absorb a rejected promise from a bridge that broke the synchronous contract.
    void Promise.resolve(value).catch(() => { });
    return true;
}
function onlyKeys(value, keys) {
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
}
/**
 * Read the session's current plan on every decision; never retain it across
 * requests. Null means the plugin keeps its own settings. No I/O or exceptions.
 */
export function sessionCachePolicy(sessionId) {
    let answer;
    try {
        const handle = routingHandle(sessionId);
        if (!handle)
            return null;
        const read = handle.cache;
        if (typeof read !== 'function')
            return null;
        answer = read.call(handle);
        if (answer === null)
            return null;
        if (!record(answer) || rejectAsync(answer))
            return invalid('cache', answer);
        const { ttl, keep_warm, hours } = answer;
        if (!onlyKeys(answer, ['ttl', 'keep_warm', 'hours']) ||
            (ttl !== undefined &&
                ttl !== 'none' &&
                ttl !== 'short' &&
                ttl !== 'long') ||
            (keep_warm !== undefined &&
                keep_warm !== 'off' &&
                keep_warm !== 'hours' &&
                keep_warm !== 'always' &&
                keep_warm !== 'auto') ||
            (ttl === 'none' && keep_warm !== undefined && keep_warm !== 'off') ||
            (keep_warm !== 'hours' && 'hours' in answer)) {
            return invalid('cache', answer);
        }
        const policy = {
            ...(ttl !== undefined ? { ttl } : {}),
            ...(keep_warm !== undefined ? { keep_warm } : {}),
        };
        if (keep_warm === 'hours') {
            if (!record(hours) || !onlyKeys(hours, ['from', 'to', 'tz'])) {
                return invalid('cache', answer);
            }
            const { from, to, tz } = hours;
            const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
            if (typeof from !== 'string' ||
                !time.test(from) ||
                typeof to !== 'string' ||
                !time.test(to) ||
                from === to ||
                typeof tz !== 'string' ||
                tz.length === 0) {
                return invalid('cache', answer);
            }
            new Intl.DateTimeFormat('en', { timeZone: tz });
            policy.hours = { from, to, tz };
        }
        return policy;
    }
    catch {
        return invalid('cache', answer);
    }
}
/** Read the oldest running plan tool afresh, without I/O or exceptions. */
export function sessionToolWait(sessionId) {
    let answer;
    try {
        const handle = routingHandle(sessionId);
        if (!handle)
            return null;
        const read = handle.tool_wait;
        if (typeof read !== 'function')
            return null;
        answer = read.call(handle);
        if (answer === null)
            return null;
        if (!record(answer) || rejectAsync(answer))
            return invalid('tool_wait', answer);
        const { since } = answer;
        if (!onlyKeys(answer, ['since']) ||
            typeof since !== 'number' ||
            !Number.isSafeInteger(since) ||
            since < 0) {
            return invalid('tool_wait', answer);
        }
        return { since };
    }
    catch {
        return invalid('tool_wait', answer);
    }
}
function report(sessionId, payload) {
    const handle = routingHandle(sessionId);
    if (!handle)
        return;
    const send = handle.report;
    if (typeof send !== 'function')
        return;
    const pending = send.call(handle, payload);
    if (record(pending) && typeof pending.then === 'function') {
        void Promise.resolve(pending).catch(() => { });
    }
}
/**
 * Call only after the reply has been handed to the host, never on the awaited
 * request path. Synchronous fire-and-forget, with no retries; the bridge owns
 * redelivery of the newest touch. Accessor and report failures are absorbed.
 */
export function reportCacheTouch(sessionId, input) {
    try {
        const { at, ttlMs, source } = input;
        if (!Number.isSafeInteger(at) ||
            at < 0 ||
            (ttlMs !== 'implicit' &&
                (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0)) ||
            (source !== 'response' && source !== 'warm'))
            return;
        report(sessionId, { kind: 'cache_touch', at, ttl_ms: ttlMs, source });
    }
    catch {
        // Optional reporting must never change the result of an auth request.
    }
}
/**
 * Call off the request path, after handing the reply to the host. Report only
 * a session that actually warmed, never one that was off from the start.
 * Synchronous fire-and-forget; failures are absorbed and never retried here.
 */
export function reportCacheWarmStopped(sessionId, input) {
    try {
        const { at, reason } = input;
        if (!Number.isSafeInteger(at) || at < 0 || typeof reason !== 'string')
            return;
        report(sessionId, { kind: 'cache_warm_stopped', at, reason });
    }
    catch {
        // Optional reporting must never change the result of an auth request.
    }
}
