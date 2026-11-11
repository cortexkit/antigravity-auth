import { randomUUID } from 'node:crypto';
import { SettingsFs } from './fs.js';
import { SettingsRefusal } from './refusal.js';
let stepHook;
const HARD_LINK_UNSUPPORTED = new Set([
    'EPERM',
    'ENOTSUP',
    'EOPNOTSUPP',
    'ENOSYS',
]);
/** Internal test hook, deliberately absent from the package entry point. */
export function setSettingsWriteStepHookForTest(hook) {
    stepHook = hook;
}
/** Publish already validated edits while the caller holds the target's lock. */
export async function writeSettings(options) {
    const { target, text, hasBom, existingMode, lock, logger } = options;
    const platform = options.platform ?? process.platform;
    const temp = `${target}.${randomUUID()}.tmp`;
    let staged = false;
    let published = false;
    try {
        const file = await SettingsFs.open(temp, 'wx', 0o644);
        staged = true;
        try {
            await file.writeFile(`${hasBom ? '\uFEFF' : ''}${text}`, 'utf8');
            if (platform !== 'win32' && existingMode !== undefined) {
                await file.chmod(existingMode & 0o777);
            }
            await file.sync();
        }
        finally {
            await file.close();
        }
        await stepHook?.('staged', { target, temp });
        await lock.assertOwned();
        if (existingMode !== undefined) {
            try {
                await SettingsFs.rename(temp, target);
            }
            catch (error) {
                if (platform === 'win32' &&
                    ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? '')) {
                    throw new SettingsRefusal('settings-busy', `Settings file is busy: ${target}`, { cause: error });
                }
                throw error;
            }
            published = true;
        }
        else {
            try {
                // A hard link never replaces a file created since the locked read.
                await SettingsFs.link(temp, target);
            }
            catch (error) {
                const code = error.code ?? '';
                if (code === 'EEXIST') {
                    throw new SettingsRefusal('settings-busy', `Settings file appeared before publication: ${target}`, { cause: error });
                }
                // Some filesystems (FAT, exFAT, some network and user-space mounts) have no
                // hard links. A non-atomic create could expose a half-written file, so
                // refuse instead of falling back.
                if (HARD_LINK_UNSUPPORTED.has(code)) {
                    throw new SettingsRefusal('settings-unavailable', `Settings file cannot be created on this filesystem: ${target}`, { cause: error });
                }
                throw error;
            }
            published = true;
            try {
                await SettingsFs.unlink(temp);
            }
            catch (error) {
                // Publication succeeded; an orphaned temp must not turn it into a refusal.
                logger?.warn('Settings temp cleanup failed after publication', {
                    target,
                    temp,
                    error,
                });
            }
        }
        return { outcome: 'updated' };
    }
    finally {
        if (staged && !published) {
            await SettingsFs.unlink(temp).catch(() => { });
        }
    }
}
