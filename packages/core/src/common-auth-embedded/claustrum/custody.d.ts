import { type ClaustrumClient, type ClaustrumReporterSource, type EnrollmentTokenFile } from '@cortexkit/claustrum-client';
import { type ClaustrumLogger } from './errors.js';
export type ClaustrumScopedClient = Pick<ClaustrumClient, 'listScoped' | 'getScoped' | 'reportAuthFailureScoped' | 'close'>;
/** The two credential types a plugin's family can hold; routing differs by type. */
export type VaultCredentialType = 'oauth' | 'api_key';
/**
 * Which vault rows belong to this plugin. `refreshAdapter` classifies an OAuth
 * row by the protocol it speaks; `category` is the grant that authorizes this
 * consumer to read it. Static API keys carry no refresh adapter, so they are
 * admitted only when `apiKeys` is set and only by category.
 */
export interface ClaustrumFamily {
    refreshAdapter: string;
    category: string;
    apiKeys?: boolean;
}
/** One vault credential this consumer may serve. Never carries bearer material. */
export interface VaultCredential {
    readonly credentialId: string;
    readonly credentialType: VaultCredentialType;
    /**
     * The provider account the credential logs into, when the vault's adapter
     * claims one. Absent means the adapter makes no claim, not a mismatch.
     */
    readonly accountIdentity?: string;
    readonly state: string;
    readonly email?: string;
    readonly orgName?: string;
}
/**
 * Why a listed vault record could not be used. A closed set of fixed codes, so
 * a log line or a roster file that carries one never echoes vault data.
 */
export type SkippedVaultReason = 'empty credential id' | 'duplicate credential id' | 'blank account identity' | 'empty state';
/**
 * A vault record this consumer could not use. `credentialId` is absent when
 * the record's id itself was unusable, so nothing can say which account the
 * record was.
 */
export interface SkippedVaultRecord {
    readonly credentialId?: string;
    readonly reason: SkippedVaultReason;
}
export interface VaultInventory {
    /**
     * The vault's change cursor: a digest over exactly what this consumer can see
     * (ids, grants, state, identity), never over record versions, so a routine
     * token refresh does not move it. Only equality is meaningful.
     */
    readonly view: string;
    readonly credentials: readonly VaultCredential[];
    readonly skipped: readonly SkippedVaultRecord[];
}
export interface ClaustrumScopedIdentity {
    readonly credentialId: string;
    readonly credentialType: VaultCredentialType;
    readonly accountIdentity?: string;
}
/**
 * Where a receipt's `accountIdentity` came from: the vault asserted it in the
 * served reply, the plugin's `parseIdentity` read it from the served token, or
 * neither did and it is only the roster's expectation (`none`: no identity at
 * all).
 */
export type AccountIdentitySource = 'asserted' | 'parsed' | 'expected' | 'none';
/**
 * A receipt: what the vault served for one physical send. Each attempt gets
 * its own. It records the exact record version served, because a 401 for
 * this send is reported to the vault against that version.
 */
