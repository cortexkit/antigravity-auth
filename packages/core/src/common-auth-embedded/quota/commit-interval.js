// Atomic quota commits create locks, markers and a renamed temp file. Keep
// those filesystem events at least 30 s apart under normal load; routing sees
// pending readings immediately, while other processes may lag by one interval.
// Shutdown drains and a full bounded pool queue can commit sooner.
// The vault shares one gate per resolved path; each pool handle has its own.
// N pool handles on one file can therefore make N normal commits per interval
// in one process. These gates do not coordinate with other processes.
export const QUOTA_COMMIT_INTERVAL_MS = 30_000;
export const quotaCommitTimer = {
    now: () => performance.now(),
    schedule(delayMs, run) {
        const timer = setTimeout(() => void run(), delayMs);
        return {
            cancel: () => clearTimeout(timer),
            unref: () => timer.unref?.(),
        };
    },
};
