import { select } from './select.js';
import { isInteractive } from './terminal.js';
/**
 * Ask a yes/no question. "No" is listed first unless `defaultYes`, so a
 * stray Enter declines. Escape, and a terminal that cannot take keys, count
 * as "No": nothing destructive runs without an explicit yes.
 */
export async function confirm(terminal, message, defaultYes = false) {
    if (!isInteractive(terminal))
        return false;
    const items = defaultYes
        ? [
            { label: 'Yes', value: true },
            { label: 'No', value: false },
        ]
        : [
            { label: 'No', value: false },
            { label: 'Yes', value: true },
        ];
    return (await select(terminal, items, { message })) ?? false;
}
