import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile, } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LockOwnershipError, lockPathFor } from './with-lock.js';
const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis);
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis);
// A concurrent contender renaming the freshly-created eviction-marker directory
// away surfaces the vanished parent differently per platform: ENOENT on Linux,
// EINVAL or ENOTDIR on macOS/APFS. All three mean the marker is no longer ours
// to hold — a lost race the caller should retry, not a fatal lock error.
export function isLostMarkerRaceError(error) {
    const code = error?.code;
    return code === 'ENOENT' || code === 'EINVAL' || code === 'ENOTDIR';
}
export async function acquireRefreshFileLock(options) {
    const lockPath = lockPathFor(options.path, options.name);
    const legacyOwnerPath = join(lockPath, 'owner.json');
    const ownerId = randomUUID();
    const now = options.now ?? Date.now;
    let renewTimer = null;
    let released = false;
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
            await rename(tempPath, lockPath);
            created = false;
        }
        finally {
            await handle?.close().catch(() => { });
            if (created)
                await rm(tempPath, { force: true }).catch(() => { });
        }
    }
    async function tryAcquire() {
        try {
            await writeFile(lockPath, `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            return true;
        }
        catch (error) {
            const code = error.code;
            if (code === 'EEXIST' || code === 'EISDIR')
                return false;
            if (code === 'ENOENT') {
                // Reboots can clear runtime temp directories before the next lock acquisition.
                await mkdir(dirname(lockPath), { recursive: true });
                try {
                    await writeFile(lockPath, `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                    return true;
                }
                catch (retryError) {
                    const retryCode = retryError.code;
                    if (retryCode === 'EEXIST' || retryCode === 'EISDIR')
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
    async function lockIsLive() {
        try {
            const currentOwner = await readOwner();
            return Number(currentOwner?.expiresAt) > now();
        }
        catch {
            try {
                const current = await stat(lockPath);
                return current.mtimeMs + options.ttlMs > now();
            }
            catch {
                // Lock doesn't exist — safe to acquire.
                return false;
            }
        }
    }
    // Fail-closed: any read error means we do NOT own the marker.
    async function ownsEvictionMarker() {
        try {
            const owner = JSON.parse(await readFile(evictOwnerPath, 'utf8'));
            return owner?.ownerId === evictOwnerId;
        }
        catch {
            return false;
        }
    }
    async function releaseEvictionMarker() {
        if (await ownsEvictionMarker()) {
            await rm(evictPath, { recursive: true, force: true }).catch(() => { });
        }
    }
    async function tryAcquireEvictionMarker() {
        await mkdir(evictPath);
        try {
            await writeFile(evictOwnerPath, `${JSON.stringify({ ownerId: evictOwnerId, createdAt: now() })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        }
        catch (error) {
            // A competing contender can rename our just-created marker directory
            // away between the mkdir above and this write (the stale-marker steal
            // path below does exactly that). That is a lost race, not a failure, so
            // report it as such and let the caller back off and retry rather than
            // failing the whole lock acquisition.
            if (isLostMarkerRaceError(error))
                return false;
            await releaseEvictionMarker();
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
        if (evictStat.mtimeMs + EVICT_TTL > now())
            return 'fresh';
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
        await rm(claimedPath, { recursive: true, force: true }).catch(() => { });
        return 'recovered';
    }
    async function withEvictionMarker(action) {
        try {
            if (!(await tryAcquireEvictionMarker()))
                return false;
        }
        catch (error) {
            if (error.code === 'EEXIST')
                return false;
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
            catch {
                return;
            }
            if (owner?.ownerId !== ownerId)
                return;
            try {
                await rm(lockPath, { recursive: true, force: true });
                return;
            }
            catch {
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
                catch {
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
            if (await lockIsLive())
                return contended();
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
                if (await lockIsLive())
                    return contended();
                // Verify marker ownership before removing a lock found not live.
                if (!(await ownsEvictionMarker()))
                    return null;
                if (options.onStep)
                    await options.onStep('stale-lock-confirmed');
                // The onStep callback can pause while another contender renames
                // our marker, so verify ownership again after the callback.
                if (!(await ownsEvictionMarker()))
                    return null;
                await rm(lockPath, { recursive: true, force: true }).catch(() => { });
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
            catch {
                // Unreadable ownership is not evidence of a valid lease.
                recordLoss('unreadable');
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
        release: async () => {
            released = true;
            cancelRenewalTimer();
            await renewalInFlight;
            for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
                try {
                    const markerAcquired = await withEvictionMarker(async () => {
                        const owner = await readOwner();
                        if (owner?.ownerId !== ownerId)
                            return;
                        if (options.onStep)
                            await options.onStep('release-owner-confirmed');
                        if (!(await ownsEvictionMarker()))
                            return;
                        await rm(lockPath, { recursive: true, force: true }).catch(() => { });
                    });
                    if (markerAcquired)
                        return;
                    await recoverStaleEvictionMarker();
                }
                catch {
                    return;
                }
                await backoff();
            }
            // Do not delete by pathname without the marker: bounded retries leave the
            // lease to expire rather than risking removal of a successor's lock.
        },
    };
}
