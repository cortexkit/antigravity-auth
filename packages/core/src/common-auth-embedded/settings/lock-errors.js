import { PrivateFileError } from '../fs/private-files.js';
import { isChangingLockRecord, LockContentionError } from '../fs/with-lock.js';
import { SettingsRefusal } from './refusal.js';
/** Classify against the failing lock, not the settings destination it protects. */
export function rethrowSettingsLockError(error, target, name) {
    if (error instanceof LockContentionError ||
        isChangingLockRecord(error, target, name)) {
        throw new SettingsRefusal('settings-busy', `Settings lock is busy: ${target}`, { cause: error });
    }
    if (error instanceof PrivateFileError &&
        (error.stage === 'safe-parent' || error.stage === 'directory')) {
        throw new SettingsRefusal('settings-unavailable', `Settings lock folder is unavailable: ${target}`, { cause: error });
    }
    throw error;
}
