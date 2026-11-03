export function routingHandle(sessionId) {
    // The bridge can load after the auth plugin, so never cache the accessor.
    const routing = Reflect.get(globalThis, Symbol.for('cortexkit.routing'));
    if (typeof routing !== 'function')
        return undefined;
    const handle = routing(sessionId);
    return typeof handle === 'object' && handle !== null
        ? handle
        : undefined;
}
