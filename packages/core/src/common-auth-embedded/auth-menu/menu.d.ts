import { type MenuItem, type SelectOptions } from './select.js';
import { type MenuTerminal } from './terminal.js';
/** What an action is given to talk to the operator. */
export interface MenuContext {
    terminal: MenuTerminal;
    /** Whether keys can be read; false when the menu printed a plain list. */
    interactive: boolean;
    print(line?: string): void;
    /** A yes/no question; false on a terminal that cannot take keys. */
    confirm(message: string, defaultYes?: boolean): Promise<boolean>;
    /** A list choice; null on cancel or on a terminal that cannot take keys. */
    select<T>(items: readonly MenuItem<T>[], options: SelectOptions): Promise<T | null>;
}
export interface MenuAction {
    id: string;
    label: string;
    hint?: string;
    /**
     * Shown in red and run only after the operator answers yes to `confirm`
     * (or "<label>?"). An action that first asks which account to act on
     * leaves this unset and confirms through its context once it knows.
     */
    destructive?: boolean;
    confirm?: string;
    run(context: MenuContext): void | Promise<void>;
}
export interface RunMenuOptions {
    title: string;
    subtitle?: string;
    /** Lines shown above the actions, such as the accounts and their state. */
    status?: readonly string[];
    actions: readonly MenuAction[];
    /** Defaults to the current process's terminal. */
    terminal?: MenuTerminal;
}
export type MenuOutcome = {
    status: 'ran';
    action: string;
} | {
    status: 'declined';
    action: string;
} | {
    status: 'failed';
    action: string;
    error: unknown;
} | {
    status: 'cancelled';
} | {
    status: 'not-interactive';
};
export declare function menuContext(terminal: MenuTerminal): MenuContext;
/**
 * Show the full-screen menu once and run the chosen action. Without an
 * interactive terminal it prints the same content as a plain list and runs
 * nothing, so a piped or scripted login exits cleanly instead of hanging on
 * a key that never comes. An action's failure is printed and reported rather
 * than thrown, because the caller still owes the host its result.
 */
export declare function runMenu(options: RunMenuOptions): Promise<MenuOutcome>;
