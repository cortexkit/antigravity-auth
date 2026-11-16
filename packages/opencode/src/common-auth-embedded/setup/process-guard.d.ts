/** Reuse an inspection only while setup has done nothing a running host could observe. */
export declare class SetupProcessGuard {
    #private;
    private readonly inspect;
    private readonly now;
    constructor(inspect: () => Promise<void>, now?: () => number);
    check(options?: {
        reuse?: boolean;
    }): Promise<void>;
    /** Callbacks, writes and waits can all make an earlier inspection stale. */
    step<T>(run: () => T | Promise<T>): Promise<T>;
}
