import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensurePrivateDirectory, PrivateFileError, } from '../fs/private-files.js';
import { LockContentionError, LockOwnershipError, lockPathFor, withLock, } from '../fs/with-lock.js';
import { LockStack, POOL_LOCK_DEFAULTS, } from '../store/refresh-lock.js';
import { validateValue } from './descriptors.js';
import { SettingsFs } from './fs.js';
import { rethrowSettingsLockError } from './lock-errors.js';
import { SettingsRefusal } from './refusal.js';
let stepHook;
/** Internal test hook, not part of the settings subpath's public exports. */
export function setSettingsMoveStepHookForTest(hook) {
    stepHook = hook;
}
function emptyResult(outcome) {
    return {
        outcome,
        unmapped: [],
        differing: [],
        noteFailures: [],
        postPublishFailures: [],
    };
}
function hasCode(error, code) {
    return (error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === code);
}
async function exists(path) {
    try {
        await SettingsFs.lstat(path);
        return true;
    }
    catch (error) {
        if (hasCode(error, 'ENOENT'))
            return false;
        throw error;
    }
}
function log(options, level, message, data) {
    try {
        options.log[level](message, data);
    }
    catch {
        // Diagnostics must not turn a completed publication into a failure.
    }
}
function lockFailure(error, path, name) {
    let original = error;
    const seen = new Set();
    while (original !== null &&
        typeof original === 'object' &&
        !seen.has(original)) {
        seen.add(original);
        if (original instanceof LockContentionError ||
            original instanceof LockOwnershipError ||
            original instanceof PrivateFileError) {
            break;
        }
        if (!('cause' in original))
            break;
        original = original.cause;
    }
    try {
        rethrowSettingsLockError(original, path, name);
    }
    catch (mapped) {
        return {
            ...emptyResult(mapped instanceof SettingsRefusal && mapped.code === 'settings-busy'
                ? 'busy'
                : 'failed'),
            cause: error,
        };
    }
}
function merge(options, legacy, mapped, result) {
    result.unmapped = [...mapped.unmapped];
    const bySetting = new Map();
    for (const entry of mapped.entries) {
        const source = legacy[entry.source];
        if (!Number.isInteger(entry.source) || !source?.present) {
            throw new TypeError(`Move entry has no present source: ${entry.source}`);
        }
        const declaration = Object.hasOwn(options.definition.settings, entry.setting)
            ? options.definition.settings[entry.setting]
            : undefined;
        const reason = !declaration
            ? 'unknown-setting'
            : !validateValue(declaration.value, entry.value)
                ? 'invalid-value'
                : undefined;
        if (reason) {
            result.unmapped.push({ source: entry.source, key: entry.setting, reason });
            continue;
        }
        const entries = bySetting.get(entry.setting) ?? [];
        entries.push({ ...entry, host: source.host });
        bySetting.set(entry.setting, entries);
    }
    const document = { schema_version: 1 };
    for (const [setting, declaration] of Object.entries(options.definition.settings)) {
        const entries = bySetting.get(setting)?.sort((a, b) => a.source - b.source);
        const primary = entries?.[0];
        if (!entries || !primary)
            continue;
        const hosts = new Map();
        if (declaration.overrides?.host) {
            for (const host of ['opencode', 'pi']) {
                const first = entries.find((entry) => entry.host === host);
                if (first && !isDeepStrictEqual(first.value, primary.value)) {
                    hosts.set(host, first.value);
                }
            }
        }
        Object.defineProperty(document, setting, {
            value: hosts.size
                ? { default: primary.value, ...Object.fromEntries(hosts) }
                : primary.value,
            enumerable: true,
        });
        const values = entries.map((entry) => ({
            source: entry.source,
            host: entry.host,
            value: entry.value,
        }));
        if (values.some(({ host, value }) => !isDeepStrictEqual(hosts.has(host) ? hosts.get(host) : primary.value, value))) {
            result.differing.push({ setting, values });
            log(options, 'info', `Differing legacy settings: ${setting}`, { values });
        }
    }
    return document;
}
async function removeStaleTemps(target) {
    const prefix = `${basename(target)}.move-`;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
    for (const name of await SettingsFs.readdir(dirname(target))) {
        if (name.startsWith(prefix) && uuid.test(name.slice(prefix.length))) {
            await SettingsFs.unlink(join(dirname(target), name));
        }
    }
}
async function writeNotes(options, legacy, result) {
    for (const source of legacy) {
        if (!source.present)
            continue;
        const path = `${source.path}.MOVED_READPLEASE`;
        try {
            let file;
            try {
                file = await SettingsFs.open(path, 'wx');
            }
            catch (error) {
                if (hasCode(error, 'EEXIST'))
                    continue;
                throw error;
            }
            try {
                await file.writeFile(`Settings moved to ${options.target}.\nA rollback loses changes made after the move.\n`, 'utf8');
            }
            finally {
                await file.close();
            }
        }
        catch (error) {
            result.noteFailures.push({ path, error });
            log(options, 'warn', 'Could not write settings move note', {
                path,
                error,
            });
        }
    }
}
async function publish(options, legacy, document, moveLock, stack, result) {
    const { target } = options;
    const temp = `${target}.move-${randomUUID()}.tmp`;
    let staged = false;
    try {
        const file = await SettingsFs.open(temp, 'wx', 0o644);
        staged = true;
        try {
            const header = [
                `// Settings moved on ${new Date().toISOString().slice(0, 10)} (UTC) from:`,
                ...options.sources.map((source) => `// ${JSON.stringify(source.path)}`),
            ].join('\n');
            await file.writeFile(`${header}\n${JSON.stringify(document, null, 2)}\n`, 'utf8');
            await file.sync();
        }
        finally {
            await file.close();
        }
        await stepHook?.('staged', { target, temp });
        await stepHook?.('before-publish', { target, temp });
        await moveLock.assertOwned();
        await stack.assertAll();
        try {
            await SettingsFs.link(temp, target);
        }
        catch (error) {
            if (!hasCode(error, 'EEXIST'))
                throw error;
            result.outcome = 'aborted-target-appeared';
            return result;
        }
        result.outcome = 'moved';
        try {
            await SettingsFs.unlink(temp);
            staged = false;
        }
        catch (error) {
            result.postPublishFailures.push({ step: 'temp-unlink', error });
            log(options, 'warn', 'Settings move temp cleanup failed', { temp, error });
        }
        if (process.platform !== 'win32') {
            try {
                const folder = await SettingsFs.open(dirname(target), 'r');
                try {
                    await folder.sync();
                }
                finally {
                    await folder.close();
                }
            }
            catch (error) {
                result.postPublishFailures.push({ step: 'directory-sync', error });
                log(options, 'warn', 'Settings move directory sync failed', {
                    target,
                    error,
                });
            }
        }
        await writeNotes(options, legacy, result);
        return result;
    }
    finally {
        if (staged && result.outcome !== 'moved') {
            await SettingsFs.unlink(temp).catch(() => { });
        }
    }
}
/** Move legacy settings without replacing an existing target or changing a source. */
export async function moveSettingsOnce(options) {
    try {
        if (options.separateInstall)
            return emptyResult('separate-install');
        if (await exists(options.target))
            return emptyResult('done-already');
        if (!(await options.fence()))
            return emptyResult('fence-closed');
        const folder = dirname(options.target);
        if (process.platform === 'win32')
            await ensurePrivateDirectory(folder);
        else
            await SettingsFs.mkdir(folder, { recursive: true, mode: 0o700 });
        let settled;
        try {
            return await withLock(options.target, { name: 'settings-move', ...POOL_LOCK_DEFAULTS }, async (moveLock) => {
                const stack = new LockStack(POOL_LOCK_DEFAULTS, {});
                try {
                    const skipped = new Set();
                    const seen = new Map();
                    for (const source of options.sources) {
                        for (const spec of source.locks) {
                            const path = resolve(spec.path);
                            const names = seen.get(path) ?? new Set();
                            if (names.has(spec.name))
                                continue;
                            names.add(spec.name);
                            seen.set(path, names);
                            const lockFolder = dirname(lockPathFor(spec.path, spec.name));
                            if (!(await exists(lockFolder))) {
                                skipped.add(lockFolder);
                                continue;
                            }
                            try {
                                await stack.acquire(spec);
                            }
                            catch (error) {
                                settled = lockFailure(error, spec.path, spec.name);
                                return settled;
                            }
                        }
                    }
                    if (await exists(options.target)) {
                        settled = emptyResult('done-already');
                    }
                    else if (!(await options.fence())) {
                        settled = emptyResult('fence-closed');
                    }
                    else {
                        await removeStaleTemps(options.target);
                        await stepHook?.('locked', { target: options.target });
                        const legacy = [];
                        for (const source of options.sources) {
                            let text;
                            try {
                                text = await SettingsFs.readFile(source.path, 'utf8');
                            }
                            catch (error) {
                                if (!hasCode(error, 'ENOENT'))
                                    throw error;
                                legacy.push({
                                    host: source.host,
                                    path: source.path,
                                    present: false,
                                });
                                continue;
                            }
                            legacy.push({
                                host: source.host,
                                path: source.path,
                                present: true,
                                value: source.read(text),
                            });
                        }
                        const mapped = await options.map(legacy);
                        for (const path of skipped) {
                            if (await exists(path)) {
                                settled = emptyResult('busy');
                                return settled;
                            }
                        }
                        const result = emptyResult('failed');
                        const document = merge(options, legacy, mapped, result);
                        settled = await publish(options, legacy, document, moveLock, stack, result);
                    }
                }
                catch (cause) {
                    settled = { ...emptyResult('failed'), cause };
                }
                finally {
                    await stack.releaseAll();
                }
                return settled;
            });
        }
        catch (error) {
            if (!settled)
                return lockFailure(error, options.target, 'settings-move');
            if (settled.outcome === 'moved') {
                settled.postPublishFailures.push({ step: 'lock-release', error });
            }
            log(options, 'warn', 'Settings move lock release failed', { error });
            return settled;
        }
    }
    catch (cause) {
        return { ...emptyResult('failed'), cause };
    }
}
