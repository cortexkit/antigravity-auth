import { type MenuTerminal } from './terminal.js';
export interface MenuItem<T = string> {
    label: string;
    value: T;
    color?: 'red' | 'cyan';
    /** Dim text shown after the label, such as an account's state. */
    hint?: string;
}
export interface SelectOptions {
    message: string;
    subtitle?: string;
    /** Lines shown between the subtitle and the items, such as status lines. */
    lines?: readonly string[];
    clearScreen?: boolean;
}
/**
 * Render a bounded, keyboard-only terminal selector without a prompt
 * dependency. Resolves the chosen value, or null on Escape, Ctrl-C, a signal,
 * or a terminal that refuses raw mode.
 */
export declare function select<T>(terminal: MenuTerminal, items: readonly MenuItem<T>[], options: SelectOptions): Promise<T | null>;
