// The Pi renderer: walks the same menu model the OpenCode dialog draws, with
// Pi's extension UI (`select`, `confirm`, `input`, `notify`). It sees only the
// payloads the menu's seam produces, and applies actions through the menu,
// so the confirmation and input checks are the same as on OpenCode.
/**
 * Shows `entries` with `select` and returns the chosen value. Labels are made
 * unique, since `select` answers with the label.
 */
async function pick(ui, title, entries) {
    const byLabel = new Map();
    const labels = [];
    for (const entry of entries) {
        let label = entry.label;
        for (let n = 2; byLabel.has(label); n++)
            label = `${entry.label} (${n})`;
        byLabel.set(label, entry.value);
        labels.push(label);
    }
    const chosen = await ui.select(title, labels);
    return chosen === undefined ? undefined : byLabel.get(chosen);
}
function withLines(title, lines) {
    return lines.length > 0 ? `${title}\n${lines.join('\n')}` : title;
}
function itemTitle(item) {
    const lines = item.detail ? [item.detail] : [];
    for (const [name, value] of Object.entries(item.facts ?? {}))
        lines.push(`${name}: ${String(value)}`);
    return withLines(item.label, lines);
}
/** One knob's value, or undefined when the user backed out or typed nonsense. */
async function askKnob(ui, knob) {
    switch (knob.kind) {
        case 'choice': {
            const value = await pick(ui, knob.label, knob.choices.map((choice) => ({
                label: choice.value === knob.value
                    ? `${choice.label} (current)`
                    : choice.label,
                value: choice.value,
            })));
            return value === undefined ? undefined : { value };
        }
        case 'toggle': {
            const value = await pick(ui, knob.label, [
                { label: knob.value ? 'On (current)' : 'On', value: true },
                { label: knob.value ? 'Off' : 'Off (current)', value: false },
            ]);
            return value === undefined ? undefined : { value };
        }
        case 'number': {
            const range = knob.min !== undefined && knob.max !== undefined
                ? ` (${knob.min}-${knob.max}${knob.required ? '' : ', empty clears'})`
                : knob.required
                    ? ''
                    : ' (empty clears)';
            const typed = await ui.input(`${knob.label}${range}`, knob.value !== undefined ? String(knob.value) : undefined);
            if (typed === undefined)
                return undefined;
            const text = typed.trim();
            if (text === '')
                return knob.required && knob.value !== undefined
                    ? { value: knob.value }
                    : { value: null };
            const number = Number(text);
            if (!Number.isFinite(number)) {
                ui.notify(`${knob.label} needs a number.`, 'error');
                return undefined;
            }
            return { value: number };
        }
        case 'text': {
            const typed = await ui.input(knob.label, knob.value ?? knob.placeholder);
            if (typed === undefined)
                return undefined;
            const text = typed.trim();
            if (text === '')
                return knob.required && knob.value !== undefined
                    ? { value: knob.value }
                    : { value: null };
            return { value: text };
        }
    }
}
async function askValues(ui, action) {
    const values = {};
    for (const knob of action.knobs) {
        const answer = await askKnob(ui, knob);
        if (!answer)
            return undefined;
        values[knob.id] = answer.value;
    }
    return values;
}
/**
 * Runs one invocation of the slash command on Pi: sections, then an item or
 * a section action, then the action's inputs and confirmation; after each
 * apply the user is back in the same section with the refreshed menu. Backing
 * out of the section list ends the invocation.
 */
export async function runPiCommandMenu(menu, ui, options = {}) {
    const invocation = {
        ...(options.sessionId !== undefined
            ? { sessionId: options.sessionId }
            : {}),
        notify: (message, kind) => ui.notify(message, kind),
    };
    let model = (await menu.open(invocation)).menu;
    for (;;) {
        const chosen = await pick(ui, model.title, model.sections.map((section) => ({
            label: section.lines[0]
                ? `${section.title}: ${section.lines[0]}`
                : section.title,
            value: section.id,
        })));
        if (chosen === undefined)
            return;
        for (;;) {
            const section = model.sections.find((entry) => entry.id === chosen);
            if (!section)
                break;
            const entries = [
                ...section.items.map((item) => ({
                    label: item.detail ? `${item.label}: ${item.detail}` : item.label,
                    value: { kind: 'item', item },
                })),
                ...section.actions.map((action) => ({
                    label: action.label,
                    value: { kind: 'action', action },
                })),
            ];
            if (entries.length === 0) {
                ui.notify(section.lines.join('\n') || 'Nothing to do here.');
                break;
            }
            const choice = await pick(ui, withLines(section.title, section.lines), entries);
            if (!choice)
                break;
            let action;
            let item;
            if (choice.kind === 'item') {
                item = choice.item;
                if (item.actions.length === 0) {
                    ui.notify(itemTitle(item));
                    continue;
                }
                action = await pick(ui, itemTitle(item), item.actions.map((entry) => ({ label: entry.label, value: entry })));
                if (!action)
                    continue;
            }
            else {
                action = choice.action;
            }
            const values = await askValues(ui, action);
            if (!values)
                continue;
            if (action.confirm) {
                const yes = await ui.confirm(action.label, action.confirm.message);
                if (!yes) {
                    ui.notify('Cancelled.');
                    continue;
                }
            }
            const result = await menu.apply({
                command: model.command,
                sectionId: section.id,
                ...(item ? { itemId: item.id } : {}),
                actionId: action.id,
                values,
                ...(action.confirm ? { confirmed: true } : {}),
                ...(options.sessionId !== undefined
                    ? { sessionId: options.sessionId }
                    : {}),
            }, invocation);
            ui.notify(result.text, result.ok ? 'info' : 'error');
            model = result.menu;
        }
    }
}
