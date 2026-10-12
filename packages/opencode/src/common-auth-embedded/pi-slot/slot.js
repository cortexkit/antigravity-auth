import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeJsonAtomic } from '../fs/atomic-write.js';
import { acquirePiLock } from './lock.js';
/** Errors deliberately contain neither paths nor credentials nor underlying error messages. */
export class PiSlotError extends Error {
    code;
    constructor(code) {
        super(`Pi slot: ${code}`);
        this.code = code;
        this.name = 'PiSlotError';
    }
}
// JSON.parse validates grammar first. This scan only locates top-level value text ranges.
function rootSpans(text) {
    let i = text.indexOf('{') + 1;
    const root = { offset: i - 1, children: [] };
    const whitespace = () => {
        while (/\s/.test(text[i] ?? '') && i < text.length)
            i++;
    };
    const stringEnd = () => {
        i++;
        while (i < text.length) {
            if (text[i++] === '"')
                return;
            if (text[i - 1] === '\\')
                i++;
        }
    };
    whitespace();
    while (text[i] !== '}') {
        const start = i;
        stringEnd();
        const key = JSON.parse(text.slice(start, i));
        whitespace();
        i++; // colon
        whitespace();
        const offset = i;
        let depth = 0;
        while (i < text.length) {
            const char = text[i];
            if (char === '"') {
                stringEnd();
                continue;
            }
            if (char === '{' || char === '[')
                depth++;
            if (char === '}' || char === ']') {
                if (depth === 0)
                    break;
                depth--;
            }
            if (char === ',' && depth === 0)
                break;
            i++;
        }
        let end = i;
        while (/\s/.test(text[end - 1] ?? ''))
            end--;
        root.children.push({
            key,
            offset: start,
            length: end - start,
            value: { offset, length: end - offset },
        });
        whitespace();
        if (text[i] === '}')
            break;
        i++; // comma
        whitespace();
    }
    return root;
}
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (object(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
function digest(value) {
    return createHash('sha256').update(canonical(value)).digest('hex');
}
function code(error) {
    return object(error) ? error.code : undefined;
}
async function safeRead(path, privateFile = false, afterReadCheck) {
    let file;
    try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || (privateFile && (stat.mode & 0o777) !== 0o600)) {
            throw new PiSlotError('unsafe-path');
        }
        await afterReadCheck?.(path);
        // Refuse a replaced pathname even though the descriptor still pins the checked file.
        const current = await lstat(path);
        if (!current.isFile() ||
            current.dev !== stat.dev ||
            current.ino !== stat.ino) {
            throw new PiSlotError('unsafe-path');
        }
        const bytes = await file.readFile();
        const text = bytes.toString('utf8');
        if (!bytes.equals(Buffer.from(text))) {
            throw new PiSlotError(privateFile ? 'invalid-stash' : 'invalid-auth');
        }
        return text;
    }
    catch (error) {
        if (code(error) === 'ENOENT' && !file)
            return undefined;
        if (code(error) === 'ELOOP' || code(error) === 'ENOENT') {
            throw new PiSlotError('unsafe-path');
        }
        throw error;
    }
    finally {
        await file?.close();
    }
}
function parseAuth(text, provider) {
    try {
        const data = JSON.parse(text);
        if (!object(data))
            throw new Error();
        const root = rootSpans(text);
        const properties = root.children;
        // Duplicate provider keys have ambiguous byte ownership, even though JSON.parse accepts them.
        const names = properties.map((node) => node.key);
        if (new Set(names).size !== names.length)
            throw new Error();
        const property = properties.find((node) => node.key === provider);
        const entry = property ? data[provider] : null;
        if (entry !== null && !object(entry))
            throw new Error();
        if (property && entry === null)
            throw new Error();
        return { text, root, property, entry: entry };
    }
    catch {
        throw new PiSlotError('invalid-auth');
    }
}
function entryText(auth) {
    const value = auth.property?.value;
    return value
        ? auth.text.slice(value.offset, value.offset + value.length)
        : null;
}
function replaceEntry(auth, provider, next) {
    const { text, root, property } = auth;
    const properties = root.children ?? [];
    if (property) {
        const value = property.value;
        if (!value)
            throw new PiSlotError('invalid-auth');
        if (next !== null) {
            return (text.slice(0, value.offset) +
                next +
                text.slice(value.offset + value.length));
        }
        const index = properties.indexOf(property);
        const previous = properties[index - 1];
        const following = properties[index + 1];
        const start = previous ? previous.offset + previous.length : property.offset;
        const end = !previous && following
            ? following.offset
            : property.offset + property.length;
        return text.slice(0, start) + text.slice(end);
    }
    if (next === null)
        return text;
    const last = properties.at(-1);
    // Insert next to the last value, not after its whitespace, so deletion reverses an empty-slot swap.
    const offset = last ? last.offset + last.length : root.offset + 1;
    return `${text.slice(0, offset)}${last ? ',' : ''}${JSON.stringify(provider)}:${next}${text.slice(offset)}`;
}
async function syncDir(path) {
    const dir = await open(path, 'r');
    try {
        await dir.sync();
    }
    finally {
        await dir.close();
    }
}
async function atomicWrite(path, text, assertLock, beforeRename) {
    await writeJsonAtomic(path, null, {
        serialize: () => text,
        durable: true,
        beforeRename: async () => {
            await beforeRename?.(path);
            assertLock();
        },
    });
}
/**
 * Production entry point. Pi caches which models are usable; after a
 * successful transition the extension calls `ctx.modelRegistry.refresh()` so
 * Pi re-reads the slot it just changed.
 */
