import { ANSI, parseKeys, truncateAnsi } from './ansi.js';
import { isInteractive } from './terminal.js';
/** How long a lone Escape byte waits for the rest of an arrow-key sequence. */
const ESCAPE_TIMEOUT_MS = 50;
function colorCode(color) {
    if (color === 'red')
        return ANSI.red;
    if (color === 'cyan')
        return ANSI.cyan;
    return '';
}
/**
 * Render a bounded, keyboard-only terminal selector without a prompt
 * dependency. Resolves the chosen value, or null on Escape, Ctrl-C, a signal,
 * or a terminal that refuses raw mode.
 */
export async function select(terminal, items, options) {
    if (!isInteractive(terminal))
        throw new Error('Interactive select requires a TTY terminal');
    if (items.length === 0)
        throw new Error('No menu items provided');
    const { input: stdin, output: stdout, signals } = terminal;
    let cursor = 0;
    let escapeTimeout = null;
    let cleaned = false;
    let renderedLines = 0;
    const render = () => {
        const columns = stdout.columns ?? 80;
        const rows = stdout.rows ?? 24;
        const previousLines = renderedLines;
        if (options.clearScreen) {
            stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
        }
        else if (previousLines > 0) {
            stdout.write(ANSI.up(previousLines));
        }
        let lines = 0;
        const writeLine = (line) => {
            stdout.write(`${ANSI.clearLine}${line}\n`);
            lines += 1;
        };
        const extraLines = options.lines ?? [];
        const headerLines = 1 +
            (options.subtitle ? 3 : 0) +
            extraLines.length +
            (extraLines.length ? 1 : 0);
        const maxVisible = Math.max(1, Math.min(items.length, rows - headerLines - 2 - 1));
        const windowStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)));
        const visibleItems = items.slice(windowStart, windowStart + maxVisible);
        writeLine(`${ANSI.dim}┌  ${ANSI.reset}${truncateAnsi(options.message, Math.max(1, columns - 4))}`);
        if (options.subtitle) {
            writeLine(`${ANSI.dim}│${ANSI.reset}`);
            writeLine(`${ANSI.cyan}◆${ANSI.reset}  ${truncateAnsi(options.subtitle, Math.max(1, columns - 4))}`);
            writeLine('');
        }
        for (const line of extraLines) {
            writeLine(`${ANSI.cyan}│${ANSI.reset}  ${truncateAnsi(line, Math.max(1, columns - 4))}`);
        }
        if (extraLines.length)
            writeLine(`${ANSI.cyan}│${ANSI.reset}`);
        for (let offset = 0; offset < visibleItems.length; offset++) {
            const item = visibleItems[offset];
            if (!item)
                continue;
            const selected = windowStart + offset === cursor;
            const color = colorCode(item.color);
            let label = color
                ? `${selected ? '' : ANSI.dim}${color}${item.label}${ANSI.reset}`
                : selected
                    ? item.label
                    : `${ANSI.dim}${item.label}${ANSI.reset}`;
            if (item.hint)
                label += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
            label = truncateAnsi(label, Math.max(1, columns - 8));
            writeLine(selected
                ? `${ANSI.cyan}│${ANSI.reset}  ${ANSI.green}●${ANSI.reset} ${label}`
                : `${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}○${ANSI.reset} ${label}`);
        }
        const windowHint = visibleItems.length < items.length
            ? ` (${windowStart + 1}-${windowStart + visibleItems.length}/${items.length})`
            : '';
        writeLine(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}${truncateAnsi(`Up/Down to select | Enter: confirm | Esc: back${windowHint}`, Math.max(1, columns - 6))}${ANSI.reset}`);
        writeLine(`${ANSI.cyan}└${ANSI.reset}`);
        for (let extra = lines; extra < previousLines; extra++)
            writeLine('');
        renderedLines = lines;
    };
    return new Promise((resolve) => {
        const wasRaw = stdin.isRaw ?? false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            if (escapeTimeout)
                clearTimeout(escapeTimeout);
            stdin.removeListener('data', onKey);
            try {
                stdin.setRawMode(wasRaw);
                stdin.pause();
                stdout.write(ANSI.show);
            }
            catch { }
            signals?.removeListener('SIGINT', onSignal);
            signals?.removeListener('SIGTERM', onSignal);
        };
        const finish = (value) => {
            cleanup();
            resolve(value);
        };
        const onSignal = () => finish(null);
        const onKey = (data) => {
            for (const key of parseKeys(data)) {
                if (cleaned)
                    break;
                if (escapeTimeout) {
                    clearTimeout(escapeTimeout);
                    escapeTimeout = null;
                }
                switch (key) {
                    case 'up':
                        cursor = (cursor - 1 + items.length) % items.length;
                        render();
                        break;
                    case 'down':
                        cursor = (cursor + 1) % items.length;
                        render();
                        break;
                    case 'enter':
                        finish(items[cursor]?.value ?? null);
                        break;
                    case 'escape':
                        finish(null);
                        break;
                    case 'escape-start':
                        // A bare Escape byte is also the start of an arrow-key sequence
                        // that may arrive split across reads; only a lone one cancels.
                        escapeTimeout = setTimeout(() => finish(null), ESCAPE_TIMEOUT_MS);
                        break;
                    default:
                        break;
                }
            }
        };
        signals?.once('SIGINT', onSignal);
        signals?.once('SIGTERM', onSignal);
        try {
            stdin.setRawMode(true);
        }
        catch {
            cleanup();
            resolve(null);
            return;
        }
        stdin.resume();
        stdout.write(ANSI.hide);
        render();
        stdin.on('data', onKey);
    });
}
