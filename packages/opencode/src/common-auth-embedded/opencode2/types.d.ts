import type { Plugin } from '@opencode/plugin';
import type { SessionRequestKind, SessionRetryDecision } from '@opencode/plugin/promise/session';
/** The parts of the OpenCode 2 plugin context the installer uses. */
export type OpenCode2HookContext = {
    readonly session: Pick<Plugin.Context['session'], 'hook'>;
    /** Used only to forget per-session records when a session is deleted. */
    readonly event?: Pick<Plugin.Context['event'], 'subscribe'>;
};
export type RequestKind = SessionRequestKind;
/** Which request a hook call belongs to, as the host reports it. */
export interface RequestScope {
    readonly providerID: string;
    readonly modelID: string;
    readonly sessionID: string;
    readonly agent: string;
    readonly kind: RequestKind;
}
/** Where a reading or a refusal was seen. */
export type Transport = 'http' | 'ws';
/**
 * A provider refusal that should move the request to another account: a rate
 * limit, an exhausted usage window, or anything else the adapter decides is
 * tied to the account rather than to the request.
 */
export interface LimitSignal {
    /** Short machine-readable reason, such as the provider's error code. */
    readonly reason: string;
    readonly status?: number;
    /** How long the provider asked the account to wait, when it said. */
    readonly retryAfterMs?: number;
}
/** What the adapter learned from one streamed event or WebSocket frame. */
export interface EventVerdict<Q> {
    /** The user has seen output from this response: a retry would repeat it. */
    readonly outputStarted?: boolean;
    readonly quota?: Q;
    readonly limit?: LimitSignal;
    /**
     * This is the last event of the response (completed or failed); the
     * attempt ends here. On WebSocket this is the only way an attempt ends
     * normally, because the socket stays open between responses.
     */
    readonly done?: boolean;
    /**
     * The response failed with this message. Ends the attempt with
     * `error.reason` `failed`; implies `done`.
     */
    readonly error?: string;
}
/**
 * Header changes for one account. A string sets the header (replacing every
 * spelling of its name); `null` removes it.
 */
export type HeaderEdits = Readonly<Record<string, string | null>>;
export interface ChooseAccountInput extends RequestScope {
    /**
     * The account of the attempt this one retries, when the retry hook just
     * asked the host to retry an attempt of this session and kind; otherwise
     * the account of the newest attempt of this session and kind.
     */
    readonly previousAccountId?: string;
    /**
     * Set when the attempt this one retries was refused for a limit before any
     * output and the retry hook asked the host to try again. The adapter
     * should not pick `accountId` again unless it has nothing else.
     */
    readonly rerouteFrom?: {
        readonly accountId: string;
        readonly limit: LimitSignal;
    };
}
export interface AccountRequest extends RequestScope {
    readonly accountId: string;
}
/**
 * One physical send: created when an account is chosen for a request, and
 * handed back on every hook call and event that belongs to that send, so a
 * plugin can tie a response, a frame, a limit, a retry decision and the end
 * of the send to the credential it chose for it.
 *
 * `A` is the plugin's own per-attempt value, returned by `accountHeaders`
 * next to the headers (a served credential receipt, say); the installer
 * only carries it.
 */
export interface Attempt<A = unknown> extends AccountRequest {
    /** Unique within one installation. */
    readonly attemptId: string;
    /**
     * The transport that carried the send. `undefined` until `http.request` or
     * `experimental.ws.handshake` has run for it: an account chosen in
     * `model.request` is chosen before the host has picked the transport.
     */
    readonly transport: Transport | undefined;
    /**
     * What `accountHeaders` returned as `attempt`, if anything, or what
     * `answeredBy` replaced it with.
     */
    readonly data: A | undefined;
    /**
     * Set when `answeredBy` said another account answered this attempt's HTTP
     * response: the account `chooseAccount` picked. `accountId` is then the
     * account that answered, and everything from the response on is attributed
     * to it.
     */
    readonly reboundFrom?: string;
}
/**
 * The account that actually answered an HTTP response, as `answeredBy`
 * reports it. `data`, when the key is present, replaces the attempt's `data`
 * (the answering account's own credential receipt, say).
 */
