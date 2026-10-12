/** The current process's terminal, with its signals. */
export function processTerminal() {
    return {
        input: process.stdin,
        output: process.stdout,
        signals: process,
    };
}
/**
 * Whether keys can be read one at a time. Only the input is checked, as the
 * plugins' menus always did: output piped to a file still gets the menu.
 */
export function isInteractive(terminal) {
    return terminal.input.isTTY === true;
}
/** Writes one line of plain output below the menu. */
export function printLine(terminal, line = '') {
    terminal.output.write(`${line}\n`);
}
