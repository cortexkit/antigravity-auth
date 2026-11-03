import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, rename, rmdir, stat, unlink, } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { ensurePrivateDirectory, PrivateFileError, readPrivateText, verifyPrivate, windowsPrivateFiles, writePrivateAtomic, } from '../fs/private-files.js';
function staleBefore(clock) {
    // A five-minute margin favors keeping a live record when clocks are uncertain.
    return (clock.now ?? Date.now)() - (clock.uptime ?? uptime)() * 1000 - 300_000;
}
function isStalePortFile(entry, info, cutoff) {
    const time = entry.startedAt === undefined ? info?.mtimeMs : entry.startedAt;
    return typeof time === 'number' && Number.isFinite(time) && time < cutoff;
}
async function removeStalePortFile(path, raw, info, beforeRemove) {
    if (!info)
        return;
    await beforeRemove?.(path);
    try {
        // A live PID may have replaced its old record while the sweep was reading it.
        const current = await readPrivateText(path);
        const identity = await stat(path);
        if (current === raw &&
            identity.dev === info.dev &&
            identity.ino === info.ino &&
            identity.mtimeMs === info.mtimeMs &&
            identity.size === info.size)
            await unlink(path).catch(() => { });
    }
    catch (error) {
        if (error instanceof PrivateFileError && error.code !== 'ENOENT')
            throw error;
    }
}
/**
 * A PID a liveness probe may address. `process.kill(0 | negative, 0)` signals
 * a process group rather than a process, and an unsafe integer cannot name a
 * real process, so neither is ever probed.
 */