export interface ResponseAccount<A = unknown> {
    readonly accountId: string;
    readonly data?: A;
}
/**
 * Why an attempt ended without completing.
 *
 * - `failed`: the response stream errored, or the adapter's `inspectEvent`
 *   reported the response as failed;
 * - `cancelled`: the host cancelled the HTTP response body (the user stopped
 *   the turn, say);
 * - `abandoned`: the attempt can no longer be observed: it was on WebSocket
 *   (or the retry hook had already judged it) when a newer attempt of the
 *   same session and kind began, another attempt of its session and kind
 *   went out over WebSocket, its session was forgotten, it was dropped for
 *   space, or the installation was disposed. A WebSocket closed or cancelled
 *   mid-response ends this way, since the host has no hook for either.
 */
export type AttemptEndReason = 'failed' | 'cancelled' | 'abandoned';
/** How an attempt ended, as `onAttemptEnd` reports it. */
export interface AttemptOutcome {
    /** The HTTP status of the response, when an HTTP response was seen. */
    readonly status?: number;
    /** Output from this attempt had reached the user. */
    readonly outputStarted: boolean;
    /** The account-level refusal recorded for this attempt, if any. */
    readonly limit?: LimitSignal;
    /** Absent when the response completed, whatever its status. */
    readonly error?: {
        readonly reason: AttemptEndReason;
        readonly message?: string;
    };
}
/**
 * `accountHeaders` may return the header edits alone, or the edits together
 * with a per-attempt value that the installer hands back in
 * `Attempt.data`.
 */
export interface AccountHeadersResult<A = unknown> {
    readonly headers: HeaderEdits;
    readonly attempt?: A;
}
/** A host-supplied error, as the retry hook reports it. */
export interface HostError {
    readonly type: string;
    readonly message: string;
    readonly status?: number;
}
/**
 * Everything provider-specific the installer needs. `Q` is the plugin's own
 * quota reading type; the installer only carries it to the `quota` event.
 * `A` is the plugin's per-attempt value (see `Attempt`).
 */
