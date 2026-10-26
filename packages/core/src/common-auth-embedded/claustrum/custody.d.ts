import { type ClaustrumClient, type ClaustrumReporterSource, type EnrollmentTokenFile } from '@cortexkit/claustrum-client';
import { type ClaustrumLogger } from './errors.js';
import type { InsulaUsageTransport } from './insula.js';
import { type ScopedWatchSource, type WatchMode } from './watch.js';
/**
 * `watchScoped` is present from claustrum-client 0.12.0. Hosts detect it at
 * run time and keep polling without it.
 */
export type ClaustrumScopedClient = Pick<ClaustrumClient, 'listScoped' | 'getScoped' | 'reportAuthFailureScoped' | 'close'> & {
    insula?: InsulaUsageTransport;
} & ScopedWatchSource;
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
/** Non-secret classification facts, including rows decoded by older clients. */
export interface VaultRowFacts {
    readonly credentialId: string;
    readonly credentialType: string;
    readonly authMethod?: string;
    readonly refreshAdapter?: string;
    readonly providerIds?: readonly string[];
    readonly categories: readonly string[];
}
/** A policy that partitions one category without requiring one OAuth adapter. */
export interface ClassifyingClaustrumFamily<Code extends string> {
    category: string;
    refusalCodes: readonly Code[];
    classify(row: VaultRowFacts): {
        kind: 'not-mine';
    } | {
        kind: 'mine';
        member: string;
    } | {
        kind: 'refused';
        code: Code;
    };
}
export type ClaustrumFamilyInput = ClaustrumFamily | ClassifyingClaustrumFamily<string>;
/** One vault credential this consumer may serve. Never carries bearer material. */
export interface VaultCredential {
    readonly credentialId: string;
    readonly credentialType: VaultCredentialType;
    readonly member?: string;
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
    readonly member?: string;
    readonly reason: SkippedVaultReason;
}
/**
 * One grant this consumer's enrollment holds, as the vault's list reply names
 * it: for example `{ selectorKind: 'category', selector: 'openai-native',
 * operation: 'read' }`. `selectorKind` is `exact` (the selector is a credential
 * id) or `category` (a bare category name); both open strings.
 */
export interface VaultGrantTuple {
    readonly selectorKind: string;
    readonly selector: string;
    readonly operation: string;
}
/**
 * What this consumer is granted, independent of what those grants currently
 * reach. It is what tells two empty listings apart: no rows with `grants === 0`
 * means no grant at all (the fix is `ck auth grant`), while no rows with
 * `grants > 0` means a grant that reaches no credential, usually logins that
 * lack the category (`ck auth reclassify --from-registry`); `tuples` names the
 * selector that matched nothing. Never written to the roster file.
 */
