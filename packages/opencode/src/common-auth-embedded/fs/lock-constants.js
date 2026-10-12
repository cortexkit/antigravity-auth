export const WRITER_LOCK_CONSTANTS = Object.freeze({
    sidebar: Object.freeze({
        name: 'sidebar-write',
        ttlMs: 10_000,
        timeoutMs: 15_000,
        renew: true,
    }),
    preferences: Object.freeze({
        name: 'preferences',
        ttlMs: 10_000,
        timeoutMs: 2_000,
        renew: true,
    }),
});
