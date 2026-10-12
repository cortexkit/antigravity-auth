/** ANSI controls used by the first-party auth menu. */
export declare const ANSI: {
    readonly hide: '\u001B[?25l';
    readonly show: '\u001B[?25h';
    readonly up: (n?: number) => string;
    readonly clearLine: '\u001B[2K';
    readonly clearScreen: '\u001B[2J';
    readonly moveTo: (row: number, col: number) => string;
    readonly cyan: '\u001B[36m';
    readonly green: '\u001B[32m';
    readonly red: '\u001B[31m';
    readonly dim: '\u001B[2m';
    readonly reset: '\u001B[0m';
};
export type KeyAction = 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'escape-start' | 'char' | null;
/** Tokenize complete keys in one read; incomplete escape sequences are ignored. */
export declare function parseKeys(data: Buffer | string): KeyAction[];
/** Preserve the single-key parser for callers that only need the first token. */
export declare function parseKey(data: Buffer | string): KeyAction;
/** Remove colour codes, leaving the text an operator sees. */
export declare function stripAnsi(input: string): string;
/**
 * Shorten coloured text to a visible width without cutting an escape code in
 * half, resetting the colour before the ellipsis so it cannot bleed.
 */
export declare function truncateAnsi(input: string, maxVisibleChars: number): string;
