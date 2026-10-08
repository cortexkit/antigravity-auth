// The one way out of the process for anything the command menu shows. Every
// payload a renderer receives (the dialog payload and every apply result) is
// produced here: each part is projected field by field from its definition,
// so action bodies and stray properties never travel, and the whole payload
// is then scrubbed as a backstop: credential-shaped property names are
// dropped and every string value is passed through the redactor. Nothing
// outside this module can build a payload without passing through
// `dialogPayload` or `applyResult`. A failed action never shows its raw
// exception text: `projectFailure` turns it into a stable code and a message
// the library or the plugin wrote for the user.
import { createRedactor } from '../logger/index.js';
import { PoolOperationError } from '../store/index.js';
/**
 * Secret shapes the seam masks on top of the logger's (bearer tokens, `sk-`
 * keys, JWTs, vault host tokens): a value assigned to a secret-named field
 * (`client_secret=…`, `"api_key": "…"`, `Authorization: …`), and a run of 32
 * or more hex digits, the shape of a minted request secret. A plugin adds its
 * provider's key shapes through `RedactionOptions.extraValuePatterns`.
 */
const SEAM_VALUE_PATTERNS = [
    /\b[\w-]*(?:secret|token|password|passwd|api[_-]?key|authorization|verifier)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?[^\s"'&,;}]+/gi,
    /\b[0-9a-fA-F]{32,}\b/g,
];
/** The string redactor every value crossing the seam goes through. */
export function createTextRedactor(options = {}) {
    const { redactStrings } = createRedactor({
        ...options,
        extraValuePatterns: [
            ...SEAM_VALUE_PATTERNS,
            ...(options.extraValuePatterns ?? []),
        ],
    });
    return (text) => redactStrings(text);
}
/**
 * A failure whose message was written for the user. An action throws it to
 * show `message` with the stable `code`; any other thrown value is shown only
 * as a generic message, because its text may quote a request, a response or
 * a credential. `code` is lowercase letters, digits and dashes; anything else
 * is reported as `action-failed`.
 */
export class CommandError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'CommandError';
        this.code = code;
    }
}
const CODE_SHAPE = /^[a-z][a-z0-9-]{0,63}$/;
/** The code and message shown for an exception the seam cannot vouch for. */
export const ACTION_FAILED = {
    code: 'action-failed',
    text: 'That action failed.',
};
/**
 * Store failure kinds whose message the store composes itself from row ids
 * and the plugin's own refusal reasons (`protect`). Other kinds can carry a
 * lock or filesystem error's text, or an arbitrary exception from a hook, so
 * they show a generic message with the kind as the code.
 */
const STORE_KINDS_WITH_OWN_MESSAGE = new Set([
    'unknown-row',
    'invalid-row',
    'invalid-input',
    'id-exists',
    'id-removed',
    'type-mismatch',
    'no-credential',
    'row-disabled',
    'row-protected',
    'duplicate-identity',
    'row-key-changed',
    'invalid-order',
    'pending-migration',
    'provider',
    'pull',
    'attribution',
]);
/** The code and display text for a thrown value; never its raw text. */
export function projectFailure(error) {
    if (error instanceof CommandError)
        return {
            code: CODE_SHAPE.test(error.code) ? error.code : ACTION_FAILED.code,
            text: error.message,
        };
    if (error instanceof PoolOperationError)
        return {
            code: `pool-${error.kind}`,
            text: STORE_KINDS_WITH_OWN_MESSAGE.has(error.kind)
                ? error.message
                : `The account pool could not do that (${error.kind}).`,
        };
    return ACTION_FAILED;
}
/** The confirmation shown when an irreversible action names none. */
export const DEFAULT_IRREVERSIBLE_CONFIRMATION = 'This cannot be undone. Continue?';
const CREDENTIAL_NAMES = new Set([
    'access',
    'refresh',
    'apikey',
    'password',
    'authheader',
    'credential',
    'credentials',
]);
/**
 * True for a property name that looks like it holds a secret. Case, `-` and
 * `_` are ignored, so `api_key`, `API-Key` and `apiKey` all match. Any name
 * ending in `token`, `key` or `secret` matches: no menu field is named that
 * way, so a match is a leak whatever the rest of the name says.
 */
function isCredentialName(name) {
    const normalized = name.toLowerCase().replace(/[-_]/g, '');
    return (CREDENTIAL_NAMES.has(normalized) ||
        normalized.endsWith('token') ||
        normalized.endsWith('key') ||
        normalized.endsWith('secret'));
}
function isPlainRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * A copy of `value` without credential-shaped properties and with every
 * string redacted; the paths of both go to `report`.
 */
