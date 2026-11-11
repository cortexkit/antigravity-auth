export function boolean() {
    return Object.freeze({ kind: 'boolean' });
}
export function integer({ min, max } = {}) {
    return Object.freeze({ kind: 'integer', min, max });
}
export function number({ min, max } = {}) {
    return Object.freeze({ kind: 'number', min, max });
}
export function string() {
    return Object.freeze({ kind: 'string' });
}
export function oneOf(values) {
    return Object.freeze({
        kind: 'oneOf',
        values: Object.freeze([...values]),
    });
}
export function list(item) {
    return deepFreeze({ kind: 'list', item });
}
export function object(fields) {
    return deepFreeze({ kind: 'object', fields: { ...fields } });
}
export function record(value) {
    return deepFreeze({ kind: 'record', value });
}
/** JSON objects exclude arrays and objects such as Date that serialize differently. */
export function isJsonObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
/** Missing fields can be filled from lower levels, but list and record objects must be complete. */
export function validateValue(descriptor, value, options = {}) {
    switch (descriptor.kind) {
        case 'boolean':
            return typeof value === 'boolean';
        case 'integer':
        case 'number':
            return (typeof value === 'number' &&
                Number.isFinite(value) &&
                (descriptor.kind !== 'integer' || Number.isInteger(value)) &&
                (descriptor.min === undefined || value >= descriptor.min) &&
                (descriptor.max === undefined || value <= descriptor.max));
        case 'string':
            return typeof value === 'string';
        case 'oneOf':
            return typeof value === 'string' && descriptor.values.includes(value);
        case 'list':
            return (Array.isArray(value) &&
                Array.from(value).every((item) => validateValue(descriptor.item, item, {
                    ...options,
                    completeObjects: true,
                })));
        case 'object':
            return (isJsonObject(value) &&
                Object.entries(value).every(([key, field]) => Object.hasOwn(descriptor.fields, key)
                    ? validateValue(descriptor.fields[key], field, options)
                    : options.allowUnknownFields === true) &&
                (!options.completeObjects ||
                    Object.keys(descriptor.fields).every((key) => Object.hasOwn(value, key))));
        case 'record':
            return (isJsonObject(value) &&
                Object.values(value).every((item) => validateValue(descriptor.value, item, {
                    ...options,
                    completeObjects: true,
                })));
    }
}
/** Internal helper; definitions and descriptor payloads are immutable at runtime. */
export function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
