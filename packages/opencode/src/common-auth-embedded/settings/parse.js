import { parseTree } from 'jsonc-parser';
/** Define own data properties so JSON keys never invoke prototype setters. */
export function defineSettingsKey(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}
/** Convert in document order, retaining the last occurrence of a repeated key. */
export function settingsValueFromTree(node, onDuplicate = () => { }, keyPath = []) {
    if (node.type === 'object') {
        const value = {};
        for (const property of node.children ?? []) {
            const [keyNode, valueNode] = property.children ?? [];
            if (!keyNode || !valueNode)
                continue;
            const key = keyNode.value;
            const path = [...keyPath, key];
            if (Object.hasOwn(value, key))
                onDuplicate(path);
            defineSettingsKey(value, key, settingsValueFromTree(valueNode, onDuplicate, path));
        }
        return value;
    }
    if (node.type === 'array') {
        return (node.children ?? []).map((child, index) => settingsValueFromTree(child, onDuplicate, [...keyPath, String(index)]));
    }
    return node.value;
}
export function parseSettings(source) {
    const hasBom = source.startsWith('\uFEFF');
    const text = hasBom ? source.slice(1) : source;
    // Do not use trim(): it would silently discard a second or misplaced BOM.
    if (/^[\x20\t\r\n]*$/.test(text)) {
        return {
            parseable: true,
            text,
            hasBom,
            tree: undefined,
            value: {},
            duplicateKeyPaths: [],
            hasDuplicates: false,
        };
    }
    const errors = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || tree?.type !== 'object') {
        return { parseable: false, text, hasBom, tree, errors };
    }
    const paths = new Map();
    const value = settingsValueFromTree(tree, (path) => {
        paths.set(JSON.stringify(path), path);
    });
    return {
        parseable: true,
        text,
        hasBom,
        tree,
        value,
        duplicateKeyPaths: [...paths.values()],
        hasDuplicates: paths.size > 0,
    };
}
