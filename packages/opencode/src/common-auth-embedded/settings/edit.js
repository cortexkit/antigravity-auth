import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, modify, } from 'jsonc-parser';
import { isJsonObject, validateValue, } from './descriptors.js';
import { parseSettings } from './parse.js';
import { SettingsRefusal } from './refusal.js';
// jsonc-parser declares these scanner tokens as an ambient const enum, which
// cannot be imported as a value with verbatimModuleSyntax enabled.
const SyntaxKind = {
    CommaToken: 5,
    LineCommentTrivia: 12,
    BlockCommentTrivia: 13,
    Trivia: 15,
    EOF: 17,
};
function invalid() {
    throw new SettingsRefusal('settings-invalid-value', 'The settings edit does not match its declared value');
}
function parseForEdit(text) {
    const parsed = parseSettings(text);
    if (!parsed.parseable || parsed.hasDuplicates) {
        throw new SettingsRefusal('settings-unparseable', 'Settings must be an object without duplicate keys');
    }
    return parsed;
}
function descriptorAtPath(descriptor, path) {
    let current = descriptor;
    for (const key of path) {
        if (current.kind === 'object' && Object.hasOwn(current.fields, key)) {
            current = current.fields[key];
        }
        else if (current.kind === 'record') {
            current = current.value;
        }
        else {
            invalid();
        }
    }
    return current;
}
function destination(declaration, setting, value, { host, model }, level) {
    if (level !== undefined) {
        return level === 'default' && !isJsonObject(value)
            ? [setting]
            : [setting, level];
    }
    if (declaration.overrides !== undefined && isJsonObject(value)) {
        if (declaration.overrides.model &&
            model !== undefined &&
            model !== 'default' &&
            model !== 'opencode' &&
            model !== 'pi' &&
            Object.hasOwn(value, model)) {
            return [setting, model];
        }
        if (declaration.overrides.host &&
            (host === 'opencode' || host === 'pi') &&
            Object.hasOwn(value, host)) {
            return [setting, host];
        }
        return [setting, 'default'];
    }
    return [setting];
}
function resolutionUnit(descriptor, destination, path) {
    let current = descriptor;
    const unitPath = [...destination];
    for (const key of path) {
        // Records and lists resolve whole, even when the edit changes one leaf.
        if (current.kind === 'record' || current.kind === 'list')
            break;
        current = descriptorAtPath(current, [key]);
        unitPath.push(key);
    }
    return { path: unitPath, descriptor: current };
}
function checkPath(parsed, path) {
    for (let length = 1; length < path.length; length++) {
        const node = parsed.tree && findNodeAtLocation(parsed.tree, path.slice(0, length));
        if (node && node.type !== 'object')
            invalid();
    }
}
function preservePlainDefault(parsed, setting) {
    const node = parsed.tree && findNodeAtLocation(parsed.tree, [setting]);
    if (!node)
        invalid();
    // Keep the original value text so comments inside a list survive promotion.
    const value = parsed.text.slice(node.offset, node.offset + node.length);
    return parseForEdit(applyEdits(parsed.text, [
        {
            offset: node.offset,
            length: node.length,
            content: `{ "default": ${value} }`,
        },
    ]));
}
/** Remove only the member's own tokens; intervening comment lines belong to neither neighbor. */
function removeMember(text, tree, path) {
    const property = tree && findNodeAtLocation(tree, path)?.parent;
    const parent = property?.parent;
    if (property?.type !== 'property' || !parent?.children)
        return text;
    const scanner = createScanner(text, false);
    const end = property.offset + property.length;
    const index = parent.children.indexOf(property);
    const next = parent.children[index + 1];
    const followingEnd = next?.offset ?? parent.offset + parent.length - 1;
    let comma;
    scanner.setPosition(end);
    while (scanner.getPosition() < followingEnd) {
        const token = scanner.scan();
        if (token === SyntaxKind.CommaToken) {
            comma = { start: scanner.getTokenOffset(), end: scanner.getPosition() };
            break;
        }
        if (token === SyntaxKind.EOF)
            break;
    }
    if (!comma && index > 0) {
        const previous = parent.children[index - 1];
        scanner.setPosition(previous.offset + previous.length);
        while (scanner.getPosition() < property.offset) {
            const token = scanner.scan();
            if (token === SyntaxKind.CommaToken) {
                comma = { start: scanner.getTokenOffset(), end: scanner.getPosition() };
                break;
            }
            if (token === SyntaxKind.EOF)
                break;
        }
    }
    let removeEnd = end;
    scanner.setPosition(end);
    while (scanner.getPosition() < followingEnd) {
        const token = scanner.scan();
        if (token === SyntaxKind.Trivia || token === SyntaxKind.CommaToken)
            continue;
        if (token !== SyntaxKind.LineCommentTrivia &&
            token !== SyntaxKind.BlockCommentTrivia)
            break;
        removeEnd = scanner.getPosition();
        // A multiline trailing comment belongs to the member, but comments starting
        // on subsequent lines do not.
        if (/[\r\n]/.test(scanner.getTokenValue()))
            break;
    }
    if (comma &&
        comma.start >= end &&
        !/[\r\n]/.test(text.slice(end, comma.start))) {
        removeEnd = Math.max(removeEnd, comma.end);
    }
    const lineStart = Math.max(text.lastIndexOf('\n', property.offset - 1), text.lastIndexOf('\r', property.offset - 1)) + 1;
    let removeStart = property.offset;
    const lineBreak = /^[\t ]*(\r\n|\r|\n)/.exec(text.slice(removeEnd));
    if (/^[\t ]*$/.test(text.slice(lineStart, property.offset)) && lineBreak) {
        removeStart = lineStart;
        removeEnd += lineBreak[0].length;
    }
    const edits = [
        { offset: removeStart, length: removeEnd - removeStart, content: '' },
    ];
    // The last member's comma can be separated from it by preserved comment lines.
    if (comma && (comma.start < removeStart || comma.start >= removeEnd)) {
        edits.push({
            offset: comma.start,
            length: comma.end - comma.start,
            content: '',
        });
    }
    return applyEdits(text, edits);
}
/** Pure JSONC edit engine; the writer restores the BOM and owns durable I/O. */
export function applySettingsEdits(definition, source, edits, context) {
    // Validate the entire request before changing even the private working text.
    for (const edit of edits) {
        if (!Object.hasOwn(definition.settings, edit.setting))
            invalid();
        const declaration = definition.settings[edit.setting];
        if (edit.level !== undefined) {
            if (edit.path !== undefined)
                invalid();
            if (edit.level === 'default') {
                if (declaration.overrides === undefined)
                    invalid();
            }
            else if ((edit.level !== 'opencode' && edit.level !== 'pi') ||
                !declaration.overrides?.host) {
                invalid();
            }
        }
        if (edit.path !== undefined &&
            declaration.value.kind !== 'object' &&
            declaration.value.kind !== 'record')
            invalid();
        const descriptor = descriptorAtPath(declaration.value, edit.path ?? []);
        if (edit.remove !== true && !validateValue(descriptor, edit.value))
            invalid();
    }
    const start = parseForEdit(source);
    let working = start;
    const units = [];
    for (const edit of edits) {
        const declaration = definition.settings[edit.setting];
        if (edit.level !== undefined &&
            edit.level !== 'default' &&
            !isJsonObject(working.value[edit.setting])) {
            if (edit.remove === true)
                continue;
            if (Object.hasOwn(working.value, edit.setting)) {
                working = preservePlainDefault(working, edit.setting);
            }
            // Earlier root edits now refer to the override's default, if it exists.
            for (const unit of units) {
                if (unit.path.length === 1 && unit.path[0] === edit.setting) {
                    unit.path.push('default');
                }
            }
        }
        const base = edit.path !== undefined
            ? [edit.setting]
            : destination(declaration, edit.setting, working.value[edit.setting], context, edit.level);
        const path = [...base, ...(edit.path ?? [])];
        checkPath(working, path);
        units.push(resolutionUnit(declaration.value, base, edit.path ?? []));
        const node = working.tree && findNodeAtLocation(working.tree, path);
        let text;
        if (edit.remove === true) {
            if (!node)
                continue;
            text = removeMember(working.text, working.tree, path);
            let removed = parseForEdit(text);
            const remaining = removed.value[edit.setting];
            if (base.length === 2 &&
                isJsonObject(remaining) &&
                Object.keys(remaining).length === 0) {
                text = removeMember(text, removed.tree, [edit.setting]);
                removed = parseForEdit(text);
            }
            working = removed;
        }
        else {
            if (node && isDeepStrictEqual(valueAt(working.value, path), edit.value))
                continue;
            text = applyEdits(working.text, modify(working.text, path, edit.value, {
                formattingOptions: { insertSpaces: true, tabSize: 2 },
            }));
            working = parseForEdit(text);
        }
    }
    for (const unit of units) {
        const node = working.tree && findNodeAtLocation(working.tree, unit.path);
        if (node &&
            !validateValue(unit.descriptor, valueAt(working.value, unit.path), {
                allowUnknownFields: true,
            }))
            invalid();
    }
    if (isDeepStrictEqual(start.value, working.value)) {
        return { outcome: 'unchanged', text: start.text, hasBom: start.hasBom };
    }
    return {
        outcome: 'updated',
        text: working.text,
        hasBom: start.hasBom,
    };
}
function valueAt(value, path) {
    let current = value;
    for (const key of path) {
        if (!isJsonObject(current) || !Object.hasOwn(current, key))
            return undefined;
        current = current[key];
    }
    return current;
}