export interface VaultGrantReach {
    /** How many grants the consumer holds, deposit grants excluded. */
    readonly grants: number;
    readonly tuples: readonly VaultGrantTuple[];
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
    /** Classifying families only: fixed refusal codes, never classifier errors. */
    readonly refused?: readonly {
        credentialId?: string;
        code: string;
    }[];
    /** Classifying families only: rows outside this family's responsibility. */
    readonly notMine?: number;
    /**
     * The consumer's grants, as the vault's list reply named them. Undefined means unknown
     * (the vault or client predates the fields), never zero grants.
     */
    readonly grantReach?: VaultGrantReach;
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
    /**
     * True when this receipt was not freshly served but is the last token kept
     * from an earlier read, used because the vault could not be reached. A 401
     * with such a receipt must not be retried and is not reported to the vault,
     * which is unreachable.
     */
    readonly fromKeptReceipt?: true;
}
export interface KeptReceiptState {
    readonly active: boolean;
    readonly since: number | null;
}
export interface ClaustrumRosterWatchOptions {
    /**
     * Run the host's own discovery (`custody.discover()`, then its roster
     * commit). Called with the newest notice's view when that view differs from
     * the last discovered one, when a notice shows a sequence gap or a new
     * epoch, and on the first notice of a watch re-opened after a close (the
     * time between two watches was not observed). One call runs at a time;
     * notices that arrive meanwhile earn at most one more call, which runs only
     * if the view still differs. A rejection goes to `onError`.
     */
    onView: (view: string) => unknown;
    /**
     * The view of the roster the host last committed. Defaults to the view of
     * the last successful `custody.discover()` (outage probes excluded). Pass it
     * when the host can commit a roster it did not list itself (a peer process
     * held the discovery lease) or can fail after listing.
     */
    view?: () => string | undefined;
    /**
     * Called whenever the mode changes. The watch starts in `polling`. Keep the
     * host's own list timer at its usual pace unless the mode is `watching`.
     */
    onMode?: (mode: WatchMode) => void;
    /**
     * The vault refused the watch, and its confirming `list_scoped` read it with
     * this error (a revoked enrollment answers `not_found`). Custody has already
     * applied it as it applies a refused discovery (`listFailed`: every kept
     * receipt is dropped); handle it as the host handles that refusal.
     */
    onRefused?: (error: unknown) => void;
    /** A failed `onView`, or a watch that could not be opened. */
    onError?: (error: unknown) => void;
}
/** A vault watch held by a custody; see `ClaustrumScopedCustody.watchRoster`. */
export interface ClaustrumRosterWatch {
    /** How the host currently learns about changes. */
    readonly mode: WatchMode;
    /** Stop the watch and its timers. Safe to call more than once. */
    close(): void;
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
/** A kept receipt needs a minute of headroom, not the vault's refresh demand. */
export declare const KEPT_RECEIPT_MARGIN_MS = 60000;
/**
 * Reads this consumer's vault credentials (list, fetch, 401 report), with the
 * enrollment token as authorization. Used by every host of a plugin. Every
 * physical send asks the vault first while reachable. Only an unreachable vault permits
 * reuse of the last validated receipt, in memory and bounded by its expiry.
 * The enrollment token is re-read per operation so revocation and disconnect
 * still take effect without a process restart.
 */
export declare class ClaustrumScopedCustody {
    #private;
    constructor(options: {
        client: ClaustrumScopedClient;
        family: ClaustrumFamilyInput;
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
        setTimeoutImpl?: typeof setTimeout;
        clearTimeoutImpl?: typeof clearTimeout;
    });
    /** A watch losing its transport is the same outage as an unreachable read. */
    transportLost(error?: unknown): void;
    /** Any vault answer ends transport fallback, even when it refuses access. */
    reachable(): void;
    /**
     * List this consumer's credentials. A record that cannot be used is skipped
     * and warned about rather than failing the whole list, so one bad record
     * never hides every other account. Records outside the family are not
     * skipped records: they simply are not this consumer's.
     */
    discover(signal?: AbortSignal): Promise<VaultInventory>;
    /**
     * Apply a failed account listing: any answer from the vault (a refusal such
     * as a revoked enrollment's `not_found`) drops every kept receipt, while an
     * unreachable vault keeps them. A vault watch that ends with the same
     * refusal calls this too, so both paths treat it alike.
     */
    listFailed(error: unknown): void;
    /** Discard bearer material when a route is removed, declined or rebound. */
    forget(credentialId: string): void;
    /** Apply an already-held roster; this never fetches credentials or writes it. */
    retain(identities: readonly (ClaustrumScopedIdentity & {
        enabled: boolean;
        state: string;
    })[]): void;
    /** A frozen, non-secret summary for a plugin's status display. */
    keptReceiptState(): KeptReceiptState;
    /** Ask the vault while reachable; retain one validated receipt in memory only. */
    authorize(identity: ClaustrumScopedIdentity, signal?: AbortSignal, routeId?: string): Promise<ClaustrumScopedAttempt>;
    /**
     * Report that a send this consumer actually made was rejected. Only a 401
     * is reported (the vault refuses 429, 402 and 5xx reports), addressed by
     * credential id with the exact record version that send was served, and
     * signed with the enrollment token that authorized it. A receipt this
     * custody did not issue is refused rather than reported.
     */
    reportFailure(attempt: ClaustrumScopedAttempt, status: number, reporterSource: ClaustrumReporterSource): Promise<void>;
    /**
     * Watch this consumer's visible vault accounts instead of listing them on a
     * short timer. Opens one `watchScoped` on this custody's client and calls
     * `onView` when the host must run its discovery (see
     * `ClaustrumRosterWatchOptions`). A claustrum-client without `watchScoped`
     * (before 0.12.0) or a vault that answers `unknown_method` reports
     * `fallback` and opens nothing. A watch that closes before any notice was
     * never accepted: the client reads once to learn why, and the watch reports
     * `fallback` and tries one new watch after `WATCH_RETRY_MS`, never in a
     * loop. A watch that closes after notices is re-opened after
     * `RESUBSCRIBE_BACKOFF_MS`, doubling per close in a row. A lost transport
     * starts this custody's outage, exactly as an unreachable call does, and
     * the first notice of a watch ends it. Timers are unreferenced; `close()`
     * on the returned watch or on this custody stops it.
     *
     * The watch keeps no history, so the host still lists on a slow timer while
     * the mode is `watching`: every `SAFETY_POLL_MS` (five minutes). In any
     * other mode the host keeps its usual list timer.
     */
    watchRoster(options: ClaustrumRosterWatchOptions): ClaustrumRosterWatch;
    close(): void;
    /** Stop immediately; allow token reads 2 s and share an owner's timeout warning. */
    dispose(onTimeout?: (pendingOperations: number) => void): Promise<void>;
}
