export declare const WRITER_LOCK_CONSTANTS: Readonly<{
    sidebar: Readonly<{
        name: "sidebar-write";
        ttlMs: 10000;
        timeoutMs: 15000;
        renew: true;
    }>;
    preferences: Readonly<{
        name: "preferences";
        ttlMs: 10000;
        timeoutMs: 2000;
        renew: true;
    }>;
}>;
