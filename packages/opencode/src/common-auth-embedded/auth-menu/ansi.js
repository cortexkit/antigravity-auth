/** ANSI controls used by the first-party auth menu. */
export const ANSI = {
    hide: '\x1b[?25l',
    show: '\x1b[?25h',
    up: (n = 1) => `\x1b[${n}A`,
    clearLine: '\x1b[2K',
    clearScreen: '\x1b[2J',
    moveTo: (row, col) => `\x1b[${row};${col}H`,
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
};
/** Tokenize complete keys in one read; incomplete escape sequences are ignored. */
export function parseKeys(data) {
    const value = data.toString();
    const keys = [];
    for (let index = 0; index < value.length;) {
        const char = value[index];
        if (char === '\x1b') {
            const sequence = value.slice(index, index + 3);
            const arrow = sequence[1] === '[' || sequence[1] === 'O' ? sequence[2] : undefined;
            if (arrow && 'ABCD'.includes(arrow)) {
                const action = { A: 'up', B: 'down', C: 'right', D: 'left' };
                const parsed = action[arrow];
                if (parsed)
                    keys.push(parsed);
                index += 3;
            }
            else if (index + 1 === value.length) {
                // Only a chunk consisting solely of ESC gets the legacy Escape timeout.
                if (index === 0)
                    keys.push('escape-start');
                index += 1;
            }
            else if ((value[index + 1] === '[' || value[index + 1] === 'O') &&
                index + 2 >= value.length) {
                // An incomplete escape prefix at the chunk boundary is not a key.
                break;
            }
            else {
                index += 1;
            }
            continue;
        }
        if (char === '\r' || char === '\n')
            keys.push('enter');
        else if (char === '\x03')
            keys.push('escape');
        else if (char && char >= ' ')
            keys.push('char');
        index += 1;
    }
    return keys;
}
/** Preserve the single-key parser for callers that only need the first token. */
export function parseKey(data) {
    return parseKeys(data)[0] ?? null;
}
const ANSI_PATTERN = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_REGEX = new RegExp(ANSI_PATTERN, 'g');
const ANSI_LEADING_REGEX = new RegExp(`^${ANSI_PATTERN}`);
/** Remove colour codes, leaving the text an operator sees. */
export function stripAnsi(input) {
    return input.replace(ANSI_REGEX, '');
}
/**
 * Shorten coloured text to a visible width without cutting an escape code in
 * half, resetting the colour before the ellipsis so it cannot bleed.
 */
export function truncateAnsi(input, maxVisibleChars) {
    if (maxVisibleChars <= 0)
        return '';
    if (stripAnsi(input).length <= maxVisibleChars)
        return input;
    const suffix = maxVisibleChars >= 3 ? '...' : '.'.repeat(maxVisibleChars);
    const keep = Math.max(0, maxVisibleChars - suffix.length);
    let output = '';
    let offset = 0;
    let visible = 0;
    while (offset < input.length && visible < keep) {
        if (input[offset] === '\x1b') {
            const match = input.slice(offset).match(ANSI_LEADING_REGEX);
            if (match) {
                output += match[0];
                offset += match[0].length;
                continue;
            }
        }
        output += input[offset];
        offset += 1;
        visible += 1;
    }
    return output.includes('\x1b[')
        ? `${output}${ANSI.reset}${suffix}`
        : output + suffix;
}