export interface ClaustrumScopedAttempt {
    readonly credentialId: string;
    readonly credentialType: VaultCredentialType;
    /**
     * The account this receipt is bound to: the vault's assertion, else the
     * plugin's parse of the token, else the roster's expectation. Check
     * `accountIdentitySource` before treating it as proof.
     */
    readonly accountIdentity?: string;
    readonly accountIdentitySource: AccountIdentitySource;
    /** The account the roster row named when this receipt was requested. */
    readonly expectedAccountIdentity?: string;
    /** The credential id the vault itself put in the served reply, if any. */
    readonly assertedCredentialId?: string;
    /**
     * The account the vault itself put in the served reply, if any. Never filled
     * in from the roster or from a token parse.
     */
    readonly assertedAccountIdentity?: string;
    /**
     * The non-secret Google Cloud project id the vault served in get_scoped for
     * this attempt, if any. Never filled in from list_scoped, the roster or a
     * token parse. A project change in the vault takes effect on the next send.
     */
    readonly projectId?: string;
    /**
     * Kept in memory only and hidden from JSON.stringify and object spreads, so
     * logging a receipt never leaks it. Authorize again for every dispatch and retry.
     */
    readonly accessToken: string;
    readonly recordVersion: number;
    readonly expiresAtMs: number | null;
}
/** Reads the provider identity a served token executes under, when the plugin can tell. */
export type IdentityParser = (accessToken: string) => string | undefined;
/** Only a new version of the same account may replace an in-flight 401. */
export declare function isScopedCredentialRotation(served: ClaustrumScopedAttempt, current: ClaustrumScopedAttempt | undefined): current is ClaustrumScopedAttempt;
/** Why a scoped 401 did or did not retry. Never carries credential material. */
export type ScopedRetryReason = 'rotated' | 'reauthorize-failed' | 'credential-changed' | 'account-changed' | 'version-unchanged';
/**
 * Decide whether a request that got a 401 should retry with the freshly
 * re-authorized receipt, and log the decision. The vault can refresh a
 * credential between the send and the 401; the log line lets that refresh be
 * matched against the consumer's retry. `site` names the kind of request.
 */
export declare function decideScopedRetryAfter401(site: string, served: ClaustrumScopedAttempt, current: ClaustrumScopedAttempt | undefined, logger?: ClaustrumLogger): current is ClaustrumScopedAttempt;
/**
 * How long a served OAuth token must stay valid after the vault hands it out,
 * so it cannot expire while a long request is still using it.
 */
export declare const SERVING_MARGIN_MS = 300000;
/**
 * Reads this consumer's vault credentials (list, fetch, 401 report), with the
 * enrollment token as authorization. Used by every host of a plugin. There is
 * deliberately no credential cache and no single-flight of credential reads:
 * each physical send is authorized by the vault, so a revoked enrollment or a
 * changed record takes effect on the next send. The enrollment token is
 * re-read per operation so an operator's reissue on disk is picked up.
 */
export declare class ClaustrumScopedCustody {
    #private;
    constructor(options: {
        client: ClaustrumScopedClient;
        family: ClaustrumFamily;
        tokenPath?: string;
        readToken?: () => Promise<EnrollmentTokenFile>;
        parseIdentity?: IdentityParser;
        /**
         * Issue a receipt only when the vault's served reply itself names the
         * requested credential id and the roster's (known) account identity. For
         * providers whose tokens are opaque, where nothing else can prove which
         * account a token belongs to. Off by default: then an absent assertion is
         * no claim, and the receipt says where its identity came from.
         */
        requireAssertion?: boolean;
        now?: () => number;
        logger?: ClaustrumLogger;
    });
    /**
     * List this consumer's credentials. A record that cannot be used is skipped
     * and warned about rather than failing the whole list, so one bad record
     * never hides every other account. Records outside the family are not
     * skipped records: they simply are not this consumer's.
     */
    discover(signal?: AbortSignal): Promise<VaultInventory>;
    /**
     * Fetch the credential for one physical send and wrap it in a fresh receipt.
     * The vault's served identity (or, without one, the plugin's parse of the
     * token) must equal the roster's when both are present. Without
     * `requireAssertion`, absence on either side proves nothing and does not
     * refuse; the receipt records what the vault asserted separately from what
     * the roster expected. With it, a reply that does not itself name the
     * credential id and the expected account is refused.
     */
    authorize(identity: ClaustrumScopedIdentity, signal?: AbortSignal): Promise<ClaustrumScopedAttempt>;
    /**
     * Report that a send this consumer actually made was rejected. Only a 401
     * is reported (the vault refuses 429, 402 and 5xx reports), addressed by
     * credential id with the exact record version that send was served, and
     * signed with the enrollment token that authorized it. A receipt this
     * custody did not issue is refused rather than reported.
     */
    reportFailure(attempt: ClaustrumScopedAttempt, status: number, reporterSource: ClaustrumReporterSource): Promise<void>;
    close(): void;
}
