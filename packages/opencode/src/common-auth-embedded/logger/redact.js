const SECRET_KEY_EXACT = /^(authorization|x-api-key|cookie|set-cookie|refresh|access|token)$/i;
const TOKEN_VALUE = /\b(Bearer\s+[\w.-]+|sk-[\w-]+|eyJ[\w.-]+)\b|ckh_[A-Za-z0-9_-]{20,}/g;
const MASK = '***REDACTED***';
// How many errors deep a cause chain is followed. A chain this long is
// already unreadable in a log line, and an unbounded one (each cause a fresh
// object, so the cycle check never trips) must not grow the line forever.
const MAX_ERROR_DEPTH = 8;
// Error's own fields are non-enumerable, so a plain entry walk renders an
// Error as `{}` and the name, message and stack a plugin logged are lost.
// The tag check also recognises an Error from another realm (a worker or a
// vm context), whose prototype is not this realm's Error.
function isError(value) {
    return (value instanceof Error ||
        Object.prototype.toString.call(value) === '[object Error]');
}
export function createRedactor(options = {}) {
    const patterns = [TOKEN_VALUE, ...(options.extraValuePatterns ?? [])].map((pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
    function isSecretKey(key) {
        const normalized = key.toLowerCase().replace(/[-_]/g, '');
        return (SECRET_KEY_EXACT.test(key) ||
            normalized.includes('apikey') ||
            normalized.endsWith('secret') ||
            normalized.endsWith('password') ||
            (normalized.endsWith('token') && !normalized.endsWith('tokens')) ||
            !!options.extraSecretKeys?.(normalized));
    }
    // The fields every log reader wants first, then whatever else the error
    // carries as its own enumerable properties (which is all an Error rendered
    // as before). Every entry goes through the same key and string scrubbing as
    // any other object, so a token in a message or stack is still masked.
    function errorEntries(error) {
        const fields = error;
        const entries = [
            ['name', error.name],
            ['message', error.message],
            ['stack', error.stack],
        ];
        for (const key of ['code', 'status', 'cause'])
            if (fields[key] !== undefined)
                entries.push([key, fields[key]]);
        const listed = new Set(entries.map(([key]) => key));
        for (const entry of Object.entries(error))
            if (!listed.has(entry[0]))
                entries.push(entry);
        return entries;
    }
    function walk(value, keys, seen, errorDepth = 0) {
        if (typeof value === 'string') {
            return patterns.reduce((text, pattern) => text.replace(pattern, MASK), value);
        }
        if (!value || typeof value !== 'object')
            return value;
        if (seen.has(value))
            return '[Circular]';
        seen.add(value);
        try {
            if (Array.isArray(value))
                return value.map((item) => walk(item, keys, seen, errorDepth));
            const error = isError(value);
            if (error && errorDepth >= MAX_ERROR_DEPTH)
                return '[Truncated]';
            const childDepth = error ? errorDepth + 1 : errorDepth;
            // Define own properties so a diagnostic __proto__ key cannot change the output prototype.
            return Object.fromEntries((error ? errorEntries(value) : Object.entries(value)).map(([key, item]) => [
                key,
                keys && isSecretKey(key)
                    ? MASK
                    : walk(item, keys, seen, childDepth),
            ]));
        }
        finally {
            seen.delete(value);
        }
    }
    return {
        redact: (value) => walk(value, true, new WeakSet()),
        // Schema keys describe arguments, not credentials; only their string values are scrubbed.
        redactStrings: (value) => walk(value, false, new WeakSet()),
    };
}
const defaultRedactor = createRedactor();
export const redact = defaultRedactor.redact;
export const redactStrings = defaultRedactor.redactStrings;