export function openPiSlot(options) {
    return createPiSlot(options);
}
/**
 * Internal test entry point: pause reads, renewals, or renames to simulate races,
 * and observe durable writes/deletion to simulate crashes. Not a public export.
 */
export function createPiSlot(options, onStep, hooks) {
    const { provider, placeholderKey } = options;
    const timeout = options.lockTimeoutMs ?? 30_000;
    if (!provider ||
        !options.authPath ||
        !options.stashPath ||
        !placeholderKey ||
        placeholderKey.startsWith('!') ||
        placeholderKey.includes('$') ||
        !Number.isFinite(timeout) ||
        timeout < 0) {
        throw new PiSlotError('invalid-options');
    }
    const authPath = resolve(options.authPath);
    const stashPath = resolve(options.stashPath);
    if (authPath === stashPath || stashPath === `${authPath}.lock`) {
        throw new PiSlotError('invalid-options');
    }
    const authIdentity = digest(authPath);
    const placeholderIdentity = digest(placeholderKey);
    const placeholder = { type: 'api_key', key: placeholderKey };
    const isPlaceholder = (entry) => digest(entry) === digest(placeholder);
    async function loadStash() {
        const text = await safeRead(stashPath, true, hooks?.afterReadCheck);
        if (text === undefined)
            return undefined;
        try {
            const stash = JSON.parse(text);
            if (stash.version !== 1 ||
                stash.provider !== provider ||
                stash.authIdentity !== authIdentity ||
                stash.placeholderIdentity !== placeholderIdentity ||
                (stash.entry !== null && !object(stash.entry)) ||
                stash.sha256 !== digest(stash.entry) ||
                (stash.entry === null
                    ? stash.entryJson !== null
                    : typeof stash.entryJson !== 'string' ||
                        digest(JSON.parse(stash.entryJson)) !== stash.sha256)) {
                throw new Error();
            }
            return stash;
        }
        catch {
            throw new PiSlotError('invalid-stash');
        }
    }
    async function locked(fn) {
        let release;
        let assertFresh;
        let compromised = false;
        const assertLock = () => {
            assertFresh?.();
            if (compromised)
                throw new PiSlotError('lock-compromised');
        };
        try {
            await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
            const deadline = Date.now() + timeout;
            let retry = 0;
            while (!release) {
                try {
                    const lease = await acquirePiLock(authPath, () => {
                        compromised = true;
                    }, hooks?.onRenew);
                    release = lease.release;
                    assertFresh = lease.assertFresh;
                }
                catch (error) {
                    if (code(error) !== 'ELOCKED')
                        throw error;
                    const remaining = deadline - Date.now();
                    if (remaining <= 0)
                        throw new PiSlotError('lock-timeout');
                    await sleep(Math.min(Math.round(Math.min(10 * 2 ** retry++, 1_000) * (1 + Math.random())), remaining));
                }
            }
            assertLock();
            const result = await fn(assertLock);
            assertLock();
            return result;
        }
        catch (error) {
            if (error instanceof PiSlotError)
                throw error;
            throw new PiSlotError('io');
        }
        finally {
            await release?.().catch(() => { });
            assertLock();
        }
    }
    async function load() {
        const auth = parseAuth((await safeRead(authPath, false, hooks?.afterReadCheck)) ?? '{}', provider);
        const stash = await loadStash();
        return { auth, stash };
    }
    async function deleteStash(assertLock) {
        assertLock();
        await unlink(stashPath);
        await syncDir(dirname(stashPath));
        onStep?.('stash-deleted');
    }
    return {
        inspect: () => locked(async () => {
            const { auth, stash } = await load();
            const slot = isPlaceholder(auth.entry)
                ? 'placeholder'
                : auth.entry === null
                    ? 'empty'
                    : !stash || digest(auth.entry) === stash.sha256
                        ? 'original'
                        : 'foreign';
            return { slot, stash: stash ? 'valid' : 'missing' };
        }),
        enterVault: () => locked(async (assertLock) => {
            const { auth, stash } = await load();
            if (isPlaceholder(auth.entry)) {
                if (!stash)
                    throw new PiSlotError('missing-stash');
                return;
            }
            if (stash && digest(auth.entry) !== stash.sha256)
                throw new PiSlotError('conflict');
            if (!stash) {
                await mkdir(dirname(stashPath), { recursive: true, mode: 0o700 });
                const dir = await lstat(dirname(stashPath));
                if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700)
                    throw new PiSlotError('unsafe-path');
                const saved = {
                    version: 1,
                    provider,
                    authIdentity,
                    placeholderIdentity,
                    entry: auth.entry,
                    entryJson: entryText(auth),
                    sha256: digest(auth.entry),
                };
                await atomicWrite(stashPath, JSON.stringify(saved), assertLock, hooks?.beforeRename);
                onStep?.('stash-written');
            }
            await atomicWrite(authPath, replaceEntry(auth, provider, JSON.stringify(placeholder)), assertLock, hooks?.beforeRename);
            onStep?.('auth-written');
        }),
        exitVault: () => locked(async (assertLock) => {
            const { auth, stash } = await load();
            if (!stash) {
                if (isPlaceholder(auth.entry))
                    throw new PiSlotError('missing-stash');
                return 'nothing-to-do';
            }
            if (isPlaceholder(auth.entry)) {
                await atomicWrite(authPath, replaceEntry(auth, provider, stash.entryJson), assertLock, hooks?.beforeRename);
                onStep?.('auth-written');
            }
            else if (digest(auth.entry) !== stash.sha256) {
                return 'conflict';
            }
            // Also completes a restore interrupted between the auth rename and stash deletion.
            await deleteStash(assertLock);
            return 'restored';
        }),
    };
}
