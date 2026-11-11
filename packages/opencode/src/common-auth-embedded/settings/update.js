import { basename, dirname, join } from 'node:path';
import { ensurePrivateDirectory } from '../fs/private-files.js';
import { withLock } from '../fs/with-lock.js';
import { applySettingsEdits, } from './edit.js';
import { SettingsFs } from './fs.js';
import { rethrowSettingsLockError } from './lock-errors.js';
import { parseSettings } from './parse.js';
import { SettingsRefusal } from './refusal.js';
import { writeSettings } from './write.js';
const SETTINGS_WRITE_LOCK = Object.freeze({
    name: 'settings-write',
    ttlMs: 10_000,
    timeoutMs: 2_000,
    renew: true,
});
function unavailable(file, cause) {
    throw new SettingsRefusal('settings-unavailable', `Settings file is unavailable: ${file}`, { cause });
}
async function writeTarget(file) {
    try {
        return await SettingsFs.realpath(file);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            unavailable(file, error);
        try {
            await SettingsFs.lstat(file);
        }
        catch (lstatError) {
            if (lstatError.code !== 'ENOENT')
                unavailable(file, lstatError);
            try {
                return join(await SettingsFs.realpath(dirname(file)), basename(file));
            }
            catch (parentError) {
                unavailable(file, parentError);
            }
        }
        // A directory entry whose realpath is missing is a dangling symlink.
        unavailable(file, error);
    }
}
/** Lock the canonical user file so symlink aliases serialize the same edits. */
export async function updateSettings(definition, options, edits, context) {
    if (options.separateInstall) {
        throw new SettingsRefusal('settings-unavailable', 'Settings are unavailable for a separate install');
    }
    const folder = dirname(options.file);
    try {
        if (!options.createMissing)
            await SettingsFs.stat(folder);
        else if (process.platform === 'win32')
            await ensurePrivateDirectory(folder);
        else
            await SettingsFs.mkdir(folder, { recursive: true, mode: 0o700 });
    }
    catch (error) {
        unavailable(options.file, error);
    }
    const target = await writeTarget(options.file);
    let settled;
    try {
        return await withLock(target, {
            ...SETTINGS_WRITE_LOCK,
            timeoutMs: options.lockTimeoutMs ?? SETTINGS_WRITE_LOCK.timeoutMs,
        }, async (lock) => {
            try {
                if ((await writeTarget(options.file)) !== target) {
                    throw new SettingsRefusal('settings-busy', `Settings target changed while locking: ${options.file}`);
                }
                let source;
                let existingMode;
                let missing = false;
                try {
                    source = await SettingsFs.readFile(target, 'utf8');
                }
                catch (error) {
                    if (error.code !== 'ENOENT' ||
                        !options.createMissing)
                        unavailable(target, error);
                    missing = true;
                    source = '';
                }
                if (!missing) {
                    try {
                        existingMode = (await SettingsFs.stat(target)).mode;
                    }
                    catch (error) {
                        unavailable(target, error);
                    }
                }
                const parsed = parseSettings(source);
                if (!parsed.parseable || parsed.hasDuplicates) {
                    throw new SettingsRefusal('settings-unparseable', 'Settings must be an object without duplicate keys');
                }
                const version = parsed.value.schema_version;
                if (Number.isInteger(version) && version > 1) {
                    throw new SettingsRefusal('settings-newer-version', 'Settings were written by a newer version');
                }
                if (!parsed.tree) {
                    source = `${parsed.hasBom ? '\uFEFF' : ''}// ${definition.plugin} settings\n{\n  "schema_version": 1\n}\n`;
                }
                const edited = applySettingsEdits(definition, source, edits, context);
                const result = edited.outcome === 'unchanged'
                    ? { outcome: 'unchanged' }
                    : await writeSettings({
                        target,
                        text: edited.text,
                        hasBom: edited.hasBom,
                        existingMode,
                        lock,
                        logger: options.log,
                    });
                settled = { outcome: 'fulfilled', result };
                return result;
            }
            catch (error) {
                settled = { outcome: 'rejected', error };
                throw error;
            }
        });
    }
    catch (error) {
        if (!settled)
            rethrowSettingsLockError(error, target, SETTINGS_WRITE_LOCK.name);
        // Release runs after the callback; it cannot undo a settings write or refusal.
        if (settled.outcome === 'fulfilled' || error !== settled.error) {
            try {
                options.log.warn('Settings lock release failed', { target, error });
            }
            catch {
                // A logger failure must not replace the callback's own outcome either.
            }
        }
        if (settled.outcome === 'rejected')
            throw settled.error;
        return settled.result;
    }
}
