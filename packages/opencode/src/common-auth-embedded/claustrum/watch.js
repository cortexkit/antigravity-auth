/**
 * While a vault watch is healthy, the roster is still read this often: the
 * watch carries no history, so a lost notice or a silently dead stream is
 * caught within this period.
 */
export const SAFETY_POLL_MS = 5 * 60_000;
/**
 * After a watch fails without being accepted, the host polls and tries one
 * new watch this much later, so a refusing or draining module is never asked
 * in a tight loop.
 */
export const WATCH_RETRY_MS = 5 * 60_000;
/**
 * First wait before re-subscribing a watch that closed after it had been
 * accepted. It doubles for each further close in a row, up to WATCH_RETRY_MS.
 */
export const RESUBSCRIBE_BACKOFF_MS = 1_000;
/**
 * Tells whether a notice follows the previous one with nothing lost between
 * them. `seq` restarts at 1 for every watch and `epoch` names the sending
 * module's process lifetime. A sequence gap (notices are sheddable), a
 * different epoch (the module restarted) or a notice of an unknown kind all
 * mean changes may have been missed, so the caller must re-read everything.
 */
export class ChangeNoticeReader {
    #epoch;
    #seq = 0;
    /**
     * Begin a new watch, whose first notice is seq 1 again. The epoch is kept,
     * so a module restart between two watches still reads as a break.
     */
    restart() {
        this.#seq = 0;
    }
    continuous(notice) {
        const continuous = notice.kind === 'changed' &&
            notice.seq === this.#seq + 1 &&
            (this.#epoch === undefined || notice.epoch === this.#epoch);
        this.#epoch = notice.epoch;
        this.#seq = notice.seq;
        return continuous;
    }
}
/**
 * Runs `read` with at most one call in flight and at most one more queued
 * behind it, however many requests arrive meanwhile. A request made while a
 * read is running may have arrived after that read took its snapshot, so it
 * earns exactly one more read; any further requests share that one.
 */
export class CoalescedRead {
    #read;
    #onError;
    #running;
    #queued = false;
    constructor(read, onError) {
        this.#read = read;
        this.#onError = onError;
    }
    /** The read in flight (including its queued follow-up), if any. */
    get running() {
        return this.#running;
    }
    request() {
        if (this.#running) {
            this.#queued = true;
            return this.#running;
        }
        this.#running = (async () => {
            do {
                this.#queued = false;
                try {
                    await this.#read();
                }
                catch (error) {
                    this.#onError(error);
                }
            } while (this.#queued);
        })().finally(() => {
            this.#running = undefined;
        });
        return this.#running;
    }
}
/**
 * Keeps one vault `watchScoped` open for a host and runs the host's discovery
 * when a notice shows the visible account list changed. Discovery runs only
 * when the notice's view differs from the last discovered roster's view, when
 * a notice shows a gap or a new epoch, or on the first notice of a watch that
 * was re-subscribed after a close (the time between two watches was not
 * observed). It never opens a second watch while one is open.
 */
