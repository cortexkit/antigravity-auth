import { confirm } from './confirm.js';
import { select } from './select.js';
import { isInteractive, printLine, processTerminal, } from './terminal.js';
export function menuContext(terminal) {
    const interactive = isInteractive(terminal);
    return {
        terminal,
        interactive,
        print: (line) => printLine(terminal, line),
        confirm: (message, defaultYes) => confirm(terminal, message, defaultYes),
        select: async (items, options) => interactive && items.length > 0 ? select(terminal, items, options) : null,
    };
}
function printPlainMenu(context, options) {
    context.print(options.title);
    if (options.subtitle)
        context.print(options.subtitle);
    for (const line of options.status ?? [])
        context.print(`  ${line}`);
    context.print('');
    context.print('Actions:');
    for (const action of options.actions) {
        context.print(action.hint
            ? `  - ${action.label} (${action.hint})`
            : `  - ${action.label}`);
    }
    context.print('');
    context.print('This menu needs an interactive terminal to choose an action; nothing was changed.');
    return { status: 'not-interactive' };
}
/**
 * Show the full-screen menu once and run the chosen action. Without an
 * interactive terminal it prints the same content as a plain list and runs
 * nothing, so a piped or scripted login exits cleanly instead of hanging on
 * a key that never comes. An action's failure is printed and reported rather
 * than thrown, because the caller still owes the host its result.
 */
export async function runMenu(options) {
    const terminal = options.terminal ?? processTerminal();
    const context = menuContext(terminal);
    if (!context.interactive)
        return printPlainMenu(context, options);
    if (options.actions.length === 0) {
        context.print('No actions are available.');
        return { status: 'cancelled' };
    }
    const chosen = await select(terminal, options.actions.map((action) => ({
        label: action.label,
        value: action,
        color: action.destructive ? 'red' : 'cyan',
        ...(action.hint ? { hint: action.hint } : {}),
    })), {
        message: options.title,
        subtitle: options.subtitle ?? 'Select an account action',
        ...(options.status ? { lines: options.status } : {}),
        clearScreen: true,
    });
    if (!chosen)
        return { status: 'cancelled' };
    if (chosen.destructive &&
        !(await context.confirm(chosen.confirm ?? `${chosen.label}?`))) {
        context.print('Cancelled; nothing was changed.');
        return { status: 'declined', action: chosen.id };
    }
    try {
        await chosen.run(context);
        return { status: 'ran', action: chosen.id };
    }
    catch (error) {
        context.print(`${chosen.label} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { status: 'failed', action: chosen.id, error };
    }
}
