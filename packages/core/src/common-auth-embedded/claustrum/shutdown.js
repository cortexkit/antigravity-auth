/** Retired generations report separately until their owner closes and shares one warning. */
export function shutdownWarning(logger, shutdown) {
    let warned = false;
    return (pendingOperations) => {
        if (warned)
            return;
        if (!shutdown || shutdown.aborted)
            warned = true;
        logger.warn('claustrum shutdown drain timed out', { pendingOperations });
    };
}
/**
 * Give cancelled background work two seconds to release its handles without letting
 * an unresponsive connector or disk hold the host's shutdown indefinitely.
 */
export async function drainShutdown(pending, onTimeout) {
    if (!pending.size)
        return;
    let timer;
    let expired = false;
    const drained = (async () => {
        while (!expired && pending.size)
            await Promise.allSettled([...pending]);
    })();
    try {
        await Promise.race([
            drained,
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    expired = true;
                    resolve();
                }, 2_000);
            }),
        ]);
        if (expired && pending.size)
            onTimeout(pending.size);
    }
    finally {
        expired = true;
        clearTimeout(timer);
    }
}
