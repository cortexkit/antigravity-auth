import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, stat, } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPrivateBytes, createPrivateDirectoryExclusive, ensurePrivateDirectory, PrivateFileError, privateOperation, readPrivateText, verifyPrivate, windowsPrivateFiles, writePrivateAtomic, } from './private-files.js';
import { LockOwnershipError, lockPathFor } from './with-lock.js';
/**
 * Create a new owner-only file and write `text` into it, failing with EEXIST if
 * the file already exists. Writing through the handle rather than path-based
 * `writeFile(path, …, { flag: 'wx' })` matters: Bun's path form also truncates
 * the file it has just created, and on some Linux filesystems (XFS under load)
 * that redundant ftruncate stalls for hundreds of milliseconds, inside every
 * lock acquisition.
 */
async function createExclusiveText(path, text) {
    const handle = await open(path, 'wx', 0o600);
    let createdStat;
    try {
        createdStat = await handle.stat();
    }
    catch {
        createdStat = undefined;
    }
    try {
        await handle.writeFile(text, 'utf8');
    }
    catch (error) {
        // A failed write after an exclusive create leaves a partial file behind.
        // Remove only the file just created: when a contender has meanwhile
        // replaced the path, the identities differ and the successor is left
        // alone. Removal failures must never mask the original write error.
        try {
            const current = await lstat(path).catch(() => undefined);
            if (createdStat &&
                current &&
                current.dev === createdStat.dev &&
                current.ino === createdStat.ino) {
                await rm(path, { force: true }).catch(() => { });
            }
        }
        catch {
            // Best effort only; the original error below explains the failure.
        }
        throw error;
    }
    finally {
        await handle.close();
    }
}
const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis);
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis);
// A concurrent contender renaming the freshly-created eviction-marker directory
// away surfaces the vanished parent differently per platform: ENOENT on Linux,
// EINVAL or ENOTDIR on macOS/APFS. All three mean the marker is no longer ours
// to hold — a lost race the caller should retry, not a fatal lock error.
export function isLostMarkerRaceError(error) {
    const code = error?.code;
    return (code === 'ENOENT' ||
        (!windowsPrivateFiles && (code === 'EINVAL' || code === 'ENOTDIR')));
}
let evictionMarkerTestHooks;
/**
 * Tests only: inject a failure or a directory replacement between the
 * eviction-marker mkdir and its owner.json write. Production never sets this.
 * Not exported from the fs entry point, so it is not part of the public API.
 */
export function setEvictionMarkerTestHooksForTest(hooks) {
    evictionMarkerTestHooks = hooks;
}
function sameMarkerDirectory(created, current) {
    if (created.dev !== current.dev || created.ino !== current.ino)
        return false;
    // Windows reports the directory identity as a file id that can be 0; fall
    // back to creation time so a reused id does not look like the same directory.
    if (created.ino === 0 && created.birthtimeMs !== current.birthtimeMs)
        return false;
    return true;
}
/**
 * An ownerless marker older than this is recoverable without waiting for the
 * full eviction TTL. Honest holders write owner.json within tens of
 * milliseconds of the mkdir, so one second leaves wide margin for slow Windows
 * filesystems while still bounding the stall from a crashed holder.
 */