export interface OpenCode2AuthAdapter<Q = unknown, A = unknown> {
    /** Every hook is scoped to this provider; other providers are untouched. */
    readonly providerID: string;
    /**
     * Picks the account for one model request. Called again for every retry,
     * so a refused account can be skipped. Returning `undefined` stops the
     * request with `OpenCode2AuthError` kind `no-account`.
     */
    chooseAccount(input: ChooseAccountInput): Promise<string | undefined> | string | undefined;
    /**
     * The credential and per-account headers for an account, applied in
     * `model.request`, `http.request` and `experimental.ws.handshake`. The last
     * two run after the host has applied its own credential, so these headers
     * win on the wire. With `gateOnPlaceholder`, only the transport hook applies
     * them, and only to owned requests. Put per-account and session headers here
     * rather than in a separate `model.request` hook.
     *
     * Called once per attempt, when the account is chosen. Returning
     * `{headers, attempt}` instead of the bare edits stores `attempt` as the
     * attempt's `data`, handed back on everything that belongs to the attempt.
     */
    accountHeaders(input: AccountRequest): Promise<HeaderEdits | AccountHeadersResult<A>> | HeaderEdits | AccountHeadersResult<A>;
    /**
     * Optional request rewrite (URL, body) before the account headers are
     * applied. Return `undefined` to keep the request. With `gateOnPlaceholder`,
     * runs only for owned requests; move endpoint and body edits here rather
     * than changing `model.request`.
     */
    rewriteRequest?(input: AccountRequest & {
        readonly request: Request;
        readonly attempt: Attempt<A>;
    }): Promise<Request | undefined> | Request | undefined;
    /**
     * Optional response rewrite (body stream, status). It receives the
     * response after quota, limit and output detection have been attached, so
     * detection always sees the provider's own events.
     */
    rewriteResponse?(input: AccountRequest & {
        readonly request: Request;
        readonly response: Response;
        readonly attempt: Attempt<A>;
    }): Promise<Response | undefined> | Response | undefined;
    /**
     * Optional. For an adapter whose own sender can move a request to another
     * account after `rewriteRequest` (a bridge that answers a 401 or 403 by
     * retrying on the next account, say): runs first in `http.response`,
     * before quota, refusal, output or end detection, and returns the account
     * that actually answered, or `undefined` when the attempt's own account
     * did. A different account rebinds the attempt to it (`Attempt.accountId`
     * becomes that account and `reboundFrom` the one chosen), so the response's
     * quota, refusal, stream events, end and any retry reroute are attributed
     * to the answering account, once, and never to the chosen one. What the
     * sender saw from the chosen account before it moved on (the 401 itself)
     * never reaches the installer: the adapter accounts for it itself.
     * Throwing ends the attempt as `failed` and fails the response hook.
     */
    answeredBy?(input: {
        readonly request: Request;
        readonly response: Response;
        readonly attempt: Attempt<A>;
    }): Promise<ResponseAccount<A> | undefined> | ResponseAccount<A> | undefined;
    /**
     * Optional WebSocket URL rewrite. With `gateOnPlaceholder`, runs only for
     * handshakes whose prepared credential belongs to this plugin's login.
     * Return `undefined` to keep the URL.
     */
    rewriteHandshakeURL?(input: AccountRequest & {
        readonly url: string;
        readonly attempt: Attempt<A>;
    }): string | undefined;
    /**
     * Optional rewrite of each outgoing WebSocket frame of this provider,
     * from `experimental.ws.send`. Return the frame to send, or `undefined` to
     * send it unchanged.
     *
     * The rewrite must be a deterministic function of the frame (stable for
     * the session): the host chains turns with `previous_response_id` by
     * diffing its own request as it was before this hook ran, so the server
     * only stays in step when every frame is rewritten the same way. Never
     * alter, drop or reorder the `input` items the host put in the frame, and
     * never touch `previous_response_id`: the host's next frame assumes the
     * server holds exactly what it sent. Adding items to `input`, or adding or
     * changing settings fields, keeps the host's order and continuation when
     * done the same way for every frame: the added items become part of the
     * server's history and the follow-up turn stays incremental.
     *
     * What inserting `input` items into every frame does not keep is the
     * equivalence of the two ways a history reaches the server (settings
     * fields carry no history, so they are not affected). Incrementally, each
     * frame carries only
     * the new items, so an item the rewrite inserts into every frame lands at
     * every network boundary of the accumulated history. After a reconnect the
     * host replays the whole history in one frame, and the same rewrite
     * inserts that item once. The two server-side histories, and their cache
     * prefixes, then differ. A rewrite that only adds or changes settings
     * fields is unaffected. An adapter that inserts `input` items must show,
     * for its own insertion, that the accumulated incremental history equals
     * the rewritten full replay (including across tool loops), or accept the
     * divergence and name what it costs (a cache miss and a different prompt
     * after every reconnect).
     *
     * It runs for every frame, including one no attempt can be tied to
     * (`attempt` is then `undefined`), so the rewrite never depends on
     * attribution. With `gateOnPlaceholder`, it runs only after an owned
     * handshake, including frames after that socket's attempt has ended.
     */
    rewriteWebSocketFrame?(input: RequestScope & {
        readonly attempt: Attempt<A> | undefined;
        readonly frame: string;
    }): Promise<string | undefined> | string | undefined;
    /** Quota carried in HTTP response headers. */
    quotaFromHeaders?(headers: Headers, status: number, attempt: Attempt<A>): Q | undefined;
    /**
     * Recognises an account-level refusal from an HTTP response before its
     * body is streamed. `body()` reads a copy, so the host still gets the body.
     */
    limitFromResponse?(input: {
        readonly status: number;
        readonly headers: Headers;
        readonly body: () => Promise<string>;
        readonly attempt: Attempt<A>;
    }): Promise<LimitSignal | undefined> | LimitSignal | undefined;
    /**
     * Inspects one server-sent event (`data` payload) or one WebSocket frame.
     * Detects output, quota, refusals and the end of the response inside the
     * stream.
     */
    inspectEvent?(input: {
        readonly transport: Transport;
        readonly data: string;
        readonly event?: string;
        readonly attempt: Attempt<A>;
    }): EventVerdict<Q> | undefined;
    /**
     * Recognises an account-level refusal from the error the host hands the
     * retry hook, for refusals no other hook saw. `attempt` is the attempt
     * the retry hook judged.
     */
    limitFromError?(error: HostError, attempt: Attempt<A>): LimitSignal | undefined;
    /**
     * Called once per attempt when it ends: an HTTP response body finished,
     * errored or was cancelled; an HTTP response with an error status or no
     * body arrived; an event's verdict said `done` or `error`; or the attempt
     * was abandoned (see `AttemptEndReason`). Errors are logged and never
     * reach the host. The retry hook waits for this call to settle before it
     * decides, so a plugin that records a refusal here has it in place when
     * `chooseAccount` runs again.
     */
    onAttemptEnd?(attempt: Attempt<A>, outcome: AttemptOutcome): Promise<void> | void;
}
export interface OpenCode2AuthLogger {
    warn(message: string, data?: unknown): void;
}
export interface InstallOpenCode2AuthOptions {
    /**
     * Opt in to acting only on this plugin's login. Extract the request-bound
     * prepared secret from the host's transport headers (not global connection
     * state). The installer compares it byte for byte with
     * `placeholderSecret(adapter.providerID)`; any other value passes untouched.
     * `model.request` becomes a no-op; selection and rewrites happen at transport.
     */
    readonly gateOnPlaceholder?: {
        readonly credential: (headers: Headers) => string | undefined;
    };
    /**
     * Values that must never reach the wire, normally the placeholder the host
     * holds as its credential. Defaults to the placeholder secret for the
     * adapter's provider. With `gateOnPlaceholder`, that placeholder is always
     * forbidden, even if this list is customized.
     */
    readonly hostCredentials?: readonly string[];
    /** Most attempts kept before the oldest is abandoned and dropped. */
    readonly maxRecords?: number;
    readonly logger?: OpenCode2AuthLogger;
}
export type RetryReason = 'reroute' | 'output-started' | 'no-account' | 'host-decides';
/**
 * The hook that picked an account. Normally `model.request`; a transport hook
 * picks only when the host skipped `model.request` for that request, which a
 * plugin may want to log as a host change.
 */
