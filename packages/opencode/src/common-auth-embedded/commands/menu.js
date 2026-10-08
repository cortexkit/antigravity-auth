// One slash command per plugin: the menu a plugin creates once and serves to
// every invocation. It keeps no per-invocation state; each `open` and `apply`
// builds its sections afresh from the store and gets its own copy of the
// caller's context.
import { createLogger } from '../logger/index.js';
import { builtinSections, } from './builtins.js';
import { applyResult, confirmationOf, createTextRedactor, dialogPayload, projectFailure, } from './seam.js';
const BUILTIN_IDS = new Set([
    'accounts',
    'quota',
    'routing',
    'limits',
    'cache',
    'diagnostics',
]);
const STORE_SLOTS = [
    'accounts',
    'quota',
    'routing',
    'limits',
];
/**
 * A private copy of the caller's context, taken before the first await. Work
 * an invocation leaves running reports through this copy, so a host that
 * reuses and rebinds one context object for the next session cannot pull an
 * earlier invocation's feedback over to it.
 */
function ownInvocation(invocation, redact) {
    const { sessionId } = invocation;
    const notify = invocation.notify.bind(invocation);
    // A notification leaves the process just as a payload does, so its text
    // goes through the same redactor.
    return Object.freeze({
        ...(sessionId !== undefined ? { sessionId } : {}),
        notify: (message, kind) => kind === undefined
            ? notify(redact(String(message)))
            : notify(redact(String(message)), kind),
    });
}
function coerceOne(knob, raw) {
    switch (knob.kind) {
        case 'choice': {
            const value = raw ?? knob.value;
            if (typeof value === 'string' &&
                knob.choices.some((choice) => choice.value === value))
                return { value };
            return { problem: `Choose one of the options for ${knob.label}.` };
        }
        case 'toggle': {
            const value = raw ?? knob.value;
            return typeof value === 'boolean'
                ? { value }
                : { problem: `${knob.label} must be on or off.` };
        }
        case 'number': {
            const value = raw === undefined ? (knob.value ?? null) : raw;
            if (value === null || value === '') {
                return knob.required
                    ? { problem: `${knob.label} needs a number.` }
                    : { value: null };
            }
            const number = typeof value === 'number' ? value : Number(value);
            if (typeof value === 'boolean' || !Number.isFinite(number))
                return { problem: `${knob.label} needs a number.` };
            if (knob.min !== undefined && number < knob.min)
                return { problem: `${knob.label} must be at least ${knob.min}.` };
            if (knob.max !== undefined && number > knob.max)
                return { problem: `${knob.label} must be at most ${knob.max}.` };
            return { value: number };
        }
        case 'text': {
            const value = raw === undefined ? (knob.value ?? null) : raw;
            if (value === null || value === '')
                return knob.required
                    ? { problem: `${knob.label} cannot be empty.` }
                    : { value: null };
            return typeof value === 'string'
                ? { value }
                : { problem: `${knob.label} must be text.` };
        }
    }
}
/** The action's inputs, checked against its knobs; unknown names are ignored. */
function coerceValues(knobs, raw) {
    const values = {};
    for (const knob of knobs) {
        const given = raw && Object.hasOwn(raw, knob.id) ? raw[knob.id] : undefined;
        const result = coerceOne(knob, given);
        if ('problem' in result)
            return result;
        values[knob.id] = result.value;
    }
    return { values };
}
function findAction(sections, request) {
    const section = sections.find((entry) => entry.id === request.sectionId);
    if (!section)
        return undefined;
    const actions = request.itemId === undefined
        ? section.content.actions
        : section.content.items?.find((item) => item.id === request.itemId)
            ?.actions;
    return actions?.find((action) => action.id === request.actionId);
}
export function createCommandMenu(options) {
    const logger = options.logger ?? createLogger('commands');
    const redact = createTextRedactor(options.redaction);
    const seam = { logger, redact };
    const now = options.now ?? Date.now;
    const extras = options.extras ?? [];
    const replaced = options.replace ?? {};
    const builtSlots = STORE_SLOTS.filter((slot) => !replaced[slot]);
    for (const slot of STORE_SLOTS) {
        if (replaced[slot] && options[slot] !== undefined)
            throw new Error(`the ${slot} section is replaced; its built-in options cannot also be given`);
    }
    const store = options.store;
    if (builtSlots.length > 0 && !store)
        throw new Error(`a store is required for the built-in ${builtSlots.join(', ')} section${builtSlots.length > 1 ? 's' : ''}`);
    const seen = new Set();
    for (const extra of extras) {
        if (BUILTIN_IDS.has(extra.id) || seen.has(extra.id))
            throw new Error(`extra section id ${extra.id} is taken`);
        seen.add(extra.id);
    }
    async function plugin(id, slot, section, invocation) {
        try {
            return {
                id,
                slot,
                title: section.title,
                content: await section.build(invocation),
            };
        }
        catch (error) {
            // One broken plugin section must not take the whole menu down.
            logger.warn('command menu section failed to build', {
                command: options.command,
                section: id,
                error: redact(error instanceof Error ? error.message : String(error)),
            });
            return {
                id,
                slot,
                title: section.title,
                content: { lines: ['This section could not be loaded.'] },
            };
        }
    }
    /** Every section, in the fixed slot order. */
    async function sections(invocation) {
        // Built-in sections read the store once; a fully replaced menu never
        // touches it.
        const built = store && builtSlots.length > 0
            ? await builtinSections({
                store,
                now,
                ...(options.extraLocks ? { extraLocks: options.extraLocks } : {}),
                ...(options.accounts ? { accounts: options.accounts } : {}),
                ...(options.quota ? { quota: options.quota } : {}),
                ...(options.routing ? { routing: options.routing } : {}),
                ...(options.limits ? { limits: options.limits } : {}),
            })
            : [];
        const out = [];
        for (const slot of STORE_SLOTS) {
            const replacement = replaced[slot];
            if (replacement)
                out.push(await plugin(slot, slot, replacement, invocation));
            else {
                const section = built.find((entry) => entry.slot === slot);
                if (section)
                    out.push(section);
            }
        }
        if (options.cache)
            out.push(await plugin('cache', 'cache', options.cache, invocation));
        if (options.diagnostics)
            out.push(await plugin('diagnostics', 'diagnostics', options.diagnostics, invocation));
        for (const extra of extras)
            out.push(await plugin(extra.id, 'extra', extra, invocation));
        return out;
    }
    return {
        command: options.command,
        async open(invocation) {
            const own = ownInvocation(invocation, redact);
            return dialogPayload(options.command, options.title, await sections(own), seam);
        },
        async apply(request, invocation) {
            const own = ownInvocation(invocation, redact);
            const finish = async (outcome) => applyResult(options.command, options.title, await sections(own), outcome, seam);
            const action = request.command === options.command
                ? findAction(await sections(own), request)
                : undefined;
            if (!action)
                return finish({
                    ok: false,
                    code: 'unavailable',
                    text: 'That action is no longer available.',
                });
            const confirmation = confirmationOf(action);
            if (confirmation && request.confirmed !== true)
                return finish({
                    ok: false,
                    code: 'needs-confirmation',
                    text: confirmation.message,
                    needsConfirmation: true,
                });
            const coerced = coerceValues(action.knobs ?? [], request.values);
            if ('problem' in coerced)
                return finish({
                    ok: false,
                    code: 'invalid-input',
                    text: coerced.problem,
                });
            let outcome;
            try {
                const result = await action.run({
                    values: coerced.values,
                    ...(request.itemId !== undefined ? { itemId: request.itemId } : {}),
                    invocation: own,
                });
                outcome =
                    typeof result === 'string'
                        ? { ok: true, text: result }
                        : {
                            ok: result.ok,
                            text: result.text,
                            ...(result.ok ? {} : { code: result.code ?? 'refused' }),
                        };
            }
            catch (error) {
                // The raw text goes only to the log (redacted); the user sees the
                // projected code and message, never the exception's own words.
                const failure = projectFailure(error);
                logger.warn('command menu action failed', {
                    command: options.command,
                    section: request.sectionId,
                    action: request.actionId,
                    code: failure.code,
                    error: redact(error instanceof Error ? error.message : String(error)),
                });
                outcome = { ok: false, ...failure };
            }
            return finish(outcome);
        },
    };
}
function isKnobValue(value) {
    return (value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)));
}
/**
 * Checks an apply request that arrived over the loopback RPC; undefined when
 * it is not one. Only the request's own fields are kept.
 */
export function parseApplyRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    if (typeof raw.command !== 'string' ||
        typeof raw.sectionId !== 'string' ||
        typeof raw.actionId !== 'string')
        return undefined;
    if (raw.itemId !== undefined && typeof raw.itemId !== 'string')
        return undefined;
    if (raw.sessionId !== undefined && typeof raw.sessionId !== 'string')
        return undefined;
    if (raw.confirmed !== undefined && typeof raw.confirmed !== 'boolean')
        return undefined;
    const values = {};
    if (raw.values !== undefined) {
        if (raw.values === null ||
            typeof raw.values !== 'object' ||
            Array.isArray(raw.values))
            return undefined;
        for (const [name, entry] of Object.entries(raw.values)) {
            if (!isKnobValue(entry))
                return undefined;
            Object.defineProperty(values, name, {
                value: entry,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
    }
    return {
        command: raw.command,
        sectionId: raw.sectionId,
        actionId: raw.actionId,
        ...(typeof raw.itemId === 'string' ? { itemId: raw.itemId } : {}),
        ...(raw.values !== undefined ? { values } : {}),
        ...(raw.confirmed === true ? { confirmed: true } : {}),
        ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    };
}
