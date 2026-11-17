export type PiSlotErrorCode = 'invalid-options' | 'invalid-auth' | 'unsafe-path' | 'lock-timeout' | 'lock-compromised' | 'io';
/** Errors deliberately contain neither paths nor credentials nor underlying error messages. */
export declare class PiSlotError extends Error {
    readonly code: PiSlotErrorCode;
    constructor(code: PiSlotErrorCode);
}
export interface PiSlotOptions {
    /** Windows checks safe ancestry and creates missing parents owner-only, regardless of this option. POSIX keeps its existing directory policy. */
    privateParents?: boolean;
    authPath: string;
    provider: string;
    /**
     * Where older versions kept the original Pi login; deleted when found.
     * Keep the same path across upgrades so legacy credentials can be removed.
     */
    stashPath: string;
    /**
     * The api_key Pi stores in the slot while the vault serves. It is a fixed,
     * non-secret string that no provider accepts. Pi runs a key starting with
     * `!` as a shell command and expands `$NAME` from the environment, so the
     * placeholder may contain neither.
     */
    placeholderKey: string;
    lockTimeoutMs?: number;
}
export interface PiSlotInspection {
    slot: 'original' | 'placeholder' | 'empty';
}
export interface PiSlot {
    inspect(): Promise<PiSlotInspection>;
    enterVault(): Promise<void>;
    exitVault(): Promise<'cleared' | 'nothing-to-do'>;
}
/**
 * Production entry point. Pi caches which models are usable; after a
 * successful transition the extension calls `ctx.modelRegistry.refresh()` so
 * Pi re-reads the slot it just changed.
 */
export declare function openPiSlot(options: PiSlotOptions): PiSlot;
/**
 * Internal test entry point: pause reads, renewals, or renames to simulate races,
 * and observe durable writes/deletion to simulate crashes. Not a public export.
 */
export declare function createPiSlot(options: PiSlotOptions, onStep?: (step: 'auth-written' | 'stash-deleted') => void, hooks?: {
    afterReadCheck?: (path: string) => Promise<void>;
    onRenew?: (renew: () => Promise<void>) => void;
    beforeRename?: (path: string) => Promise<void>;
}): PiSlot;