function scrub(value, path, report) {
    if (typeof value === 'string') {
        const clean = report.redact(value);
        if (clean !== value)
            report.redacted.push(path);
        return clean;
    }
    if (Array.isArray(value))
        return value.map((entry, index) => scrub(entry, `${path}[${index}]`, report));
    if (!isPlainRecord(value))
        return value;
    const out = {};
    for (const [name, entry] of Object.entries(value)) {
        if (isCredentialName(name)) {
            report.dropped.push(`${path}.${name}`);
            continue;
        }
        Object.defineProperty(out, name, {
            value: scrub(entry, `${path}.${name}`, report),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return out;
}
function sealed(payload, command, seam) {
    const report = {
        redact: seam.redact,
        dropped: [],
        redacted: [],
    };
    const clean = scrub(payload, 'payload', report);
    if (report.dropped.length > 0)
        seam.logger.warn('credential-shaped field dropped from a command payload', {
            command,
            fields: report.dropped,
        });
    if (report.redacted.length > 0)
        seam.logger.warn('secret-shaped text masked in a command payload', {
            command,
            fields: report.redacted,
        });
    return clean;
}
function projectChoice(choice) {
    return { value: String(choice.value), label: String(choice.label) };
}
function projectKnob(knob) {
    switch (knob.kind) {
        case 'choice':
            return {
                kind: 'choice',
                id: knob.id,
                label: knob.label,
                choices: (knob.choices ?? []).map(projectChoice),
                ...(knob.value !== undefined ? { value: knob.value } : {}),
            };
        case 'toggle':
            return {
                kind: 'toggle',
                id: knob.id,
                label: knob.label,
                value: knob.value === true,
            };
        case 'number':
            return {
                kind: 'number',
                id: knob.id,
                label: knob.label,
                ...(knob.value !== undefined ? { value: knob.value } : {}),
                ...(knob.min !== undefined ? { min: knob.min } : {}),
                ...(knob.max !== undefined ? { max: knob.max } : {}),
                ...(knob.required ? { required: true } : {}),
            };
        case 'text':
            // A masked input holds a secret, so its current value is never shown;
            // the action still receives it when the user leaves the input alone.
            return {
                kind: 'text',
                id: knob.id,
                label: knob.label,
                ...(knob.value !== undefined && !knob.masked
                    ? { value: knob.value }
                    : {}),
                ...(knob.placeholder !== undefined
                    ? { placeholder: knob.placeholder }
                    : {}),
                ...(knob.masked ? { masked: true } : {}),
                ...(knob.required ? { required: true } : {}),
            };
    }
}
/**
 * The confirmation an action must pass before it runs, or undefined. An
 * irreversible action always has one, even when its definition (built
 * outside the type checker) names none.
 */
export function confirmationOf(action) {
    if (action.irreversible === true)
        return {
            message: action.confirm || DEFAULT_IRREVERSIBLE_CONFIRMATION,
            irreversible: true,
        };
    if (action.confirm)
        return { message: action.confirm, irreversible: false };
    return undefined;
}
function projectAction(action) {
    const confirm = confirmationOf(action);
    return {
        id: action.id,
        label: action.label,
        ...(action.description !== undefined
            ? { description: action.description }
            : {}),
        knobs: (action.knobs ?? []).map(projectKnob),
        ...(confirm ? { confirm } : {}),
    };
}
/** The account fields a renderer may show; see `MenuAccount`. */
export function projectAccount(account) {
    return {
        id: account.id,
        ...(account.label !== undefined ? { label: account.label } : {}),
        enabled: account.enabled,
        type: account.type,
        ...(account.identity !== undefined ? { identity: account.identity } : {}),
    };
}
function projectItem(item) {
    return {
        id: item.id,
        label: item.label,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.account ? { account: projectAccount(item.account) } : {}),
        ...(item.facts !== undefined ? { facts: item.facts } : {}),
        actions: (item.actions ?? []).map(projectAction),
    };
}
function projectSection(section) {
    const { content } = section;
    return {
        id: section.id,
        slot: section.slot,
        title: section.title,
        lines: (content.lines ?? []).map(String),
        items: (content.items ?? []).map(projectItem),
        actions: (content.actions ?? []).map(projectAction),
        ...(content.facts !== undefined ? { facts: content.facts } : {}),
    };
}
function projectMenu(command, title, sections) {
    return { command, title, sections: sections.map(projectSection) };
}
/** The payload a host's TUI receives when the slash command opens. */
export function dialogPayload(command, title, sections, seam) {
    return sealed({ command, menu: projectMenu(command, title, sections) }, command, seam);
}
/** An apply's result: the message and the refreshed menu. */
export function applyResult(command, title, sections, outcome, seam) {
    return sealed({
        command,
        ok: outcome.ok,
        text: String(outcome.text),
        ...(!outcome.ok && outcome.code !== undefined
            ? { code: CODE_SHAPE.test(outcome.code) ? outcome.code : 'refused' }
            : {}),
        ...(outcome.needsConfirmation ? { needsConfirmation: true } : {}),
        menu: projectMenu(command, title, sections),
    }, command, seam);
}
