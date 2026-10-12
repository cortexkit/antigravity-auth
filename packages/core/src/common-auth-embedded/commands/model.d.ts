/** The section slots, in the one order every renderer shows them. */
export declare const SECTION_SLOTS: readonly ['accounts', 'quota', 'routing', 'limits', 'cache', 'diagnostics', 'extra'];
export type SectionSlot = (typeof SECTION_SLOTS)[number];
/** One choice of a `choice` input. */
export interface MenuChoice {
    value: string;
    label: string;
}
/**
 * A typed input an action collects before it runs. `value` is the current
 * setting, shown as the default. A `number` or `text` input that is not
 * `required` may be left empty, which the action receives as `null`.
 */
export type MenuKnob = {
    kind: 'choice';
    id: string;
    label: string;
    choices: MenuChoice[];
    value?: string;
} | {
    kind: 'toggle';
    id: string;
    label: string;
    value: boolean;
} | {
    kind: 'number';
    id: string;
    label: string;
    value?: number;
    min?: number;
    max?: number;
    required?: boolean;
} | {
    kind: 'text';
    id: string;
    label: string;
    value?: string;
    placeholder?: string;
    /** Hide what is typed (a pasted secret, for example). */
    masked?: boolean;
    required?: boolean;
};
export type KnobValue = string | number | boolean | null;
export type KnobValues = Readonly<Record<string, KnobValue>>;
export interface MenuConfirmation {
    message: string;
    /** Irreversible actions always carry a confirmation. */
    irreversible: boolean;
}
export interface MenuAction {
    id: string;
    label: string;
    description?: string;
    /**
     * The header a section-level action is listed under (`Actions`). See
     * `MenuSection` for how renderers draw groups.
     */
    group?: string;
    knobs: MenuKnob[];
    /** Present when the action must be confirmed before it is applied. */
    confirm?: MenuConfirmation;
}
/**
 * The account fields a renderer may show, and nothing else: an account is
 * always projected field by field, never spread, so a credential the store
 * row carries cannot reach a payload.
 */
export interface MenuAccount {
    id: string;
    label?: string;
    enabled: boolean;
    type: 'oauth' | 'api';
    /** What the plugin chose to show for the account's identity. */
    identity?: string;
}
export interface MenuItem {
    id: string;
    label: string;
    detail?: string;
    /** The header the item is listed under (`Accounts`); see `MenuSection`. */
    group?: string;
    /**
     * A short value shown right-aligned beside the label (`enabled`,
     * `5h 58% left`): an OpenCode dialog option's `footer`.
     */
    status?: string;
    account?: MenuAccount;
    /**
     * Extra name/value pairs a drawer may list under the item. Plugin data
     * passes through here, so it is scrubbed of credential-shaped names.
     */
    facts?: Record<string, unknown>;
    actions: MenuAction[];
}
/**
 * One section of the menu. How every renderer draws it:
 *
 * - Every option a renderer shows can be selected and does something: it is
 *   an item with at least one action, or a section-level action. Text that
 *   does nothing is never an option; it is a group header or a line.
 * - `lines` are read-only text. On OpenCode they are drawn as header text
 *   (a `category`) above the first group; on Pi they are part of the select
 *   title.
 * - The options are the items, then the section-level actions, in that
 *   order. When an option's `group` differs from the previous one's, a
 *   header naming the group is drawn first. A header is never selectable
 *   (on OpenCode it is the option's `category`).
 * - An item's `status` is drawn right-aligned beside its label (on
 *   OpenCode, `footer`); its `detail` and an action's `description` are
 *   the secondary text (`description`).
 *
 * The built-in sections never emit an item without actions, and a plugin
 * section should not either. A renderer that meets one must not offer it as
 * an option: on OpenCode a `disabled` option is hidden altogether, so the
 * item is written as header text instead, and Pi writes it into the title.
 */
export interface MenuSection {
    id: string;
    slot: SectionSlot;
    title: string;
    /** Read-only text shown above the rows; never a selectable option. */
    lines: string[];
    items: MenuItem[];
    actions: MenuAction[];
    facts?: Record<string, unknown>;
}
export interface CommandMenuModel {
    /** The slash command's name, without the slash. */
    command: string;
    title: string;
    sections: MenuSection[];
}
/** What a host's TUI receives when the slash command opens the dialog. */
export interface CommandDialogPayload {
    command: string;
    menu: CommandMenuModel;
}
/**
 * One applied action, as a renderer sends it back. `itemId` names the item
 * the action sits on; absent for a section-level action.
 */
export interface CommandApplyRequest {
    command: string;
    sectionId: string;
    itemId?: string;
    actionId: string;
    values?: KnobValues;
    /** True once the user confirmed an action that carries a confirmation. */
    confirmed?: boolean;
    sessionId?: string;
}
/** The outcome of an apply: a message for the user and the refreshed menu. */
export interface CommandApplyResult {
    command: string;
    ok: boolean;
    text: string;
    /**
     * A stable code naming why the apply failed; present on every failure.
     * The library's own codes are `unavailable`, `needs-confirmation`,
     * `invalid-input`, `refused`, `action-failed` and `pool-<store failure
     * kind>`; a plugin's `CommandError` or `ActionOutcome` names its own.
     */
    code?: string;
    /** True when the action was refused only for want of a confirmation. */
    needsConfirmation?: boolean;
    menu: CommandMenuModel;
}
export type NotifyKind = 'info' | 'warning' | 'error';
/**
 * The per-invocation context of one slash-command call. The library reads
 * both fields once, when the call starts, and keeps that copy for any work
 * the call leaves running (a login completing later, for example), so a host
 * that reuses one context object across sessions cannot reroute feedback.
 */
export interface CommandInvocation {
    sessionId?: string;
    notify(message: string, kind?: NotifyKind): void;
}
export interface ActionOutcome {
    ok: boolean;
    text: string;
    /** The failure's stable code; a failure without one is `refused`. */
    code?: string;
}
export interface ActionInput {
    values: KnobValues;
    /** The item the action sits on; absent for a section-level action. */
    itemId?: string;
    invocation: CommandInvocation;
}
type ActionBase = {
    id: string;
    label: string;
    description?: string;
    /** The header a section-level action is listed under; see `MenuSection`. */
    group?: string;
    knobs?: MenuKnob[];
    run(input: ActionInput): Promise<string | ActionOutcome>;
};
/**
 * An action and its body. An irreversible action must name its
 * confirmation; a reversible one may.
 */
export type ActionDefinition = ActionBase & ({
    irreversible: true;
    confirm: string;
} | {
    irreversible?: false;
    confirm?: string;
});
export interface ItemDefinition {
    id: string;
    label: string;
    detail?: string;
    /** The header the item is listed under; see `MenuSection`. */
    group?: string;
    /** A short value shown right-aligned beside the label. */
    status?: string;
    facts?: Record<string, unknown>;
    actions?: ActionDefinition[];
}
export interface SectionContent {
    /** Read-only text; renderers never make a line selectable. */
    lines?: string[];
    items?: ItemDefinition[];
    actions?: ActionDefinition[];
    facts?: Record<string, unknown>;
}
/** A section a plugin supplies for one of its slots. */
export interface PluginSection {
    title: string;
    build(invocation: CommandInvocation): SectionContent | Promise<SectionContent>;
}
/** A provider extra: a plugin section shown after the fixed slots. */
export interface PluginExtraSection extends PluginSection {
    id: string;
}
export {};
