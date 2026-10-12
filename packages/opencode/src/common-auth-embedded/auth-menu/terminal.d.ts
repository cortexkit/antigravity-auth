/**
 * The terminal the menu draws on and reads keys from. The process's own
 * stdin and stdout satisfy it; tests pass a scripted stand-in, so the full
 * key-in, frame-out path runs without a real TTY.
 */
export interface MenuTerminal {
    input: MenuInput;
    output: MenuOutput;
    /**
     * Where SIGINT and SIGTERM are heard while a selector holds raw mode, so a
     * kill restores the terminal. Defaults to nothing: raw mode turns Ctrl-C
     * into a key the selector already handles.
     */
    signals?: MenuSignals;
}
export interface MenuInput {
    /** True only on an interactive terminal; anything else gets a plain list. */
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    setRawMode(mode: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: 'data', listener: (data: Buffer | string) => void): unknown;
    removeListener(event: 'data', listener: (data: Buffer | string) => void): unknown;
}
export interface MenuOutput {
    write(text: string): unknown;
    readonly columns?: number;
    readonly rows?: number;
}
export interface MenuSignals {
    once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
/** The current process's terminal, with its signals. */
export declare function processTerminal(): MenuTerminal;
/**
 * Whether keys can be read one at a time. Only the input is checked, as the
 * plugins' menus always did: output piped to a file still gets the menu.
 */
export declare function isInteractive(terminal: MenuTerminal): boolean;
/** Writes one line of plain output below the menu. */
export declare function printLine(terminal: MenuTerminal, line?: string): void;
