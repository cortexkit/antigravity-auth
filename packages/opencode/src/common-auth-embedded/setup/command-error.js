import { redact } from '../logger/redact.js';
import { STDERR_TAIL_MAX_BYTES } from './command-runner.js';
import { enrollmentAccessLines } from './enrollment-access.js';
const PI_INSTALL_ERROR_MESSAGE = 'Pi install failed; run pi install after checking your npm connection.';
function utf8Tail(value) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= STDERR_TAIL_MAX_BYTES)
        return value;
    let start = bytes.length - STDERR_TAIL_MAX_BYTES;
    while (start < bytes.length) {
        const byte = bytes[start];
        if (byte === undefined || (byte & 0xc0) !== 0x80)
            break;
        start++;
    }
    return bytes.subarray(start).toString('utf8');
}
function dropPartialLine(tail) {
    const newline = tail.indexOf('\n');
    return newline < 0 ? '' : tail.slice(newline + 1);
}
/**
 * Keeps the Pi install refusal message stable while exposing safe process details.
 * A clipped tail can start inside a credential, so discard its first line—or
 * the whole tail if it has no newline—before redacting.
 */
export class SetupCommandError extends Error {
    step = 'pi-install';
    exitCode;
    signal;
    stderrTail;
    constructor(details) {
        super(PI_INSTALL_ERROR_MESSAGE);
        this.name = 'SetupCommandError';
        this.exitCode = details.exitCode;
        this.signal = details.signal;
        const tail = details.stderrTruncated
            ? dropPartialLine(details.stderrTail)
            : details.stderrTail;
        const redacted = redact(tail);
        this.stderrTail = utf8Tail(typeof redacted === 'string' ? redacted : '');
    }
}
const HOST_LABELS = { opencode: 'OpenCode', pi: 'Pi' };
const OUTCOME_TEXT = {
    enrolled: 'connected to the vault',
    'not-enrolled': 'not connected',
    unknown: 'unknown, check with ck auth status',
};
/** The line setup prints for one host's outcome, e.g. `Pi: not connected`. */
export function setupEnrollmentLine({ host, outcome, access }, grantFallback = 'setup') {
    const lines = access ? enrollmentAccessLines(access, grantFallback) : [];
    return `${HOST_LABELS[host]}: ${OUTCOME_TEXT[outcome]}${lines.length ? ` — ${lines.join('\n')}` : ''}`;
}
// Outcomes recorded against the value a failed `runSetup` threw. A WeakMap
// keeps the thrown value itself untouched: setup never reads, rewrites or
// stringifies what a step or plugin callback threw, so a getter, a proxy or a
// frozen error behaves exactly as it would without setup in between, and
// callers that classify errors by message see the original text.
const recordedEnrollment = new WeakMap();
/**
 * Remember which hosts a failed setup left connected to the vault, against the
 * thrown value. Only objects can carry a record; a thrown primitive is left as
 * it is, and the printed lines are then the only report.
 */
export function recordSetupEnrollment(failure, enrollment) {
    if ((typeof failure !== 'object' && typeof failure !== 'function') ||
        !failure)
        return;
    recordedEnrollment.set(failure, Object.freeze(enrollment.map((entry) => Object.freeze({ ...entry }))));
}
/**
 * The per-host vault enrollment outcomes a failed `runSetup` recorded for the
 * value it threw, or `undefined` when setup failed before any host's enrollment
 * began, or the value is not one setup threw (or is not an object).
 */
export function setupEnrollment(error) {
    if ((typeof error !== 'object' && typeof error !== 'function') || !error)
        return undefined;
    return recordedEnrollment.get(error);
}