export class ScopedRosterWatch {
    #options;
    #reader = new ChangeNoticeReader();
    #reads;
    #mode = 'polling';
    #watch;
    #timer;
    #stopped = false;
    #latestView;
    #force = false;
    /**
     * How many accepted watches in a row have closed; each one doubles the wait
     * before the next re-subscribe. Reset once a watch stays up five minutes.
     */
    #closes = 0;
    constructor(options) {
        this.#options = options;
        this.#reads = new CoalescedRead(async () => {
            const force = this.#force;
            this.#force = false;
            // A read is only ever requested by a notice, which set #latestView.
            if (force || this.#latestView !== this.#options.view())
                await this.#options.discover(this.#latestView ?? '');
        }, (error) => {
            if (!this.#stopped)
                this.#options.onError?.(error);
        });
    }
    get mode() {
        return this.#mode;
    }
    start() {
        if (this.#stopped || this.#watch || this.#timer)
            return;
        if (typeof this.#options.client.watchScoped !== 'function') {
            // A claustrum-client older than 0.12.0: poll exactly as before.
            this.#setMode('fallback', 'client-without-watch');
            return;
        }
        void this.#open(false);
    }
    stop() {
        if (this.#stopped)
            return;
        this.#stopped = true;
        if (this.#timer)
            (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer);
        this.#timer = undefined;
        const watch = this.#watch;
        this.#watch = undefined;
        watch?.handle.stop();
    }
    #setMode(mode, reason) {
        if (this.#mode === mode)
            return;
        this.#mode = mode;
        this.#options.logger?.debug('claustrum vault watch', { mode, reason });
        this.#options.onMode?.(mode);
    }
    #later(delay, run) {
        this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
            this.#timer = undefined;
            if (!this.#stopped)
                run();
        }, delay);
        this.#timer.unref?.();
    }
    async #open(resubscribed) {
        let token;
        try {
            token = await this.#options.enrollmentToken();
        }
        catch (error) {
            if (this.#stopped)
                return;
            this.#options.onError?.(error);
            this.#fallback('token-unreadable');
            return;
        }
        const watchScoped = this.#options.client.watchScoped;
        if (this.#stopped || this.#watch || !watchScoped)
            return;
        this.#reader.restart();
        // A re-subscribed watch reads on its first notice: changes made while no
        // watch was open were never announced.
        this.#force = resubscribed;
        let watch;
        let handle;
        try {
            handle = watchScoped.call(this.#options.client, (notice) => {
                if (this.#stopped || !watch || this.#watch !== watch)
                    return;
                watch.notices++;
                if (watch.notices === 1) {
                    this.#options.onReachable?.();
                    watch.acceptedAt = (this.#options.now ?? Date.now)();
                    this.#setMode('watching', 'accepted');
                }
                if (!this.#reader.continuous(notice))
                    this.#force = true;
                this.#latestView = notice.view;
                // The read itself decides whether to list, against the roster as
                // it stands when the read runs.
                void this.#reads.request();
            }, { enrollmentToken: token });
        }
        catch (error) {
            this.#options.onError?.(error);
            this.#fallback('watch-failed');
            return;
        }
        watch = { handle, notices: 0 };
        this.#watch = watch;
        this.#setMode('polling', resubscribed ? 'resubscribing' : 'opening');
        const opened = watch;
        handle.closed.then((end) => this.#closed(opened, end), (error) => this.#closed(opened, { kind: 'transport_lost', error }));
    }
    #closed(watch, end) {
        if (this.#stopped || this.#watch !== watch)
            return;
        this.#watch = undefined;
        if (end.kind === 'stopped')
            return;
        if (end.kind === 'transport_lost')
            this.#options.onTransportLost?.();
        if (end.kind === 'unsupported') {
            // An older vault answers unknown_method: poll exactly as before.
            this.#setMode('fallback', 'vault-without-watch');
            return;
        }
        if (end.kind === 'refused') {
            this.#fallback('refused');
            try {
                this.#options.onRefused(end.error);
            }
            catch (error) {
                this.#options.onError?.(error);
            }
            return;
        }
        if (watch.notices > 0) {
            // An accepted watch that closed (the vault restarted, or a revocation
            // ended it) gets one new watch. A revocation then shows up as that
            // watch's refusal.
            const now = (this.#options.now ?? Date.now)();
            if (watch.acceptedAt !== undefined &&
                now - watch.acceptedAt >= SAFETY_POLL_MS)
                this.#closes = 0;
            const delay = Math.min(RESUBSCRIBE_BACKOFF_MS * 2 ** Math.min(this.#closes, 16), WATCH_RETRY_MS);
            this.#closes++;
            this.#setMode('polling', 'resubscribing');
            this.#later(delay, () => void this.#open(true));
            return;
        }
        // Zero notices: the watch was never accepted (the vault is draining, or
        // the connection failed). The client already made one read to learn why.
        this.#fallback(end.kind);
    }
    #fallback(reason) {
        this.#setMode('fallback', reason);
        this.#later(WATCH_RETRY_MS, () => void this.#open(false));
    }
}
