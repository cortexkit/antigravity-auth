import { type RedactionOptions } from '../logger/index.js';
import type { PoolLockSpec, PoolStore } from '../store/index.js';
import { type AccountsSectionOptions, type LimitsSectionOptions, type QuotaSectionOptions, type RoutingSectionOptions } from './builtins.js';
import type { CommandApplyRequest, CommandApplyResult, CommandDialogPayload, CommandInvocation, PluginExtraSection, PluginSection } from './model.js';
import { type SeamLogger } from './seam.js';
/** The four slots the library can build from a pool store. */
export type StoreSectionSlot = 'accounts' | 'quota' | 'routing' | 'limits';
export interface CommandMenuOptions {
    /** The slash command's name without the slash (`openai`, `claude`). */
    command: string;
    /** The dialog title. */
    title: string;
    /**
     * The pool store the built-in Accounts, Quota, Routing and Limits sections
     * read and write. Required unless `replace` supplies all four.
     */
    store?: PoolStore;
    /**
     * Plugin sections that take the place of built-in ones, keeping their slot
     * and the fixed order. For a plugin whose accounts are not pool rows (a
     * single host login, or rows it must not expose by id), so it renders its
     * own items and actions without a store. A replaced slot's built-in
     * options (`accounts`, `quota`, ...) must not be given.
     */
    replace?: Partial<Record<StoreSectionSlot, PluginSection>>;
    /** The plugin's legacy locks, passed to every store write the menu makes. */
    extraLocks?: readonly PoolLockSpec[];
    accounts?: AccountsSectionOptions;
    quota?: QuotaSectionOptions;
    routing?: RoutingSectionOptions;
    limits?: LimitsSectionOptions;
    /** The Cache section; omitted when the plugin has none. */
    cache?: PluginSection;
    /** The Diagnostics section (dumps, logging); omitted when the plugin has none. */
    diagnostics?: PluginSection;
    /** Provider extras, shown after every fixed section in this order. */
    extras?: readonly PluginExtraSection[];
    /** Receives the seam's warnings and failed actions; defaults to the library logger. */
    logger?: SeamLogger;
    /**
     * The provider's secret shapes, added to the redactor every string that
     * leaves the menu goes through (payloads and notifications). Without a
     * pattern for its key format, a plugin's API key quoted in an outcome's
     * text is not recognised.
     */
    redaction?: RedactionOptions;
    now?: () => number;
}
export interface CommandMenu {
    readonly command: string;
    /** The dialog payload for one invocation of the slash command. */
    open(invocation: CommandInvocation): Promise<CommandDialogPayload>;
    /** Applies one action and returns its message and the refreshed menu. */
    apply(request: CommandApplyRequest, invocation: CommandInvocation): Promise<CommandApplyResult>;
}
export declare function createCommandMenu(options: CommandMenuOptions): CommandMenu;
/**
 * Checks an apply request that arrived over the loopback RPC; undefined when
 * it is not one. Only the request's own fields are kept.
 */
export declare function parseApplyRequest(value: unknown): CommandApplyRequest | undefined;
