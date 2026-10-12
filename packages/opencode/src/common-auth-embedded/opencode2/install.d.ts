import type { HeaderEdits, InstallOpenCode2AuthOptions, OpenCode2AuthAdapter, OpenCode2AuthInstallation, OpenCode2HookContext } from './types.js';
export declare const DEFAULT_MAX_RECORDS = 512;
/**
 * The request header `model.request` sets to the attempt it started. The
 * host builds the HTTP request and the WebSocket handshake from the headers
 * `model.request` leaves, so `http.request` and `experimental.ws.handshake`
 * read it to find their own attempt among several of one session and kind,
 * and remove it: it never reaches the wire.
 */
export declare const ATTEMPT_HEADER = "x-common-auth-attempt";
/** Applies edits to a plain header record, replacing every spelling of each name. */
export declare function applyHeaderEdits(target: Record<string, string>, edits: HeaderEdits): void;
/**
 * Installs multi-account auth on OpenCode 2's own provider drivers. Every
 * hook is scoped to `adapter.providerID`:
 *
 * - `model.request` picks the account for one model call of a session and
 *   request kind, which starts a new attempt, sets its headers and marks the
 *   request with the attempt (`ATTEMPT_HEADER`);
 * - `http.request` and `experimental.ws.handshake` find the attempt by that
 *   mark, remove it and set the account headers again, because the host
 *   applies its own credential after `model.request`;
 * - `experimental.ws.send` (only when the adapter rewrites frames) rewrites
 *   each outgoing frame;
 * - `http.response` and `experimental.ws.receive` read quota, refusals,
 *   whether output has started and when the response ended, attributed to
 *   an attempt by the rules below;
 * - `retry` asks the host to retry at once when an account was refused
 *   before any output, so `model.request` runs again and can pick another
 *   account, and refuses to retry once output has started.
 *
 * Attribution. A send belongs to the attempt named by the mark
 * `model.request` left on it, so several attempts of one session and kind
 * can be in flight at once, each on its own account. An HTTP response
 * belongs to the attempt whose `http.request` produced its request object,
 * and to nothing else. The host hands `http.response` the request object the
 * `http.request` hooks left, so a different object means a later hook
 * replaced it; nothing then proves which send the response answers, and its
 * feedback is dropped rather than guessed by recency. A WebSocket frame
 * names no attempt, so frames go to the newest open attempt of their session
 * and kind that went out over WebSocket, and an older one is abandoned as
 * soon as a newer attempt of that session and kind begins or goes out over
 * WebSocket: the host runs one exchange at a time on a session's socket.
 * Anything else is attributed to no attempt and reaches no adapter callback
 * or listener.
 *
 * With `gateOnPlaceholder`, `model.request` is a no-op. Each transport hook
 * compares the host-prepared secret exactly, then selects a fresh attempt only
 * for an owned send. Request-object attribution therefore needs no attempt
 * header. Frames are owned by the latest handshake of their session and kind;
 * retry runs only when the session's latest transport was owned. The host's
 * retry hook has no request identity, so concurrent mixed-ownership calls
 * cannot be distinguished there; owned retries retain the heuristic above.
 */
export declare function installOpenCode2Auth<Q, A = unknown>(ctx: OpenCode2HookContext, adapter: OpenCode2AuthAdapter<Q, A>, options?: InstallOpenCode2AuthOptions): Promise<OpenCode2AuthInstallation<Q, A>>;
