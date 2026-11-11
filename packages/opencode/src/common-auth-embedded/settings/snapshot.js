import { isOverrideKeyAllowed } from './define.js';
import { isJsonObject, validateValue, } from './descriptors.js';
import { defineSettingsKey } from './parse.js';
/** Validate all children even when a list or record will be skipped as a whole. */
function validateFileValue(descriptor, value, keyPath, completeObjects, unknownReason, report) {
    const invalid = () => {
        report(keyPath, 'invalid-value');
        return { valid: false };
    };
    if (descriptor.kind === 'object') {
        if (!isJsonObject(value))
            return invalid();
        const cleaned = {};
        let valid = true;
        for (const [key, field] of Object.entries(value)) {
            if (!Object.hasOwn(descriptor.fields, key)) {
                report([...keyPath, key], unknownReason);
                continue;
            }
            const result = validateFileValue(descriptor.fields[key], field, [...keyPath, key], completeObjects, unknownReason, report);
            if (result.valid)
                defineSettingsKey(cleaned, key, result.value);
            else
                valid = false;
        }
        if (completeObjects) {
            for (const key of Object.keys(descriptor.fields)) {
                if (!Object.hasOwn(value, key)) {
                    report([...keyPath, key], 'invalid-value');
                    valid = false;
                }
            }
        }
        // Partial objects keep valid siblings; resolution supplies skipped fields.
        return valid || !completeObjects
            ? { valid: true, value: cleaned }
            : { valid: false };
    }
    if (descriptor.kind === 'list') {
        if (!Array.isArray(value))
            return invalid();
        const cleaned = [];
        let valid = true;
        for (const [index, item] of value.entries()) {
            const result = validateFileValue(descriptor.item, item, [...keyPath, String(index)], true, unknownReason, report);
            if (result.valid)
                cleaned.push(result.value);
            else
                valid = false;
        }
        return valid ? { valid: true, value: cleaned } : { valid: false };
    }
    if (descriptor.kind === 'record') {
        if (!isJsonObject(value))
            return invalid();
        const cleaned = {};
        let valid = true;
        for (const [key, item] of Object.entries(value)) {
            const result = validateFileValue(descriptor.value, item, [...keyPath, key], true, unknownReason, report);
            if (result.valid)
                defineSettingsKey(cleaned, key, result.value);
            else
                valid = false;
        }
        return valid ? { valid: true, value: cleaned } : { valid: false };
    }
    return validateValue(descriptor, value) ? { valid: true, value } : invalid();
}
/** Validate all overrides now, including values for hosts not requested later. */
export function buildSettingsSnapshot(definition, file, parsed) {
    const entries = [];
    const reported = new Set();
    const report = (keyPath, reason) => {
        const identity = JSON.stringify([keyPath, reason]);
        if (reported.has(identity))
            return;
        reported.add(identity);
        entries.push({ file: { ...file }, keyPath: [...keyPath], reason });
    };
    const snapshot = {
        file: { ...file },
        settings: {},
        entries,
        schemaVersion: 1,
        newer: false,
        hasDuplicates: parsed.parseable && parsed.hasDuplicates,
        parsed,
    };
    if (!parsed.parseable) {
        report([], 'unparseable');
        return snapshot;
    }
    for (const keyPath of parsed.duplicateKeyPaths)
        report(keyPath, 'duplicate-key');
    const input = parsed.value;
    if (Object.hasOwn(input, 'schema_version')) {
        const version = input.schema_version;
        if (typeof version === 'number' &&
            Number.isInteger(version) &&
            version >= 1) {
            snapshot.schemaVersion = version;
            snapshot.newer = version > 1;
        }
        else {
            report(['schema_version'], 'invalid-schema-version');
        }
    }
    const unknownReason = snapshot.newer
        ? 'newer-version-key-ignored'
        : 'unknown-key';
    for (const [name, value] of Object.entries(input)) {
        if (name === 'schema_version' || name === '$schema')
            continue;
        if (!Object.hasOwn(definition.settings, name)) {
            report([name], unknownReason);
            continue;
        }
        const declaration = definition.settings[name];
        if (!declaration)
            continue;
        if (file.kind !== 'user' && declaration.project !== 'allowed') {
            report([name], 'user-only-in-project');
            continue;
        }
        if (isJsonObject(value) && declaration.overrides !== undefined) {
            const overrides = {};
            for (const [key, entry] of Object.entries(value)) {
                if (!isOverrideKeyAllowed(declaration.overrides, key)) {
                    report([name, key], 'override-not-allowed');
                    continue;
                }
                const result = validateFileValue(declaration.value, entry, [name, key], false, unknownReason, report);
                if (result.valid)
                    defineSettingsKey(overrides, key, result.value);
            }
            defineSettingsKey(snapshot.settings, name, overrides);
            continue;
        }
        if (isJsonObject(value) &&
            declaration.value.kind !== 'object' &&
            declaration.value.kind !== 'record') {
            report([name], 'override-not-allowed');
            continue;
        }
        const result = validateFileValue(declaration.value, value, [name], false, unknownReason, report);
        if (result.valid)
            defineSettingsKey(snapshot.settings, name, result.value);
    }
    return snapshot;
}
