import { ClaustrumCredentialError } from '@cortexkit/claustrum-client';
function plain(value) {
    return (value !== null &&
        typeof value === 'object' &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null));
}
/** One queue per custody connection, shared by every hub member on it. */
export class ScopedUsageReporter {
    options;
    #queue = new Map();
    #latest = new Map();
    #errors = new Set();
    #timer;
    #running;
    #closing = false;
    #stopped = false;
    #dropped = 0;
    constructor(options) {
        this.options = options;
    }
    state() {
        return {
            pending: this.#queue.size,
            inFlight: this.#running !== undefined,
            dropped: this.#dropped,
        };
    }
    report(credentialId, reading) {
        if (this.#closing || !this.options.client.reportUsageScoped)
            return;
        try {
            if (!this.options.owns(credentialId)) {
                this.#dropped++;
                return;
            }
            if (!plain(reading) || 'credentialId' in reading || 'vouched' in reading)
                throw new Error('invalid reading');
            const json = JSON.stringify(reading);
            if (Buffer.byteLength(json, 'utf8') > 15_360)
                throw new Error('oversized reading');
            // Snapshot now: a caller mutating its reply metadata later cannot change
            // an already validated queued reading, including its ordering timestamp.
            const copy = JSON.parse(json);
            if (!plain(copy) ||
                'credentialId' in copy ||
                'vouched' in copy ||
                typeof copy.observedAtMs !== 'number' ||
                !Number.isFinite(copy.observedAtMs))
                throw new Error('invalid reading');
            if (copy.observedAtMs <= (this.#latest.get(credentialId) ?? -Infinity)) {
                this.#dropped++;
                return;
            }
            if (this.#queue.has(credentialId))
                this.#dropped++;
            this.#latest.set(credentialId, copy.observedAtMs);
            this.#queue.set(credentialId, copy);
            if (!this.#timer && !this.#running) {
                this.#timer = this.options.setTimeout(() => {
                    this.#timer = undefined;
                    this.#flush();
                }, 1_000);
                this.#timer.unref?.();
            }
        }
        catch {
            this.#dropped++;
        }
    }
    forget(credentialId) {
        if (this.#queue.delete(credentialId))
            this.#dropped++;
        this.#latest.delete(credentialId);
    }
    #flush() {
        if (this.#running || !this.#queue.size || this.#stopped)
            return this.#running;
        // Start on a microtask even during close, so all failures stay off the
        // provider request path and only one send can be in flight on this client.
        const running = Promise.resolve().then(async () => {
            while (!this.#stopped && this.#queue.size) {
                const entry = this.#queue.entries().next().value;
                if (!entry)
                    break;
                const [credentialId, reading] = entry;
                this.#queue.delete(credentialId);
                try {
                    const enrollmentToken = await this.options.token();
                    if (this.#stopped || !this.options.owns(credentialId)) {
                        if (!this.#stopped)
                            this.#dropped++;
                        continue;
                    }
                    await this.options.client.reportUsageScoped?.({
                        credentialId,
                        reading,
                        enrollmentToken,
                    });
                }
                catch (error) {
                    if (!this.#stopped)
                        this.#dropped++;
                    this.#log(error);
                }
            }
        });
        this.#running = running;
        void running.finally(() => {
            this.#running = undefined;
        });
        return running;
    }
    #log(error) {
        // Only codes from credential refusals are exposed. Transport messages,
        // arbitrary thrown objects and reply contents can contain secrets.
        let code = 'transport_error';
        try {
            if (error instanceof ClaustrumCredentialError)
                code = /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : code;
            if (this.#errors.has(code))
                return;
            this.#errors.add(code);
            this.options.logger.debug('claustrum usage report dropped', { code });
        }
        catch {
            // A caller's logger must not turn best-effort reporting into a rejection.
        }
    }
    /** Start the final flush; the custody's existing shutdown drain bounds it. */
    close() {
        this.#closing = true;
        if (this.#timer)
            this.options.clearTimeout(this.#timer);
        this.#timer = undefined;
        return this.#flush();
    }
    drop() {
        this.#stopped = true;
        this.#dropped += this.#queue.size + (this.#running ? 1 : 0);
        this.#running = undefined;
        this.#queue.clear();
        this.#latest.clear();
    }
}
