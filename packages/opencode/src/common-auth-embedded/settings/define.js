import { deepFreeze, isJsonObject, validateValue, } from './descriptors.js';
export function defineSettings(definition) {
    for (const [name, declaration] of Object.entries(definition.settings)) {
        if (name === 'schema_version' || name === '$schema') {
            throw new TypeError(`Reserved setting name: ${name}`);
        }
        if (!/^[a-z][a-z0-9_]*$/.test(name) || /\s/.test(name)) {
            throw new TypeError(`Setting name must be snake_case: ${name}`);
        }
        if (name === 'sidebar' && declaration.value.kind !== 'object') {
            throw new TypeError('The sidebar setting must use an object descriptor');
        }
        if (declaration.overrides !== undefined &&
            (declaration.value.kind === 'object' ||
                declaration.value.kind === 'record')) {
            throw new TypeError(`Object and record settings cannot use overrides: ${name}`);
        }
        if (!Object.hasOwn(declaration, 'default') ||
            !validateValue(declaration.value, declaration.default, {
                completeObjects: true,
            })) {
            throw new TypeError(`Invalid default for setting: ${name}`);
        }
    }
    // Copy before freezing so the caller can still use its original default values.
    return deepFreeze({
        plugin: definition.plugin,
        settings: Object.fromEntries(Object.entries(definition.settings).map(([name, declaration]) => [
            name,
            structuredClone({
                ...declaration,
                project: declaration.project ?? 'user-only',
            }),
        ])),
    });
}
/** Internal helper: host names are reserved and never count as model ids. */
export function isOverrideKeyAllowed(overrides, key) {
    if (key === 'default')
        return true;
    if (key === 'opencode' || key === 'pi')
        return overrides.host === true;
    return overrides.model === true;
}
/** Validate a file, update or map value, including any permitted override object. */
export function validateSettingValue(declaration, value, options = {}) {
    if (declaration.overrides !== undefined && isJsonObject(value)) {
        return Object.entries(value).every(([key, entry]) => isOverrideKeyAllowed(declaration.overrides ?? {}, key) &&
            validateValue(declaration.value, entry, options));
    }
    return validateValue(declaration.value, value, options);
}
