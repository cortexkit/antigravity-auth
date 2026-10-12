/**
 * Why an OpenCode 2 auth hook refused a request.
 *
 * - `no-account`: the adapter had no account to offer for this request, so
 *   the request is stopped before the host picks a transport. Also used when
 *   session forgetting or installation disposal revokes an in-flight auth
 *   selection: that selection no longer has an account it may send under.
 * - `host-credential-on-wire`: after every rewrite, a header still carried
 *   one of the host's placeholder credentials. Sending it would leak a
 *   non-routable value to the provider and fail with a confusing error.
 */
export type OpenCode2AuthFailureKind = 'no-account' | 'host-credential-on-wire';
export declare class OpenCode2AuthError extends Error {
    readonly kind: OpenCode2AuthFailureKind;
    readonly providerID: string;
    readonly sessionID: string;
    readonly requestKind: string;
    constructor(details: {
        kind: OpenCode2AuthFailureKind;
        providerID: string;
        sessionID: string;
        requestKind: string;
        message?: string;
    });
}