const OWNERLESS_MARKER_GRACE_MS = 1_000;
/** Filesystem leases share wall time across all callers and processes. */
export function acquireRefreshFileLock(options) {
    return acquireRefreshFileLockWithClock({ ...options, now: Date.now });
}
/** @internal Clock seam for lease tests; not exported by the package's fs entry point. */
export async function acquireRefreshFileLockWithClock(options) {
    const lockPath = lockPathFor(options.path, options.name);
    const legacyOwnerPath = join(lockPath, 'owner.json');
    const ownerId = randomUUID();
    const now = options.now ?? Date.now;
    let renewTimer = null;
    let released = false;
    let releaseConfirmed = false;
    let loss;
    let resolveLoss;
    const lostPromise = new Promise((resolve) => {
        resolveLoss = resolve;
    });
    function notifyTimerStep(event) {
        try {
            const result = options.onRenewalTimer?.(event);
            if (result &&
                (typeof result === 'object' || typeof result === 'function') &&
                'then' in result &&
                typeof result.then === 'function') {
                void Promise.resolve(result).catch(() => { });
            }
        }
        catch {
            // Timer observer failures must not replace the lock operation result.
        }
    }
    function cancelRenewalTimer() {
        if (!renewTimer)
            return;
        clearRefreshLockRenewalTimeout(renewTimer);
        renewTimer = null;
        notifyTimerStep('cancelled');
    }
    function recordLoss(reason, owner) {
        if (loss || released)
            return;
        loss = Object.freeze({
            reason,
            expectedOwnerId: ownerId,
            ...(typeof owner?.ownerId === 'string'
                ? { observedOwnerId: owner.ownerId }
                : {}),
            ...(typeof owner?.expiresAt === 'number'
                ? { observedExpiresAt: owner.expiresAt }
                : {}),
        });
        cancelRenewalTimer();
        resolveLoss(loss);
    }
    let terminalIOError;
    let renewalInFlight = null;
    // Only the owner of this exclusively-created marker may remove or renew a
    // lock. A contender recovering a stale marker can accidentally rename a newer
    // marker instead; checking its owner file before each mutation prevents the
    // displaced owner from continuing to act on the lock.
    const evictPath = `${lockPath}.evicting`;
    const evictOwnerPath = join(evictPath, 'owner.json');
    const evictOwnerId = randomUUID();
    const EVICT_TTL = 5_000;
    const MAX_STEAL_ATTEMPTS = 8;
    async function readOwner() {
        if (windowsPrivateFiles) {
            try {
                return JSON.parse(await readPrivateText(lockPath, true));
            }
            catch (error) {
                if (error.code !== 'EISDIR' &&
                    error.reason !== 'wrong-kind')
                    throw error;
                await verifyPrivate(lockPath, 'directory', true);
                return JSON.parse(await readPrivateText(legacyOwnerPath, true));
            }
        }
        try {
            return JSON.parse(await readFile(lockPath, 'utf8'));
        }
        catch (error) {
            const code = error.code;
            if (code !== 'EISDIR')
                throw error;
            return JSON.parse(await readFile(legacyOwnerPath, 'utf8'));
        }
    }
    async function writeOwner() {
        if (windowsPrivateFiles) {
            const owner = await readOwner();
            const remaining = Number(owner?.expiresAt) - now();
            await writePrivateAtomic(lockPath, `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`, {
                deadline: performance.now() + Math.max(0, remaining),
                beforeRename: async () => {
                    const current = await readOwner();
                    if (current?.ownerId !== ownerId ||
                        !(Number(current?.expiresAt) > now()) ||
                        !(await ownsEvictionMarker())) {
                        throw new LockOwnershipError({
                            target: options.path,
                            name: options.name,
                        });
                    }
                },
            });
            return;
        }
        // Readers must see a complete lease, even while renewal is writing.
        const tempPath = `${lockPath}.${randomUUID()}.tmp`;
        let handle;
        let created = false;
        try {
            handle = await open(tempPath, 'wx', 0o600);
            created = true;
            await handle.writeFile(`${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`, 'utf8');
            await handle.chmod(0o600);
            await handle.close();
            handle = undefined;
            const current = await readOwner();
            if (current?.ownerId !== ownerId ||
                !(Number(current?.expiresAt) > now()) ||
                !(await ownsEvictionMarker())) {
                throw new LockOwnershipError({
                    target: options.path,
                    name: options.name,
                });
            }
            await rename(tempPath, lockPath);
            created = false;
        }
        finally {
            await handle?.close().catch(() => { });
            if (created)
                await rm(tempPath, { force: true }).catch(() => { });
        }
    }
    async function createLease() {
        const bytes = `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`;
        if (windowsPrivateFiles)
            await createPrivateBytes(lockPath, bytes);
        else
            await createExclusiveText(lockPath, bytes);
    }
    async function leaseContention(error) {
        const code = error.code;
        if (code !== 'EEXIST' && code !== 'EISDIR')
            return false;
        if (windowsPrivateFiles) {
            if (options.onStep)
                await options.onStep('lease-contention-read-ready');
            try {
                if (code === 'EISDIR') {
                    await verifyPrivate(lockPath, 'directory', true);
                    await readPrivateText(legacyOwnerPath, true);
                }
                else
                    await readOwner();
            }
            catch (readError) {
                // The holder can release after exclusive creation reports a collision.
                // Only absence permits another acquisition attempt; security and sharing
                // refusals must still escape rather than being treated as contention.
                if (readError.code !== 'ENOENT')
                    throw readError;
            }
        }
        return true;
    }
    async function tryAcquire() {
        if (windowsPrivateFiles)
            await ensurePrivateDirectory(dirname(lockPath));
        try {
            await createLease();
            return true;
        }
        catch (error) {
            const code = error.code;
            if (await leaseContention(error))
                return false;
            if (code === 'ENOENT') {
                // Reboots can clear runtime temp directories before the next lock acquisition.
                if (windowsPrivateFiles)
                    await ensurePrivateDirectory(dirname(lockPath));
                else
                    await mkdir(dirname(lockPath), { recursive: true });
                try {
                    await createLease();
                    return true;
                }
                catch (retryError) {
                    if (await leaseContention(retryError))
                        return false;
                    throw retryError;
                }
            }
            throw error;
        }
    }
    async function backoff() {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
    }
    async function readLockState(notifyReady = true) {
        if (notifyReady && options.onStep)
            await options.onStep('lock-read-ready');
        let owner;
        try {
            owner = await readOwner();
        }
        catch (error) {
            if (windowsPrivateFiles &&
                error.code !== 'ENOENT')
                throw error;
        }
        const expiresAt = Number(owner?.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > now())
            return { status: 'live' };
        if (typeof owner?.ownerId === 'string' && Number.isFinite(expiresAt)) {
            return {
                status: 'stale',
                identity: { kind: 'owner', ownerId: owner.ownerId, expiresAt },
            };
        }
        try {
            const current = await stat(lockPath);
            const legacyExpiry = Number.isFinite(expiresAt)
                ? expiresAt
                : current.mtimeMs + options.ttlMs;
            if (legacyExpiry > now())
                return { status: 'live' };
            return {
                status: 'stale',
                identity: {
                    kind: 'stat',
                    dev: current.dev,
                    ino: current.ino,
                    mtimeMs: current.mtimeMs,
                    expiresAt: legacyExpiry,
                },
            };
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                if (options.onStep)
                    await options.onStep('lock-missing');
                return { status: 'missing' };
            }
            throw error;
        }
    }
    function sameStaleLock(observed, current) {
        if (current.status !== 'stale')
            return false;
        const identity = current.identity;
        if (observed.kind === 'owner' && identity.kind === 'owner') {
            return (observed.ownerId === identity.ownerId &&
                observed.expiresAt === identity.expiresAt);
        }
        return (observed.kind === 'stat' &&
            identity.kind === 'stat' &&
            observed.dev === identity.dev &&
            observed.ino === identity.ino &&
            observed.mtimeMs === identity.mtimeMs &&
            observed.expiresAt === identity.expiresAt);
    }
    // Fail-closed: any read error means we do NOT own the marker.
    async function ownsEvictionMarker() {
        try {
            const owner = JSON.parse(await readPrivateText(evictOwnerPath, windowsPrivateFiles));
            return owner?.ownerId === evictOwnerId;
        }
        catch (error) {
            if (windowsPrivateFiles &&
                error.code !== 'ENOENT')
                throw error;
            return false;
        }
    }
    async function removeLeaseObject(path) {
        if (windowsPrivateFiles)
            await privateOperation(path, 'remove', () => rm(path, { recursive: true, force: true }));
        else
            await rm(path, { recursive: true, force: true }).catch(() => { });
    }
    async function releaseEvictionMarker() {
        if (await ownsEvictionMarker()) {
            await removeLeaseObject(evictPath);
        }
    }
    // Returns whether the directory at the marker path was still the one this
    // process created when its owner write failed. Only then is the failure ours
    // to report: a gone or replaced directory is a lost race.
    async function removeOwnMarkerAfterFailedOwnerWrite(created) {
        // Best effort only: never throws, so the original owner-write error below
        // keeps explaining the failure. Removes the directory this process just
        // created when its owner write failed, and leaves a contender's
        // replacement alone when the identities differ.
        if (!created)
            return false;
        let current;
        try {
            const st = await lstat(evictPath);
            current = { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs };
        }
        catch {
            // Renamed away by a contender's steal: nothing of ours left to clean.
            return false;
        }
        if (!sameMarkerDirectory(created, current))
            return false;
        // Remove only an ownerless directory. An owner file that appeared after
        // our failed write belongs to someone: ours goes through
        // releaseEvictionMarker in the caller, and a contender's must stay, since
        // it may be holding the marker right now.
        try {
            await stat(evictOwnerPath);
            return true;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return true;
        }
        try {
            await removeLeaseObject(evictPath);
        }
        catch {
            // A removal failure keeps the stale marker recoverable later; it must
            // never mask the original owner-write error.
        }
        return true;
    }
    async function tryAcquireEvictionMarker() {
        if (windowsPrivateFiles)
            await createPrivateDirectoryExclusive(evictPath);
        else
            await mkdir(evictPath);
        let created;
        try {
            const st = await lstat(evictPath);
            created = { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs };
        }
        catch {
            created = undefined;
        }
        try {
            await evictionMarkerTestHooks?.beforeOwnerWrite?.(evictPath, evictOwnerPath);
            const injected = await evictionMarkerTestHooks?.failOwnerWrite?.(evictPath, evictOwnerPath);
            if (injected !== undefined)
                throw injected;
            const bytes = `${JSON.stringify({ ownerId: evictOwnerId, createdAt: now() })}\n`;
            if (windowsPrivateFiles)
                await createPrivateBytes(evictOwnerPath, bytes);
            else
                await createExclusiveText(evictOwnerPath, bytes);
        }
        catch (error) {
            // A competing contender can rename our just-created marker directory
            // away between the mkdir above and this write (the stale-marker steal
            // path below does exactly that). That is a lost race, not a failure, so
            // report it as such and let the caller back off and retry rather than
            // failing the whole lock acquisition.
            //
            // The race codes alone cannot prove the directory is gone: the same
            // codes can surface while our directory is still in place (for example
            // a permission failure while writing the owner file, which used to
            // leave an ownerless marker behind). The identity fence
            // above removes only the directory this process created, and is a no-op
            // when the contender renamed it away or replaced it, so run it on both
            // branches before deciding between a retry and a failure.
            // A race code while our own directory is still in place is not a lost
            // race but a write that fails here every time: report it, rather than
            // retrying the same failure until a deadline hides the cause.
            const stillOurs = await removeOwnMarkerAfterFailedOwnerWrite(created);
            if (isLostMarkerRaceError(error) && !stillOurs)
                return false;
            try {
                await releaseEvictionMarker();
            }
            catch {
                // Removal must never mask the original owner-write error.
            }
            throw error;
        }
        if (options.onStep)
            await options.onStep('eviction-marker-acquired');
        return true;
    }
    async function recoverStaleEvictionMarker() {
        let evictStat;
        try {
            evictStat = await stat(evictPath);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return 'missing';
            throw error;
        }
        if (windowsPrivateFiles) {
            try {
                await verifyPrivate(evictPath, 'directory', true);
            }
            catch (error) {
                // The marker's holder can remove it between the stat above and this
                // check. Absence means the marker is free, as when the stat finds
                // nothing; every other refusal still escapes.
                if (error.code === 'ENOENT')
                    return 'missing';
                throw error;
            }
        }
        if (evictStat.mtimeMs + EVICT_TTL > now()) {
            // A fresh marker with no owner is either this process's orphan (its
            // owner write just failed) or a holder that crashed between mkdir and
            // owner write. Honest holders publish owner.json within tens of
            // milliseconds, so recover ownerless markers after a short grace instead
            // of stalling for the full TTL. Stealing one is safe: a live holder
            // stalled past the grace sees its pending owner write fail with ENOENT
            // (a lost race) and retries, rather than acting on a stolen marker.
            let hasOwner = true;
            try {
                await stat(evictOwnerPath);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    hasOwner = false;
                else
                    return 'fresh';
            }
            if (hasOwner)
                return 'fresh';
            if (evictStat.mtimeMs + OWNERLESS_MARKER_GRACE_MS > now())
                return 'fresh';
        }
        if (options.onStep)
            await options.onStep('stale-marker-stat');
        const claimedPath = `${evictPath}.${randomUUID()}`;
        try {
            await rename(evictPath, claimedPath);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return 'missing';
            throw error;
        }
        if (options.onStep)
            await options.onStep('stale-marker-claimed');
        await removeLeaseObject(claimedPath);
        return 'recovered';
    }
    async function withEvictionMarker(action) {
        try {
            if (!(await tryAcquireEvictionMarker()))
                return false;
        }
        catch (error) {
            if (error.code === 'EEXIST') {
                if (windowsPrivateFiles) {
                    try {
                        await verifyPrivate(evictPath, 'directory', true);
                        await readPrivateText(evictOwnerPath, true);
                    }
                    catch (ownerError) {
                        // A marker removed by its holder after the failed create is free:
                        // report it as unavailable for now so the caller retries.
                        if (ownerError.code !== 'ENOENT')
                            throw ownerError;
                    }
                }
                return false;
            }
            throw error;
        }
        try {
            await action();
        }
        finally {
            await releaseEvictionMarker();
        }
        return true;
    }
    // Marker loss after a write may mean another contender has taken over.
    // Delete only a record still owned by us, so an already-installed
    // successor is preserved. The owner read and the removal are not atomic:
    // a successor record written between them can still be deleted.
    async function relinquishLockAfterMarkerLoss() {
        for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
            if (options.onStep)
                await options.onStep('relinquish-read');
            let owner;
            try {
                owner = await readOwner();
            }
            catch (error) {
                if (windowsPrivateFiles)
                    throw error;
                return;
            }
            if (owner?.ownerId !== ownerId)
                return;
            try {
                await rm(lockPath, { recursive: true, force: true });
                return;
            }
            catch (error) {
                if (windowsPrivateFiles)
                    throw error;
                await backoff();
            }
        }
    }
    function scheduleRenewal() {
        if (!options.renew || released || loss)
            return;
        const intervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(options.ttlMs / 3));
        renewTimer = setRefreshLockRenewalTimeout(() => {
            renewTimer = null;
            const renewal = (async () => {
                let shouldReschedule = !released;
                try {
                    const markerAcquired = await withEvictionMarker(async () => {
                        const owner = await readOwner();
                        const currentNow = now();
                        if (released || loss) {
                            shouldReschedule = false;
                            return;
                        }
                        if (owner?.ownerId !== ownerId) {
                            recordLoss('taken-over', owner);
                            shouldReschedule = false;
                            return;
                        }
                        // An expired lease is no longer ours to extend; a contender may
                        // already be eligible to acquire it.
                        if (!(Number(owner?.expiresAt) > currentNow)) {
                            recordLoss('expired', owner);
                            shouldReschedule = false;
                            return;
                        }
                        if (options.onStep)
                            await options.onStep('renewal-owner-confirmed');
                        if (released || loss) {
                            shouldReschedule = false;
                            return;
                        }
                        if (!(await ownsEvictionMarker()))
                            return;
                        if (options.onStep)
                            await options.onStep('renewal-write-fenced');
                        if (released || loss) {
                            shouldReschedule = false;
                            return;
                        }
                        if (!(await ownsEvictionMarker()))
                            return;
                        if (options.onStep)
                            await options.onStep('renewal-write-ready');
                        if (released || loss) {
                            shouldReschedule = false;
                            return;
                        }
                        await writeOwner();
                        if (options.onStep)
                            await options.onStep('renewal-write-finished');
                        if (!(await ownsEvictionMarker())) {
                            // If marker ownership cannot be read, stop claiming the lease
                            // and remove only a record that still carries our owner id.
                            recordLoss('marker-lost');
                            shouldReschedule = false;
                            await relinquishLockAfterMarkerLoss();
                            return;
                        }
                    });
                    if (!markerAcquired && options.onStep) {
                        await options.onStep('renewal-marker-unavailable');
                    }
                }
                catch (error) {
                    if (windowsPrivateFiles && error instanceof PrivateFileError) {
                        terminalIOError = error;
                        recordLoss('renewal-failed');
                        shouldReschedule = false;
                    }
                    // Retry transient failures only while the lease can still be verified.
                    try {
                        const owner = await readOwner();
                        if (owner?.ownerId !== ownerId)
                            recordLoss('taken-over', owner);
                        else if (!(Number(owner?.expiresAt) > now()))
                            recordLoss('expired', owner);
                    }
                    catch {
                        recordLoss('renewal-failed');
                    }
                }
                finally {
                    if (options.onStep) {
                        try {
                            await options.onStep('renewal-finished');
                        }
                        catch {
                            // Errors from the onStep observer must not reject the renewal.
                        }
                    }
                    if (shouldReschedule && !released && !loss)
                        scheduleRenewal();
                }
            })();
            renewalInFlight = renewal;
            void renewal.finally(() => {
                if (renewalInFlight === renewal)
                    renewalInFlight = null;
            });
        }, intervalMs);
        if ('unref' in renewTimer)
            renewTimer.unref();
        notifyTimerStep('scheduled');
    }
    function contended() {
        try {
            const result = options.onContended?.();
            if (result &&
                (typeof result === 'object' || typeof result === 'function') &&
                'then' in result &&
                typeof result.then === 'function') {
                void Promise.resolve(result).catch(() => { });
            }
        }
        catch {
            // Observers cannot change whether the lock is acquired.
        }
        return null;
    }
    let acquired = await tryAcquire();
    if (!acquired) {
        for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
            acquired = await tryAcquire();
            if (acquired)
                break;
            const observed = await readLockState();
            if (observed.status === 'live')
                return contended();
            // Absence is a create opportunity, never evidence of an expired lease.
            if (observed.status === 'missing')
                continue;
            if (options.onStep)
                await options.onStep('stale-lock-observed');
            try {
                if (!(await tryAcquireEvictionMarker())) {
                    await backoff();
                    continue;
                }
            }
            catch (evictError) {
                const code = evictError.code;
                if (code !== 'EEXIST')
                    throw evictError;
                const recovered = await recoverStaleEvictionMarker();
                if (recovered === 'fresh')
                    return null;
                await backoff();
                continue;
            }
            try {
                const confirmed = await readLockState();
                if (confirmed.status === 'live')
                    return contended();
                if (!sameStaleLock(observed.identity, confirmed))
                    continue;
                // Verify marker ownership before removing a lock found not live.
                if (!(await ownsEvictionMarker()))
                    return null;
                if (options.onStep)
                    await options.onStep('stale-lock-confirmed');
                // The onStep callback can pause while another contender renames
                // our marker, so verify ownership again after the callback.
                if (!(await ownsEvictionMarker()))
                    return null;
                // Do not await a callback between this ownership check and the lock read.
                const current = await readLockState(false);
                if (!sameStaleLock(observed.identity, current))
                    continue;
                // The final read and removal are not atomic. While this stale file
                // exists, wx cannot create a successor; the marker excludes other
                // evictors and release/renewal. An expired holder cannot renew: renewal
                // rechecks expiry and marker ownership immediately before publishing.
                // With the marker still owned, cooperating users cannot replace it in
                // this window. Arbitrary suspension across marker expiry or filesystem
                // changes still need a kernel lock for an atomic guarantee.
                await removeLeaseObject(lockPath);
                // Fence check 3: re-verify ownership after removing the stale lock.
                if (!(await ownsEvictionMarker()))
                    return null;
                if (options.onStep)
                    await options.onStep('stale-lock-removed');
                acquired = await tryAcquire();
                if (!acquired)
                    return null;
                if (options.onStep)
                    await options.onStep('stale-lock-recreated');
                // Fence check 4: re-verify ownership after acquiring the lock. If the
                // marker was stolen between tryAcquire and this check, release the
                // just-acquired lock and return null (fail-closed).
                if (!(await ownsEvictionMarker())) {
                    await relinquishLockAfterMarkerLoss();
                    acquired = false;
                    return null;
                }
                break;
            }
            finally {
                await releaseEvictionMarker();
            }
        }
    }
    if (!acquired)
        return null;
    scheduleRenewal();
    return {
        ownerId,
        whenLost: () => lostPromise,
        hasLost: () => loss !== undefined,
        assertOwned: async () => {
            if (terminalIOError)
                throw terminalIOError;
            let observed;
            try {
                const owner = await readOwner();
                observed = owner;
                if (!released &&
                    !loss &&
                    owner?.ownerId === ownerId &&
                    Number(owner?.expiresAt) > now())
                    return;
                recordLoss(owner?.ownerId !== ownerId ? 'taken-over' : 'expired', owner);
            }
            catch (error) {
                // Unreadable ownership is not evidence of a valid lease.
                recordLoss('unreadable');
                if (windowsPrivateFiles && error instanceof PrivateFileError)
                    throw error;
            }
            throw new LockOwnershipError({
                target: options.path,
                name: options.name,
                expectedOwnerId: ownerId,
                ...(typeof observed?.ownerId === 'string'
                    ? { observedOwnerId: observed.ownerId }
                    : {}),
                ...(typeof observed?.expiresAt === 'number'
                    ? { observedExpiresAt: observed.expiresAt }
                    : {}),
            });
        },
        release: async (signal) => {
            if (windowsPrivateFiles && releaseConfirmed)
                return;
            released = true;
            cancelRenewalTimer();
            await renewalInFlight;
            // A fresh marker may outlive a few quick retries, especially on Windows.
            // Allow its full TTL plus recovery time, using a monotonic deadline so
            // wall-clock adjustments cannot extend the retry deadline.
            const deadline = performance.now() + EVICT_TTL + 1_000;
            let delayMs = 5;
            for (;;) {
                try {
                    let removalConfirmed = false;
                    const markerAcquired = await withEvictionMarker(async () => {
                        let owner;
                        try {
                            owner = await readOwner();
                        }
                        catch (error) {
                            if (windowsPrivateFiles &&
                                error.code === 'ENOENT') {
                                removalConfirmed = true;
                                return;
                            }
                            throw error;
                        }
                        if (owner?.ownerId !== ownerId) {
                            removalConfirmed = true;
                            return;
                        }
                        if (options.onStep)
                            await options.onStep('release-owner-confirmed');
                        if (!(await ownsEvictionMarker()))
                            return;
                        await removeLeaseObject(lockPath);
                        removalConfirmed = true;
                    });
                    if (markerAcquired) {
                        if (windowsPrivateFiles && !removalConfirmed)
                            throw new PrivateFileError(lockPath, 'release-not-confirmed', {
                                code: 'EIO',
                            });
                        releaseConfirmed = removalConfirmed;
                        return;
                    }
                    if (signal?.aborted)
                        return;
                    await recoverStaleEvictionMarker();
                }
                catch (error) {
                    if (windowsPrivateFiles)
                        throw error;
                    return;
                }
                const remainingMs = deadline - performance.now();
                if (remainingMs <= 0)
                    break;
                await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
                delayMs = Math.min(delayMs * 2, 50);
            }
            // Do not delete by pathname without the marker: bounded retries leave the
            // lease to expire rather than risking removal of a successor's lock.
            if (windowsPrivateFiles)
                throw new PrivateFileError(lockPath, 'release-not-confirmed', {
                    code: 'ETIMEDOUT',
                });
        },
    };
}