function isProbeablePid(pid) {
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
}
function pidAlive(pid) {
    if (!isProbeablePid(pid))
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
export function createManagedRpcStateDirPredicate(directoryPrefix) {
    return (name) => isManagedRpcStateDir(name, directoryPrefix);
}
export function isManagedRpcStateDir(name, directoryPrefix) {
    if (/^[0-9a-f]{16}$/.test(name))
        return true;
    return (name.startsWith(directoryPrefix) &&
        /^[0-9a-f]{16}$/.test(name.slice(directoryPrefix.length)));
}
export function getRpcDir(rpcRoot, directoryPrefix, projectDirectory) {
    return join(rpcRoot, directoryPrefix +
        createHash('sha256').update(projectDirectory).digest('hex').slice(0, 16));
}
/** The PID a port file's name claims, or undefined for a malformed name. */
function filenamePid(name) {
    const match = /^port-(\d+)\.json$/.exec(name);
    return match ? Number(match[1]) : undefined;
}
/**
 * An entry a client may connect to: its PID is probeable and matches the PID
 * in its file name (a mismatch means the file was not written by the server
 * it names), its port is a real TCP port, and its token is non-empty (an
 * absent token would otherwise be sent as `Bearer undefined`).
 */
function isUsablePortFileEntry(value, name) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const { pid, port, token } = value;
    return (isProbeablePid(pid) &&
        filenamePid(name) === pid &&
        typeof port === 'number' &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65_535 &&
        typeof token === 'string' &&
        token.length > 0);
}
async function removeCorruptPortFile(portFile, log) {
    log?.debug('rpc corrupt port file', { pid: process.pid, portFile });
    await unlink(portFile).catch(() => { });
}
export async function writePortFile(dir, entry, options = {}) {
    // The directory can be removed by another project's sweep between our
    // mkdir and the first open/rename, so the whole create-then-rename
    // unit is retried once on ENOENT. The retry recreates the directory; a
    // persistent ENOENT (e.g. permission, read-only parent) will surface on
    // the second attempt — failing fast beats an unbounded loop.
    const writeOnce = async () => {
        const target = join(dir, `port-${entry.pid}.json`);
        if (windowsPrivateFiles) {
            await ensurePrivateDirectory(dir, options.secureDir ?? false);
            await options.beforeWrite?.();
            await writePrivateAtomic(target, JSON.stringify({ ...entry, startedAt: Date.now() }), {
                stagePath: `${target}.${(options.stageName ?? randomUUID)()}.tmp`,
            });
            return target;
        }
        await mkdir(dir, {
            recursive: true,
            mode: options.secureDir ? 0o700 : undefined,
        });
        if (options.secureDir)
            await chmod(dir, 0o700);
        await options.beforeWrite?.();
        const full = { ...entry, startedAt: Date.now() };
        const tmp = `${target}.${(options.stageName ?? randomUUID)()}.tmp`;
        let handle;
        let created = false;
        try {
            handle = await open(tmp, 'wx', 0o600);
            created = true;
            await handle.writeFile(JSON.stringify(full), 'utf8');
            await handle.chmod(0o600);
            await handle.close();
            handle = undefined;
            await rename(tmp, target);
            created = false;
        }
        finally {
            await handle?.close().catch(() => { });
            // Remove token-bearing staging bytes only if this call created them.
            if (created)
                await unlink(tmp).catch(() => { });
        }
        return target;
    };
    try {
        return await writeOnce();
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return await writeOnce();
        }
        throw error;
    }
}
export async function sweepRpcState(root, activeDir, isManagedDir, log, options = {}) {
    const cutoff = staleBefore(options);
    let projectDirs;
    try {
        projectDirs = await readdir(root, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    const active = resolve(activeDir);
    for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory() || !isManagedDir(projectDir.name)) {
            continue;
        }
        const dir = join(root, projectDir.name);
        let names;
        try {
            names = await readdir(dir);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw error;
        }
        for (const name of names) {
            if (!name.startsWith('port-') || !name.endsWith('.json'))
                continue;
            const portFile = join(dir, name);
            const info = await stat(portFile).catch(() => undefined);
            let raw;
            try {
                raw = await readPrivateText(portFile);
            }
            catch (error) {
                if (error instanceof PrivateFileError && error.code !== 'ENOENT')
                    throw error;
                continue;
            }
            if (raw === undefined)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                await removeCorruptPortFile(portFile, log);
                continue;
            }
            if (!isUsablePortFileEntry(parsed, name)) {
                await removeCorruptPortFile(portFile, log);
                continue;
            }
            const entry = parsed;
            if (!pidAlive(entry.pid))
                await unlink(portFile).catch(() => { });
            else if (isStalePortFile(entry, info, cutoff))
                await removeStalePortFile(portFile, raw, info, options.beforeRemove);
        }
        if (resolve(dir) !== active)
            await rmdir(dir).catch(() => { });
    }
}
/** Internal cache validation: probe only the selected file and its PID. */
export async function portFileIdentity(dir, entry, options = {}) {
    const cutoff = staleBefore(options);
    if (!pidAlive(entry.pid))
        return null;
    const path = join(resolve(dir), `port-${entry.pid}.json`);
    try {
        if (windowsPrivateFiles)
            await verifyPrivate(path, 'file');
        const info = await stat(path);
        if (isStalePortFile(entry, info, cutoff))
            return null;
        return `${path}:${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    }
    catch (error) {
        if (error instanceof PrivateFileError && error.code !== 'ENOENT')
            throw error;
        return null;
    }
}
export async function discoverPortFile(dir, expectedPid, options = {}) {
    const cutoff = staleBefore(options);
    let names;
    try {
        if (windowsPrivateFiles)
            await verifyPrivate(dir, 'directory');
        names = await readdir(dir);
    }
    catch (error) {
        if (error instanceof PrivateFileError && error.code !== 'ENOENT')
            throw error;
        return null;
    }
    const live = [];
    for (const name of names) {
        if (!name.startsWith('port-') || !name.endsWith('.json'))
            continue;
        try {
            const parsed = JSON.parse(await readPrivateText(join(dir, name)));
            if (isUsablePortFileEntry(parsed, name)) {
                if (pidAlive(parsed.pid)) {
                    const info = parsed.startedAt === undefined
                        ? await stat(join(dir, name)).catch(() => undefined)
                        : undefined;
                    if (!isStalePortFile(parsed, info, cutoff))
                        live.push(parsed);
                }
                else
                    await unlink(join(dir, name)).catch(() => { });
            }
        }
        catch (error) {
            if (error instanceof PrivateFileError && error.code !== 'ENOENT')
                throw error;
        }
    }
    if (live.length === 0)
        return null;
    const candidates = expectedPid !== undefined && expectedPid >= 1
        ? live.filter((entry) => entry.pid === expectedPid)
        : [];
    if (options.exactPid === true && candidates.length === 0)
        return null;
    const entries = candidates.length > 0 ? candidates : live;
    const sortTime = (entry) => typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt)
        ? entry.startedAt
        : -Infinity;
    return entries.sort((a, b) => sortTime(b) - sortTime(a))[0] ?? null;
}
