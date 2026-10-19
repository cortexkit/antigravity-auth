import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export const windowsPrivateFiles = process.platform === 'win32';
const migrationNotices = new Set();
function ioCode(detail) {
    // Native errors retain their Win32 code. Only demonstrated absence/exclusive
    // collisions are normalized; access/sharing failures never become lost races.
    if (detail?.reason === 'io-error') {
        if (detail.win32Code === 2 || detail.win32Code === 3)
            return 'ENOENT';
        if (detail.win32Code === 80 || detail.win32Code === 183)
            return 'EEXIST';
    }
    return detail?.code ?? 'ERR_PRIVATE_FILE';
}
// Production loads this package only on Windows; POSIX keeps its own directory policy.
let backend;
/** Tests inject a backend here; production always imports the private-files package. */
export function setPrivateFilesBackendForTest(api) {
    backend = api ? Promise.resolve(api) : undefined;
}
function loadBackend() {
    backend ??= import('@cortexkit/private-files');
    return backend;
}
export class PrivateFileError extends Error {
    path;
    stage;
    code;
    win32Code;
    reason;
    published = false;
    durabilityConfirmed = false;
    fileDurable = false;
    attempts = 0;
    elapsedMs = 0;
    orphanPath;
    constructor(path, stage, cause) {
        const detail = cause;
        super(`Private file refused at ${stage}: ${path} (${detail?.reason ?? detail?.code ?? 'io-error'}). Use a safe parent directory. Repair only a named secret file in safe ancestry whose owner the published policy trusts, without changing its owner or any existing directory. Previously exposed credentials may need rotation. Windows requires the private-files native prebuild and an ACL-persisting local filesystem such as NTFS.`, { cause });
        this.path = path;
        this.stage = stage;
        this.name = 'PrivateFileError';
        this.code = ioCode(detail);
        this.win32Code = detail?.win32Code;
        this.reason = detail?.reason;
    }
}
export async function privateOperation(path, stage, operation) {
    try {
        return await operation();
    }
    catch (cause) {
        if (cause instanceof PrivateFileError)
            throw cause;
        throw new PrivateFileError(path, stage, cause);
    }
}
// Tests inject metadata into safe-parent checks, including checks deep inside
// callers that take no policy options. Production never sets this.
let safeParentOptionsForTest;
/** Tests only: policy options used by safe-parent checks that pass none. */
export function setSafeParentOptionsForTest(options) {
    safeParentOptionsForTest = options;
}
/** Existing containing directories use the shared entry-integrity policy, not secret-file permissions. */
export async function verifySafeDirectory(path, options) {
    path = resolve(path);
    options ??= safeParentOptionsForTest;
    await privateOperation(path, 'safe-parent', async () => {
        const result = await (await loadBackend()).verifySafeParent(path, options);
        if (result.ok === false) {
            // Preserve an absent parent's ENOENT so callers can create it privately.
            if (result.reason === 'io-error' || result.reason === 'wrong-kind')
                await lstat(path);
            throw new PrivateFileError(result.level ?? result.path, 'safe-parent', {
                ...result,
                code: 'ERR_PRIVATE_FILES_SECURITY',
            });
        }
    });
}
/** Repair only the specific owned secret file supplied by a caller, never an existing directory tree. */
export async function verifyPrivate(path, kind, migrate = false) {
    path = resolve(path);
    if (kind === 'directory')
        return verifySafeDirectory(path);
    await privateOperation(path, 'verify', async () => {
        const api = await loadBackend();
        const result = await api.verifyOwnerOnly(path);
        let repaired = false;
        if (!result.ok) {
            const { reason } = result.refusal;
            // The result API intentionally omits native IO codes. Use the throwing
            // API to preserve absence/collision details, never infer them from text.
            if (reason === 'io-error')
                await api.verifyPrivatePath(path, kind);
            // DACL replacement repairs permissions only, never ownership or unsafe ancestry.
            if (migrate &&
                [
                    api.EXTRA_ACE,
                    api.NOT_PROTECTED,
                    api.NULL_DACL,
                    api.EMPTY_DACL,
                ].includes(reason)) {
                await verifySafeDirectory(dirname(path));
                await api.securePrivatePath(path, kind);
                repaired = true;
            }
            else {
                throw Object.assign(new Error('Owner-only verification refused'), {
                    reason,
                    code: 'ERR_PRIVATE_FILES_SECURITY',
                });
            }
        }
        // Verify the expected object kind and its permissions by handle after repair.
        await api.verifyPrivatePath(path, kind);
        if (repaired && !migrationNotices.has(path)) {
            migrationNotices.add(path);
            process.emitWarning(`Private permissions tightened: ${path}. This object may have been readable before; rotate credentials if needed.`, 'PrivateFileMigration');
        }
    });
}
/** Create missing components privately; inspect existing ancestors without modifying them. */
export async function ensurePrivateDirectory(path, _migrate = false, options) {
    path = resolve(path);
    await privateOperation(path, 'directory', async () => {
        const api = await loadBackend();
        try {
            await lstat(path);
            return await verifySafeDirectory(path, options);
        }
        catch (error) {
            if (ioCode(error) !== 'ENOENT')
                throw error;
        }
        const parent = dirname(path);
        if (parent === path)
            throw Object.assign(new Error('Missing root'), { code: 'ENOENT' });
        await ensurePrivateDirectory(parent, false, options);
        try {
            await api.createOwnerOnly(path, { kind: 'dir' });
        }
        catch (error) {
            if (ioCode(error) !== 'EEXIST')
                throw error;
        }
        await verifySafeDirectory(path, options);
    });
}
export async function readPrivateText(path, migrate = false) {
    if (!windowsPrivateFiles)
        return readFile(path, 'utf8');
    return (await readPrivateBuffer(path, migrate)).toString('utf8');
}
export async function readPrivateBuffer(path, migrate = false) {
    if (!windowsPrivateFiles)
        return readFile(path);
    path = resolve(path);
    if (migrate) {
        await verifySafeDirectory(dirname(path));
        await verifyPrivate(path, 'file', true);
    }
    return privateOperation(path, 'read', async () => (await loadBackend()).readOwnerOnly(path));
}
export async function createPrivateBytes(path, bytes) {
    await verifySafeDirectory(dirname(resolve(path)));
    await privateOperation(path, 'create', async () => {
        // The backend verifies the creation handle while empty, before consuming bytes.
        await (await loadBackend()).createPrivateFile(resolve(path), bytes);
    });
}
export async function createPrivateDirectoryExclusive(path) {
    await verifySafeDirectory(dirname(resolve(path)));
    await privateOperation(path, 'directory-create', async () => {
        await (await loadBackend()).createOwnerOnly(resolve(path), { kind: 'dir' });
    });
}
/** Retry Windows rename sharing/access errors within a budget; they never prove lease contention. */
export async function replaceWindowsFile(from, to, options = {}) {
    from = resolve(from);
    to = resolve(to);
    const now = options.now ?? (() => performance.now());
    const start = now();
    const leaseDeadline = options.deadline ?? Infinity;
    let retryDeadline;
    const delays = [0, 10, 20, 40, 80, 100];
    let original;
    let attempts = 0;
    for (const delay of delays) {
        const deadline = Math.min(retryDeadline ?? Infinity, leaseDeadline);
        if (now() >= deadline)
            break;
        if (delay)
            await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(Math.min(delay, Math.max(0, deadline - now())));
        if (now() >= deadline)
            break;
        const fenceStart = now();
        await options.beforeRename?.();
        // Ownership checks fence every attempt but do not spend the sharing-retry budget.
        if (retryDeadline !== undefined)
            retryDeadline += now() - fenceStart;
        if (now() >= leaseDeadline)
            break;
        attempts++;
        try {
            await (options.rename ?? rename)(from, to);
            return { attempts, elapsedMs: now() - start };
        }
        catch (error) {
            original ??= error;
            const detail = error;
            const candidate = detail.win32Code !== undefined
                ? detail.win32Code === 32 || detail.win32Code === 33
                : ['EBUSY', 'EPERM', 'EACCES'].includes(detail.code ?? '') &&
                    !detail.reason;
            if (!candidate)
                break;
            // Start the retry window only once a rename has actually failed.
            retryDeadline ??= now() + 500;
        }
    }
    const error = new PrivateFileError(to, 'rename', original ??
        Object.assign(new Error('Publication deadline expired'), {
            code: 'ETIMEDOUT',
        }));
    error.attempts = attempts;
    error.elapsedMs = now() - start;
    throw error;
}
export async function writePrivateAtomic(path, bytes, options = {}) {
    path = resolve(path);
    await ensurePrivateDirectory(dirname(path));
    try {
        await verifyPrivate(path, 'file', true);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const stage = resolve(options.stagePath ?? `${path}.${randomUUID()}.tmp`);
    if (dirname(stage) !== dirname(path))
        throw new PrivateFileError(path, 'stage-directory', { code: 'EXDEV' });
    let created = false;
    let published = false;
    let outcome = { attempts: 0, elapsedMs: 0 };
    let stageName = 'stage-create';
    const reportOutcome = (error) => {
        try {
            options.onOutcome?.({
                path,
                stage: error?.stage ?? 'published',
                published,
                fileDurable: published,
                durabilityConfirmed: false,
                attempts: error?.attempts ?? outcome.attempts,
                elapsedMs: error?.elapsedMs ?? outcome.elapsedMs,
                ...(error && { code: error.code, win32Code: error.win32Code }),
            });
        }
        catch {
            // Outcome observers cannot change whether publication succeeded.
        }
    };
    try {
        await createPrivateBytes(stage, bytes);
        created = true;
        stageName = 'before-rename';
        outcome = await replaceWindowsFile(stage, path, options);
        created = false;
        published = true;
        stageName = 'published-callback';
        options.onRenamed?.();
        stageName = 'published-verify';
        await verifyPrivate(path, 'file');
        // createPrivateFile flushes the file. Directory metadata durability has not
        // been qualified on Windows, so never promise the POSIX directory fsync.
        if (options.durable && options.durability !== 'file-only-on-windows')
            throw new PrivateFileError(path, 'directory-sync-unsupported', {
                code: 'ENOTSUP',
            });
        reportOutcome();
    }
    catch (cause) {
        const error = cause instanceof PrivateFileError
            ? cause
            : new PrivateFileError(path, stageName, cause);
        error.published = published;
        error.fileDurable = published;
        if (published)
            Object.assign(error, outcome);
        if (created) {
            try {
                await unlink(stage);
            }
            catch {
                error.orphanPath = stage;
            }
            created = false;
        }
        reportOutcome(error);
        throw error;
    }
    finally {
        if (created)
            await unlink(stage).catch(() => { });
    }
}
