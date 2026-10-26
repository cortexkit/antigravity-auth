import { domainToUnicode } from 'node:url';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, } from 'jsonc-parser';
import { SetupCommandError } from './command-error.js';
import { defaultCommandRunner, runResolvedCommand } from './command-runner.js';
import { writeHostConfigAtomic } from './config-write.js';
import { defaultSetupFileSystem } from './detect.js';
import { setupPaths } from './paths.js';
function specifierOf(value) {
    const entry = typeof value === 'string'
        ? value
        : Array.isArray(value)
            ? value[0]
            : value && typeof value === 'object' && 'package' in value
                ? value.package
                : null;
    return typeof entry === 'string' ? entry : null;
}
function packageOf(value) {
    const entry = specifierOf(value);
    if (entry === null)
        return null;
    const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
    return at < 0 ? entry : entry.slice(0, at);
}
function localFileURL(entry, windows) {
    const url = new URL(entry);
    if (/%2f/i.test(url.pathname) || (windows && /%5c/i.test(url.pathname)))
        throw new Error('Encoded path separators are not valid in a file URL.');
    const decoded = decodeURIComponent(url.pathname);
    if (!windows) {
        if (url.hostname)
            throw new Error('A POSIX file URL must be local.');
        return decoded;
    }
    const pathname = decoded.replaceAll('/', '\\');
    if (url.hostname)
        return `\\\\${domainToUnicode(url.hostname)}${pathname}`;
    if (!/^\\[a-z]:/i.test(pathname))
        throw new Error('A Windows file URL must have an absolute drive path.');
    return pathname.slice(1);
}
function localPackageOf(entry, configFile, io) {
    const { path, platform } = setupPaths(io);
    try {
        // Relative paths use the declaring config's directory, not setup's working directory:
        // https://github.com/anomalyco/opencode/blob/b6478dce/packages/opencode/src/config/plugin.ts#L40-L60
        // https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/config/plugin/source.ts#L139-L145
        // Decode file URLs explicitly: Bun 1.3 ignores fileURLToPath's Windows override.
        // The requested platform, not the OS running setup's tests, determines path rules.
        const directory = /^file:\/\//i.test(entry)
            ? localFileURL(entry, platform === 'win32')
            : path.isAbsolute(entry) || entry.startsWith('.')
                ? path.resolve(path.dirname(configFile), entry)
                : null;
        if (directory === null)
            return null;
        const manifest = JSON.parse((io.fs ?? defaultSetupFileSystem).readText(path.join(directory, 'package.json')));
        return manifest &&
            typeof manifest === 'object' &&
            'name' in manifest &&
            typeof manifest.name === 'string'
            ? manifest.name
            : null;
    }
    catch {
        // A missing, unreadable or invalid local package is not a registration of this plugin.
        return null;
    }
}
function pluginConfig(text, key) {
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value))
        throw new Error('Invalid OpenCode config; refusing to overwrite it.');
    if (value[key] !== undefined && !Array.isArray(value[key]))
        throw new Error(`OpenCode ${key} must be an array.`);
    return value;
}
function removeArrayEntry(text, key, index) {
    const tree = parseTree(text);
    const array = tree && findNodeAtLocation(tree, [key]);
    const nodes = array?.children ?? [];
    const node = nodes[index];
    if (!node || !array)
        throw new Error('Invalid plugin array edit.');
    const edits = [{ offset: node.offset, length: node.length, content: '' }];
    const removeComma = (start, end) => {
        const scanner = createScanner(text.slice(start, end), true);
        scanner.scan();
        if (text[start + scanner.getTokenOffset()] === ',')
            edits.push({
                offset: start + scanner.getTokenOffset(),
                length: 1,
                content: '',
            });
    };
    // Delete punctuation separately so comments beside other entries are not removed.
    if (index === nodes.length - 1) {
        const previous = nodes[index - 1];
        if (previous)
            removeComma(previous.offset + previous.length, node.offset);
        removeComma(node.offset + node.length, array.offset + array.length - 1);
    }
    else
        removeComma(node.offset + node.length, nodes[index + 1]?.offset ?? node.offset + node.length);
    return applyEdits(text, edits);
}
/** Edit only array entries so unrelated JSONC text, including comments, survives. */
export function updatePluginConfig(text, key, pkg, version) {
    const value = pluginConfig(text, key);
    const options = {
        formattingOptions: {
            insertSpaces: !/^\t+/m.test(text),
            tabSize: /^([ ]+)"/m.exec(text)?.[1]?.length ?? 2,
            eol: text.includes('\r\n') ? '\r\n' : '\n',
        },
    };
    let output = text;
    const array = value[key];
    const entries = Array.isArray(array) ? [...array] : [];
    const matches = entries.flatMap((entry, index) => packageOf(entry) === pkg ? [index] : []);
    const entry = `${pkg}@${version}`;
    if (!matches.length) {
        output = applyEdits(output, modify(output, array === undefined ? [key] : [key, entries.length], array === undefined ? [entry] : entry, options));
    }
    else {
        const first = matches[0];
        const previous = entries[first];
        // Preserve options in OpenCode's [package, options] and { package, options } entries.
        const replacement = Array.isArray(previous)
            ? [entry, ...previous.slice(1)]
            : previous && typeof previous === 'object'
                ? { ...previous, package: entry }
                : entry;
        if (JSON.stringify(previous) !== JSON.stringify(replacement))
            output = applyEdits(output, modify(output, [key, first], replacement, options));
        for (const index of matches.slice(1).reverse())
            output = removeArrayEntry(output, key, index);
    }
    const other = key === 'plugin' ? 'plugins' : 'plugin';
    if (Array.isArray(value[other])) {
        const otherEntries = value[other];
        for (let index = otherEntries.length - 1; index >= 0; index--) {
            if (packageOf(otherEntries[index]) === pkg)
                output = removeArrayEntry(output, other, index);
        }
    }
    return output;
}
export function planOpenCodeRegistration(plugin, generation, io = {}) {
    const fs = io.fs ?? defaultSetupFileSystem;
    const { path, opencode } = setupPaths(io);
    const key = generation === '2' ? 'plugins' : 'plugin';
    const names = generation === '2' ? ['opencode'] : ['opencode', 'tui'];
    return names.map((name) => {
        const jsonc = path.join(opencode, `${name}.jsonc`);
        const json = path.join(opencode, `${name}.json`);
        const file = fs.exists(jsonc) ? jsonc : fs.exists(json) ? json : jsonc;
        const exists = fs.exists(file);
        const before = exists
            ? fs.readText(file)
            : `${JSON.stringify({ $schema: `https://opencode.ai/${name === 'tui' ? 'tui' : 'config'}.json` }, null, 2)}\n`;
        const config = pluginConfig(before, key);
        const existingLocalEntries = [];
        const existingNpmEntries = [];
        for (const field of ['plugin', 'plugins']) {
            if (!Array.isArray(config[field]))
                continue;
            for (const entry of config[field]) {
                const spec = specifierOf(entry);
                if (spec === null)
                    continue;
                if (localPackageOf(spec, file, io) === plugin.packages.opencode)
                    existingLocalEntries.push(JSON.stringify(entry));
                else if (packageOf(entry) === plugin.packages.opencode)
                    existingNpmEntries.push(JSON.stringify(entry));
            }
        }
        // A local build is deliberate: do not replace it, deduplicate it or migrate its key.
        if (existingLocalEntries.length > 0)
            return {
                path: file,
                content: before,
                changed: false,
                existingLocalEntries,
                existingNpmEntries,
            };
        const content = updatePluginConfig(before, key, plugin.packages.opencode, plugin.version);
        return { path: file, content, changed: !exists || content !== before };
    });
}
export async function registerOpenCode(writes, beforeWrite) {
    for (const write of writes) {
        if (!write.changed)
            continue;
        await beforeWrite?.();
        await writeHostConfigAtomic(write.path, write.content, {
            beforeRename: beforeWrite,
        });
    }
}
export async function registerPi(plugin, executable, io = {}) {
    const { platform, env } = setupPaths(io);
    const result = await runResolvedCommand(io.runner ?? defaultCommandRunner, platform, executable, ['install', `npm:${plugin.packages.pi}@${plugin.version}`], env);
    if (result.exitCode !== 0 || result.timedOut)
        throw new SetupCommandError({
            exitCode: result.spawnError ? null : result.exitCode,
            signal: result.signal ?? null,
            stderrTail: result.stderr,
            stderrTruncated: result.stderrTruncated ?? false,
        });
}
