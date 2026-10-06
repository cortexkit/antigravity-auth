/** A strict notification scope was used without a session id. */
export class RpcSessionRequiredError extends Error {
    operation;
    constructor(operation) {
        super(`a ${operation} on a strict notification scope needs a session id`);
        this.name = 'RpcSessionRequiredError';
        this.operation = operation;
    }
}
/** True for a session id a strict scope accepts: a non-empty string. */
export function isSessionId(value) {
    return typeof value === 'string' && value.length > 0;
}
const queues = new Map();
function state(scope) {
    const key = JSON.stringify([
        scope.rpcRoot,
        scope.directoryPrefix,
        scope.registrationSessionId,
        ...(scope.requireSession === true ? ['strict'] : []),
    ]);
    let value = queues.get(key);
    if (!value) {
        value = {
            queue: [],
            nextId: 1,
            lastDrainAtBySession: new Map(),
            lastDrainAtAny: 0,
        };
        queues.set(key, value);
    }
    return value;
}
const QUEUE_CAP = 100;
const TUI_CONNECTED_WINDOW_MS = 3_000;
export function pushNotification(scope, payload, sessionId) {
    if (scope.requireSession === true && !isSessionId(sessionId))
        throw new RpcSessionRequiredError('push');
    const value = state(scope);
    value.queue.push({
        id: value.nextId++,
        type: 'open-dialog',
        payload,
        sessionId,
    });
    if (value.queue.length > QUEUE_CAP)
        value.queue = value.queue.slice(-QUEUE_CAP);
}
export function drainNotifications(scope, lastReceivedId = 0, sessionId) {
    // A strict queue holds only session-scoped notifications (its push refuses
    // the rest), so the ordinary match below already gives a strict drain
    // nothing but its own session's notifications.
    if (scope.requireSession === true && !isSessionId(sessionId))
        throw new RpcSessionRequiredError('drain');
    const value = state(scope);
    const now = Date.now();
    value.lastDrainAtAny = now;
    if (sessionId !== undefined)
        value.lastDrainAtBySession.set(sessionId, now);
    const broadcastOnly = scope.sessionlessDrain === 'broadcast-only';
    const matches = (n) => sessionId === undefined
        ? !broadcastOnly || n.sessionId === undefined
        : n.sessionId === undefined || n.sessionId === sessionId;
    if (lastReceivedId > 0) {
        value.queue = value.queue.filter((n) => {
            if (n.id > lastReceivedId)
                return true;
            // A sessionless ack in broadcast-only mode consumes the broadcasts it
            // was shown; in the default mode it consumes nothing, since it was
            // shown targeted notifications other sessions still have to receive.
            if (sessionId === undefined)
                return !broadcastOnly || n.sessionId !== undefined;
            return n.sessionId !== sessionId;
        });
    }
    return value.queue.filter((n) => n.id > lastReceivedId && matches(n));
}
/**
 * True when a TUI drained within the last 3000 ms. With a session id, that
 * session drained. Without one, a broadcast-only scope answers whether any
 * drain happened; a default scope answers false, since it only tracks
 * sessions.
 */
export function isTuiConnected(scope, sessionId) {
    const now = Date.now();
    const value = state(scope);
    const at = sessionId !== undefined
        ? (value.lastDrainAtBySession.get(sessionId) ?? 0)
        : scope.sessionlessDrain === 'broadcast-only'
            ? value.lastDrainAtAny
            : 0;
    return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS;
}
export function resetNotificationsForTest(scope) {
    const value = state(scope);
    value.queue = [];
    value.nextId = 1;
    value.lastDrainAtBySession.clear();
    value.lastDrainAtAny = 0;
}
