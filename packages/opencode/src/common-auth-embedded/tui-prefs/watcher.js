import { readFileSync, realpathSync, statSync, watch, } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { PrivateFileError, readPrivateText, windowsPrivateFiles, } from '../fs/private-files.js';
function canonicalPath(file) {
    const path = resolve(file);
    // Leave reparse points in the path for private-files' ancestor walk to reject;
    // realpath would follow them before the security backend saw the original path.
    if (windowsPrivateFiles)
        return path;
    try {
        return realpathSync(path);
    }
    catch {
        // Resolve existing ancestors even when the preferences file is not yet present.
        const parent = dirname(path);
        return parent === path ? path : join(canonicalPath(parent), basename(path));
    }
}
function identity(info, settings) {
    if (!info)
        return null;
    const value = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    return settings ? `${value}:${info.ctimeMs}` : value;
}
/**
 * Share one directory watcher and metadata poll per canonical path, including
 * across bundled copies. Native events use a 150 ms debounce; missed events
 * recover through a 1,000 ms stat probe (formerly a 100 ms full-file poll).
 * Watching the directory preserves atomic replacement and missing-file recovery.
 * Only changed raw text notifies; each subscriber is isolated and independently
 * disposable. The last unsubscribe stops both the native watcher and the poll.
 */
export function watchTuiPreferences(file, onChange, options = {}) {
    return watchFile(file, onChange, options, false);
}
/** @internal Settings use ordinary reads and observe removal of the user path. */
export function watchSettings(file, onChange, options = {}) {
    return watchFile(file, onChange, options, true);
}
function watchFile(file, onChange, options, settings) {
    const globals = globalThis;
    const key = Symbol.for(settings
        ? 'cortexkit.common-auth.settings.watchers.v1'
        : 'cortexkit.common-auth.tui-prefs.watchers.v1');
    const registry = globals[key] ?? new Map();
    globals[key] = registry;
    const path = settings ? resolve(file) : canonicalPath(file);
    const shared = registry.get(path);
    if (shared)
        return shared.subscribe(onChange);
    const name = basename(path);
    const read = windowsPrivateFiles && !settings
        ? (file) => readPrivateText(file)
        : (options.fs?.readFile ?? ((file) => readFile(file, 'utf8')));
    const probe = options.fs?.stat ?? stat;
    let timer = null;
    let pollTimer = null;
    let lastMetadata = null;
    let lastSeen = null;
    // Seed synchronously so an immediate write cannot be absorbed as the baseline.
    // The metadata is recorded only together with contents that were read, as in
    // the probe below: if the first read fails, the probe keeps trying.
    if (settings || !windowsPrivateFiles)
        try {
            const metadata = identity((options.fs?.statSync ?? statSync)(path), settings);
            lastSeen = (options.fs?.readFileSync ?? ((file) => readFileSync(file, 'utf8')))(path);
            lastMetadata = metadata;
        }
        catch {
            // Missing or unreadable files are picked up by the probe later.
        }
    let disposed = false;
    const subscribers = new Set();
    const notifySubscribers = () => {
        for (const subscriber of [...subscribers]) {
            if (!subscribers.has(subscriber))
                continue;
            try {
                subscriber.notify();
            }
            catch {
                // A broken subscriber must not prevent the others from observing a change.
            }
        }
    };
    let checking = Promise.resolve();
    const checkForChange = (native) => {
        // Serialize native and poll checks so an older read cannot roll back state.
        checking = checking.then(async () => {
            if (disposed)
                return;
            const metadata = identity(await probe(path).catch(() => null), settings);
            if (disposed)
                return;
            if (!native && metadata === lastMetadata)
                return;
            // A missing file has nothing to read; remember that so the probe stays
            // quiet until it reappears.
            if (metadata === null) {
                const disappeared = lastMetadata !== null;
                lastMetadata = null;
                if (settings && disappeared) {
                    // Dropping the bytes makes recreation observable even with the old text.
                    lastSeen = null;
                    notifySubscribers();
                }
                return;
            }
            const text = await read(path).catch((error) => {
                if (error instanceof PrivateFileError && error.code !== 'ENOENT') {
                    if (options.onError)
                        options.onError(error);
                    else
                        process.emitWarning(error.message, error.name);
                }
                return null;
            });
            if (disposed)
                return;
            // Record the metadata only once its contents were read. A failed read
            // leaves the old value, so the next probe sees a change and retries
            // instead of skipping a file whose new contents were never observed.
            if (text === null)
                return;
            lastMetadata = metadata;
            if (text === lastSeen)
                return;
            lastSeen = text;
            notifySubscribers();
        });
        return checking;
    };
    const scheduleCheck = () => {
        if (disposed)
            return;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void checkForChange(true);
        }, 150);
    };
    let watcher = null;
    try {
        watcher = (options.watchDirectory ?? watch)(dirname(path), (_event, filename) => {
            const eventName = filename?.toString();
            const isOurs = eventName === name ||
                (eventName?.startsWith(`${name}.`) && eventName.endsWith('.tmp'));
            if (eventName != null && !isOurs)
                return;
            scheduleCheck();
        });
        watcher.on('error', () => {
            // Polling continues if the native watcher fails after construction.
            watcher?.close();
            watcher = null;
        });
    }
    catch {
        // The probe still recovers a later creation, even with no native watcher.
    }
    const schedulePoll = () => {
        if (disposed || pollTimer)
            return;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            if (disposed)
                return;
            void checkForChange(false).finally(schedulePoll);
        }, 1_000);
        pollTimer.unref();
    };
    const entry = {
        subscribe: (notify) => {
            const subscriber = { notify };
            subscribers.add(subscriber);
            return () => {
                if (!subscribers.delete(subscriber) || subscribers.size > 0)
                    return;
                disposed = true;
                if (timer)
                    clearTimeout(timer);
                if (pollTimer)
                    clearTimeout(pollTimer);
                watcher?.close();
                if (registry.get(path) === entry)
                    registry.delete(path);
            };
        },
    };
    registry.set(path, entry);
    schedulePoll();
    return entry.subscribe(onChange);
}
