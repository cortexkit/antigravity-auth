/**
 * Combine abort signals without relying on `AbortSignal.any`, which is missing
 * from early Node 20 releases. Call `dispose` when the operation using the
 * combined signal settles so long-lived source signals do not retain listeners.
 */
export function combineAbortSignals(signals) {
    const controller = new AbortController();
    const listeners = [];
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        for (const { source, listener } of listeners) {
            source.removeEventListener('abort', listener);
        }
        listeners.length = 0;
    };
    const abort = (reason) => {
        if (disposed || controller.signal.aborted)
            return;
        controller.abort(reason);
        dispose();
    };
    const alreadyAborted = signals.find((signal) => signal.aborted);
    if (alreadyAborted) {
        controller.abort(alreadyAborted.reason);
        return { signal: controller.signal, dispose };
    }
    for (const source of signals) {
        if (controller.signal.aborted)
            break;
        const listener = () => abort(source.reason);
        listeners.push({ source, listener });
        source.addEventListener('abort', listener, { once: true });
        // Cover a source that aborts after the initial check but before its listener
        // is installed.
        if (source.aborted)
            abort(source.reason);
    }
    return { signal: controller.signal, dispose };
}
