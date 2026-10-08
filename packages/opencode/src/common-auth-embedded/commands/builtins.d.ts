import type { AddInput, PoolLockSpec, PoolRow, PoolStore, RemoveOptions } from '../store/index.js';
import type { CommandInvocation, KnobValues, MenuChoice, MenuKnob } from './model.js';
import { type ResolvedSection } from './seam.js';
/**
 * What a plugin's login hands back. `ready` adds the account now. `pending`
 * means the user must finish somewhere else (a browser, a device code):
 * `message` tells them how, and the account is added when `completion`
 * settles, with the result sent to the invocation that started it.
 */
export type LoginOutcome = {
    status: 'ready';
    account: AddInput;
} | {
    status: 'pending';
    message: string;
    /** Resolves with the account to add, or undefined when the user gave up. */
    completion: Promise<AddInput | undefined>;
} | {
    status: 'cancelled';
    message?: string;
};
export interface AccountsSectionOptions {
    /** What to show as an account's identity; defaults to its recorded identity. */
    describeIdentity?(row: PoolRow): string | undefined;
    /** The plugin's login; without it the section offers no add action. */
    login?: {
        label?: string;
        knobs?: MenuKnob[];
        run(values: KnobValues, invocation: CommandInvocation): Promise<LoginOutcome>;
    };
    /** Passed to `store.remove`: a reason refuses removing that id. */
    protect?: RemoveOptions['protect'];
}
export interface QuotaSectionOptions {
    /** The quota scope to show (`all` or a model family); defaults to `all`. */
    scope?: string;
    /**
     * Checks quota now for the named rows. Without it, the menu asks the store
     * for a reading of each row and waits for the pulls to settle.
     */
    check?(ids: readonly string[], invocation: CommandInvocation): Promise<void>;
}
export interface RoutingSectionOptions {
    /**
     * Further `routing.mode` values the plugin routes as `ordered` with the
     * former main row moved (`main-first`, `fallback-first`), offered between
     * `ordered` and `sticky-balanced`.
     */
    orderedVariants?: MenuChoice[];
    formerMainId?: string;
}
export interface LimitsSectionOptions {
    /**
     * The quota window labels a floor can be set for. Defaults to every label
     * the pool's quota readings carry, or `primary` when there are none.
     */
    labels?: readonly string[];
}
export interface BuiltinOptions {
    store: PoolStore;
    extraLocks?: readonly PoolLockSpec[];
    now: () => number;
    accounts?: AccountsSectionOptions;
    quota?: QuotaSectionOptions;
    routing?: RoutingSectionOptions;
    limits?: LimitsSectionOptions;
}
/** `disabledReason` recorded when the user disables an account from the menu. */
export declare const MENU_DISABLED_REASON = "disabled from the command menu";
/** The four built-in sections, in their fixed order, from one read of the store. */
export declare function builtinSections(options: BuiltinOptions): Promise<ResolvedSection[]>;