export type SelectingHook = 'model.request' | 'http.request' | 'experimental.ws.handshake';
/**
 * Every event that belongs to one attempt carries it as `handle` (the
 * `retry` event already uses `attempt` for the host's retry count).
 */
export interface OpenCode2AuthEvents<Q, A = unknown> {
    /** An account was picked for a model request. */
    readonly select: AccountRequest & {
        readonly hook: SelectingHook;
        readonly previousAccountId?: string;
        readonly rerouteFrom?: ChooseAccountInput['rerouteFrom'];
        readonly handle: Attempt<A>;
    };
    /** A quota reading, attributed through this installer's own record. */
    readonly quota: AccountRequest & {
        readonly transport: Transport;
        readonly status?: number;
        readonly quota: Q;
        readonly handle: Attempt<A>;
    };
    /**
     * An account-level refusal. The retry hook waits for every listener of
     * this event before asking the host to retry, so a plugin that marks the
     * account limited here has the mark in place when `chooseAccount` runs.
     */
    readonly limit: AccountRequest & {
        readonly via: Transport | 'error';
        readonly limit: LimitSignal;
        readonly outputStarted: boolean;
        readonly handle: Attempt<A>;
    };
    /** The retry hook ran for this provider. */
    readonly retry: {
        readonly sessionID: string;
        readonly accountId?: string;
        readonly kind?: RequestKind;
        readonly attempt: number;
        readonly reason: RetryReason;
        readonly hostDecision: SessionRetryDecision;
        readonly decision: SessionRetryDecision;
        /** The attempt the decision was about, when it had an account. */
        readonly handle?: Attempt<A>;
    };
}
export type OpenCode2AuthEventName = keyof OpenCode2AuthEvents<unknown>;
export interface OpenCode2AuthInstallation<Q, A = unknown> {
    /**
     * Listens to an event. Listener errors are logged and never reach the
     * host. Returns a function that removes the listener.
     */
    on<E extends OpenCode2AuthEventName>(event: E, listener: (payload: OpenCode2AuthEvents<Q, A>[E]) => void | Promise<void>): () => void;
    /**
     * The account of the newest attempt of a session and request kind (after
     * any `answeredBy` rebind). With several attempts of one session and kind
     * in flight it names only the newest; each attempt's own account is on its
     * handle.
     */
    accountFor(sessionID: string, kind: RequestKind): string | undefined;
    /**
     * Drops every attempt and revokes in-flight auth selections of a session.
     * Session deletion does this itself. Later requests may reuse the session id.
     */
    forgetSession(sessionID: string): void;
    /** Number of attempts held. */
    readonly size: number;
    /** Removes every hook, revokes in-flight auth and stops listening for session deletion. */
    dispose(): Promise<void>;
}
