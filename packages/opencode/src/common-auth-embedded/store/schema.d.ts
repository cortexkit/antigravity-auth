/** Top-level key of the config file that holds everything the pool adds. */
export declare const POOL_KEY = "commonAuthPool";
/** The pool schema this library reads and writes. */
export declare const POOL_SCHEMA_VERSION = 1;
/** Property of `commonAuthPool` holding the per-row entries, keyed by local id. */
export declare const POOL_ROWS_KEY = "rows";
/**
 * Property of `commonAuthPool` (since 0.8.0) holding, per id, the highest
 * credential epoch a row with that id held when the store last dropped it
 * from the pool. A row added later under the same id starts past it (see
 * `nextAddEpochIn`), so an attribution taken for the dropped row never
 * matches the new one. Older readers ignore it, and older writers keep it
 * as they keep every pool key they do not know.
 */
export declare const POOL_RETIRED_EPOCHS_KEY = "retiredEpochs";
/** The `version` older readers of the same files expect at the top level. */
export declare const LEGACY_STORE_VERSION = 1;
/**
 * How far ahead of the clock a stored `lastRefreshedAt` may sit and still be
 * trusted. Older readers of the state file apply the same bound, and a stamp
 * strictly above it counts as absent when they compare two copies of a token.
 */
export declare const REFRESH_STAMP_TOLERANCE_MS: number;
export type OAuthCredential = {
    type: 'oauth';
    access?: string;
    refresh: string;
    expires?: number;
};
export type ApiKeyCredential = {
    type: 'api';
    apiKey: string;
    baseURL: string;
    authHeader?: 'authorization-bearer' | 'x-api-key';
};
export type PoolCredential = OAuthCredential | ApiKeyCredential;
/**
 * What `rotate` takes. Rotation refreshes the secret of the endpoint a row
 * already has, so an API key may leave out `baseURL` (and `authHeader`) to
 * keep the row's; one it gives must equal the row's.
 */
export type RotateCredential = OAuthCredential | (Omit<ApiKeyCredential, 'baseURL'> & {
    baseURL?: string;
});
/** A credential as stored: an OAuth credential also carries its refresh stamp. */
export type StoredCredential = (OAuthCredential & {
    lastRefreshedAt?: number;
}) | ApiKeyCredential;
/** Quota codec supplied by `/quota`: the store never interprets the map itself. */
export interface QuotaCodec {
    validate(value: unknown): boolean;
    merge(stored: unknown | undefined, observation: unknown): unknown;
}
/**
 * What `ProviderStateCodec.onReplace` is told about a replacement: the row id,
 * the credential epoch the new credential starts, `previousIdentity` (the
 * identity the locked row recorded before the replace), `identity` (the
 * identity the replace records), and the provider state the caller handed to
 * `replace`, if any. Each identity is absent when none was recorded.
 */
export interface ProviderStateReplacement {
    id: string;
    credentialEpoch: number;
    previousIdentity?: string;
    identity?: string;
    incoming?: unknown;
}
/**
 * Codec for the provider state a plugin keeps beside each row's credential
 * (a project id, a device fingerprint, eligibility times: whatever belongs to
 * that credential). The store never interprets the value: it stores it as
 * JSON, asks `validate` before every write and on every load, and calls the
 * hooks below where two values meet. Every hook is synchronous and runs
 * under the store locks.
 */
export interface ProviderStateCodec {
    validate(value: unknown): boolean;
    /**
     * The part of a (valid) value that belongs to the credential: what is true
     * of the account the credential signs in to, such as a project id or a
     * device fingerprint, as opposed to what the plugin merely tracks about
     * its use, such as a cooldown or a cursor. The credential stamp covers the
     * digest of exactly this projection, so a foreign edit of it hides the
     * value, while the rest may change through `updateProviderState` without
     * the stamp being rewritten. It must be a pure function of the value that
     * returns JSON with a deterministic key order. Without it the whole value
     * is credential-bound.
     */
    credentialBound?(value: unknown): unknown;
    /**
     * Combines the value on disk with one a write brings (`add` of a secret the
     * pool already holds, `rotate`, or a refresh whose provider returned a
     * state). Called only when the row has a value on disk; without it the
     * incoming value replaces the stored one. Its result is validated.
     */
    merge?(onDisk: unknown, incoming: unknown): unknown;
    /**
     * The provider state of a row once `replace` gives it a new credential
     * epoch. `previous` is the old credential's value (undefined when the row
     * shows none). Returning undefined clears it. Without this hook a replace
     * keeps the value handed to `replace` and otherwise clears the state.
     */
    onReplace?(previous: unknown | undefined, replacement: ProviderStateReplacement): unknown | undefined;
}
/**
 * Why a row shows no provider state although the state file holds one for it.
 *
 * `uncovered`: the value's credential-bound part (see
 * `ProviderStateCodec.credentialBound`) is not the one this store last
 * wrote beside the row's credential at its credential epoch and recorded
 * identity. Another writer edited it, or
 * wrote the credential beside it without knowing about it (an older version
 * of this library, which drops the coverage, or a writer that does not know
 * the pool at all), or it belongs to an earlier credential of the row.
 * `invalid`: the value is covered but the codec rejects it, or the store was
 * opened without a provider-state codec.
 */
export type ProviderStateDrop = 'uncovered' | 'invalid';
/**
 * What the stamp beside a row's credential proves (see `CredentialStamp`).
 *
 * `none`: the row holds no credential, so there is nothing to stamp.
 * `bound`: the stamp was written with this credential (its digest matches),
 * names the row's credential epoch (1 for a row without a per-row entry),
 * the identity it records (or its recording none) and any endpoint it
 * records are the row's, and its dispatch digest matches everything a
 * request would send (the OAuth access and refresh tokens and expiry; the API
 * key with its `baseURL` and `authHeader`).
 * `missing`: the credential carries no stamp (written by a writer that does
 * not know about stamps, or one that dropped it).
 * `malformed`: the stamp is not one this store writes (wrong shape, or an
 * epoch outside the positive safe integers).
 * `mismatched`: the stamp was written for another credential, epoch,
 * identity, endpoint, or token to send than the row now holds.
 * `legacy`: a well-formed stamp written with this credential's secret but
 * with no dispatch digest (written by 0.4.3 or earlier), so it proves
 * neither the token sent nor the account or endpoint it goes to.
 */
export type CredentialStampStatus = 'none' | 'bound' | 'missing' | 'malformed' | 'mismatched' | 'legacy';
/** One row of the pool as loaded. */
export interface PoolRow {
    id: string;
    type: 'oauth' | 'api';
    label?: string;
    enabled: boolean;
    addedAt?: number;
    /** Recorded wire identity (the roster row's `accountId`), when known. */
    identity?: string;
    /** Undefined when the state file holds no usable credential for the row. */
    credential?: StoredCredential;
    /** Stable hash of the credential's secret material; never persisted. */
    fingerprint?: string;
    /** Undefined when the row has no per-row entry yet. */
    credentialEpoch?: number;
    needsFirstReading: boolean;
    disabledReason?: string;
    /** Store-owned reservation; only `publishRoster` releases it for ordinary use. */
    staged?: {
        reservation: string;
    };
    /** The opaque quota map, as validated by the codec. */
    quota?: unknown;
    /**
     * The opaque provider state kept beside the credential, as validated by
     * the provider-state codec. Absent when the row has none, or when the one
     * on disk is not shown (see `providerStateDropped`).
     */
    providerState?: unknown;
    /**
     * Set when the state file holds a provider state for the row that is not
     * shown, and why. The value stays on disk untouched until a write on the
     * row sets or clears it; the row itself stays usable.
     */
    providerStateDropped?: ProviderStateDrop;
    hasEntry: boolean;
    /** A row that may be refreshed, pulled for, or admitted. */
    candidate: boolean;
    /** Set when the roster row or the per-row entry failed validation. */
    invalid?: 'roster' | 'entry';
    /**
     * Set when a replace stopped between its two writes: the state file holds
     * the new credential, stamped with the epoch and the identity or endpoint
     * it belongs to, and the config still holds the replaced row. Also set when
     * a write that gives a row its first identity (`recordIdentity`, or a
     * `rotate` or refresh that learns one) stopped after stamping the identity
     * and before recording it in the config, and when an attributed `disable`
     * or `enable` that changed the provider state stopped after its state
     * write and before flipping the row in the config. The row is shown as the
     * write leaves it once completed, is never a candidate, and the next store
     * write on it writes the config to match.
     */
    torn?: true;
    /**
     * Whether the credential is the one the store last stamped for this row
     * (see `CredentialStampStatus`). Every row the store loads carries it; a
     * torn row reports the stamp of the row as it is shown completed. It is
     * optional only so that rows built by hand (test fixtures) still type.
     */
    stamp?: CredentialStampStatus;
    /**
     * Set only when the store was opened with `requireCredentialStamps` and
     * the row's `stamp` is not `bound`: the row is never a candidate, and
     * `refresh`, quota pulls, `recordQuota`, `recordIdentity`, `rotate` and a
     * re-`add` onto it refuse with `unbound-credential`. Only `replace` (or a
     * new row) makes it usable again.
     */
    unbound?: true;
}
/**
 * Key, inside a state-file account entry, of the stamp naming what the
 * credential beside it belongs to. Older readers ignore it.
 */
export declare const CREDENTIAL_STAMP_KEY = "commonAuthPool";
/**
 * What the config holds for a credential when its stamp is written: the
 * identity it belongs to (absent: none is known yet) and, for an API key, its
 * endpoint. For a replace it is the config the replace is about to write.
 */
export interface CredentialBinding {
    identity?: string;
    baseURL?: string;
    authHeader?: 'authorization-bearer' | 'x-api-key';
}
/**
 * Written beside every credential the store puts in the state file. It names
 * the credential epoch the credential belongs to and a digest of its secret,
 * so a stamp left beside a credential another writer put there afterwards is
 * recognisable and ignored.
 *
 * `digest` covers only the refresh token or API key: it names the credential
 * lineage, and torn-replace detection matches it, including against stamps
 * older versions wrote, so it keeps that exact definition. `dispatch` covers
 * everything a request sends (see `dispatchDigest`), so a token or endpoint
 * changed beside an unchanged lineage secret is caught; stamps written by
 * 0.4.3 or earlier lack it.
 *
 * `binding` is the config the credential was written beside (see
 * `CredentialBinding`); every write since 0.4.4 records it, earlier versions
 * only on replace. `replace` marks a stamp written by a replace, which is
 * what lets a reader complete a replace that stopped after writing the
 * credential: a stamp from any other write is never completed as torn.
 *
 * `providerState` is the digest of the credential-bound part of the provider
 * state beside the credential (see `providerStateDigest`); it is absent when
 * the row has none, so the stamp of a row without provider state is exactly
 * what 0.5.0 wrote. It is apart from `digest` and `dispatch`, which keep
 * their meaning: the credential's stamp status never depends on it.
 */
export interface CredentialStamp {
    credentialEpoch: number;
    digest: string;
    dispatch?: string;
    binding?: CredentialBinding;
    replace?: true;
    providerState?: string;
    staged?: StagedStamp;
}
/** Original staged-add metadata, persisted with the credential before config exists. */
export interface StagedStamp {
    reservation: string;
    label?: string;
    disabledReason: string;
    providerState?: string;
}
/** Canonical JSON: recursively sorted object keys, preserved array order. */
export declare function canonicalJson(value: unknown): string;
export declare function canonicalDigest(value: unknown): string;
export declare function parseReservation(raw: unknown): {
    reservation: string;
} | undefined;
/**
 * Key, inside a state-file account entry, of the provider state kept beside
 * the credential. Older readers ignore it.
 */
export declare const PROVIDER_STATE_KEY = "commonAuthProviderState";
export type ConfigClassification = {
    status: 'ready';
    exists: boolean;
    config: Record<string, unknown>;
} | {
    status: 'pending-migration';
    config: Record<string, unknown>;
} | {
    status: 'error';
    reason: string;
};
export type StateClassification = {
    status: 'ready';
    exists: boolean;
    state: Record<string, unknown>;
} | {
    status: 'error';
    reason: string;
};
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Ids are stored exactly as given. Older readers trim ids, so an id with
 * surrounding whitespace would be renamed by them; such ids, empty ids and
 * prototype keys are refused instead of being rewritten.
 */
export declare function idProblem(id: unknown): string | undefined;
/** Same URL rule the older readers apply to an API-key row's `baseURL`. */
export declare function isValidBaseURL(value: unknown): boolean;
export declare function fingerprintOf(credential: PoolCredential | StoredCredential): string;
/**
 * The digest a credential stamp carries. It is kept apart from the
 * fingerprint (a different input prefix) so the persisted value is never the
 * dedupe key.
 */
export declare function credentialDigest(credential: PoolCredential | StoredCredential): string;
/**
 * The digest of everything a request made with the credential sends or is
 * served by: the OAuth access token, refresh token and expiry (the expiry
 * decides whether the access token is used or refreshed first), or the API
 * key with the `baseURL` and header it is sent to. Its input prefix differs
 * from both the fingerprint's and `credentialDigest`'s, so it never equals
 * either. The parts are JSON-encoded as a list, so no two credentials share
 * an input. An access token or expiry the state file cannot hold as loaded
 * (not a string, not a finite number) counts as absent, which is how
 * `buildRawRows` loads it back.
 */
export declare function dispatchDigest(credential: PoolCredential | StoredCredential): string;
/**
 * The stamp for a credential written into a row at `credentialEpoch`, beside
 * the config `binding` describes. `replace` is set only by a replace.
 */
export declare function stampFor(credential: PoolCredential | StoredCredential, credentialEpoch: number, binding: CredentialBinding, options?: {
    replace?: boolean;
    providerState?: string;
}): CredentialStamp;
/**
 * The digest a stamp carries for a provider state: of its credential-bound
 * part (`ProviderStateCodec.credentialBound`, the whole value without it), as
 * it serializes. The store only ever stores values that survive a JSON round
 * trip unchanged, so the digest of a value read back from disk equals the one
 * computed when it was written. Its input prefix differs from every other
 * digest the store writes.
 */
export declare function providerStateDigest(codec: Pick<ProviderStateCodec, 'credentialBound'> | undefined, value: unknown): string;
/**
 * The provider-state digest of the stamp in a state-file account entry, when
 * that stamp binds it to this row: written with this credential (its lineage
 * digest matches), at this credential epoch, naming this recorded identity.
 * Whether the value beside it still has that digest is checked apart, by
 * `providerStateFields`; this alone is what a write that keeps the value
 * carries into the stamp it writes, so a value no stamp of this store bound
 * to the row stays unbound rather than being vouched for, and one edited
 * after it was bound stays detectably edited.
 */
export declare function boundProviderStateDigest(account: unknown, credential: PoolCredential | StoredCredential | undefined, credentialEpoch: number | undefined, identity: string | undefined): string | undefined;
/**
 * A credential epoch is a positive safe integer. Above `MAX_SAFE_INTEGER`,
 * adding one may give back the same number, so a replace would not move the
 * epoch and nothing could tell the old credential's work from the new one's.
 */
export declare function isCredentialEpoch(value: unknown): value is number;
/** A well-formed stamp, or undefined for anything else (which is ignored). */
export declare function parseStamp(raw: unknown): CredentialStamp | undefined;
/** A parsed file, or the reason it could not be parsed. */
export type FileRead = {
    exists: false;
} | {
    exists: true;
    value: unknown;
} | {
    exists: true;
    parseError: unknown;
};
export declare function classifyConfig(read: FileRead): ConfigClassification;
export declare function classifyState(read: FileRead): StateClassification;
export declare function rosterOf(config: Record<string, unknown>): unknown[];
export declare function entriesOf(config: Record<string, unknown>): Record<string, unknown>;
/** The first roster row with this id (the one the pool loads). */
export declare function rosterRowIn(config: Record<string, unknown>, id: string): Record<string, unknown> | undefined;
/** The per-row entries of a config, created (empty) when absent. */
export declare function ensureEntries(config: Record<string, unknown>): Record<string, unknown>;
export declare function entryIn(config: Record<string, unknown>, id: string): Record<string, unknown> | undefined;
/** Sets an entry as an own property, so an id such as `toString` is safe. */
export declare function setEntryIn(config: Record<string, unknown>, id: string, entry: Record<string, unknown>): void;
/**
 * The credential epoch recorded for a dropped id (see
 * `POOL_RETIRED_EPOCHS_KEY`), or undefined when none is. A value that is not
 * a credential epoch counts as none.
 */
export declare function retiredEpochIn(config: Record<string, unknown>, id: string): number | undefined;
/**
 * The credential epoch `add` gives a new row with this id: one past the
 * highest epoch the id is known to have held, which is the epoch recorded
 * when the store dropped it, or the epoch of an entry left behind by a writer
 * that removed only its roster row; 1 for an id the pool never held.
 *
 * An attribution names a row by id and credential epoch (and identity), and
 * an id is chosen by the plugin, so it is often the same one again (`main`).
 * Were a re-added row to start at epoch 1 again, an attribution taken for the
 * removed row's credential would match the new credential exactly, in this
 * process or any other. Starting past every earlier epoch makes such an
 * attribution fail as it does after a `replace`. The result may lie past the
 * safe integers (an id whose last row was at `Number.MAX_SAFE_INTEGER`);
 * `add` refuses such an id.
 */
export declare function nextAddEpochIn(config: Record<string, unknown>, id: string): number;
/**
 * Records, in a config being written, the epochs of the ids it drops: for
 * each, the epoch its entry claims (1 for a row without one, the epoch such a
 * row is at), kept only when above what is already recorded, so the record
 * for an id never goes down. Valid recorded values of other ids are kept; a
 * record that is not an object, or a value in it that is not an epoch, says
 * nothing and is replaced. An entry whose epoch cannot be read records 1.
 */
export declare function retireEpochsIn(config: Record<string, unknown>, dropped: Iterable<string>): void;
/**
 * Builds the rows of a ready pool from the files exactly as they are, without
 * looking at credential stamps (see `loadRows` for the rows every reader
 * gets). A roster row the older readers would reject, a duplicate id, or a
 * malformed per-row entry makes that one row invalid (never a candidate) and
 * blocks nothing else.
 */
export declare function buildRawRows(config: Record<string, unknown>, state: Record<string, unknown>, codec: QuotaCodec, providerCodec?: ProviderStateCodec): PoolRow[];
/** The row-lock key: recorded wire identity when known, else the local id. */
export declare function rowLockKey(row: Pick<PoolRow, 'id' | 'identity'>): string;
/**
 * The refresh stamp a write persists: the clock, raised to one past a prior
 * stamp that is still trusted, so a stale copy of the previous token can never
 * compare newer than the rotation. A prior stamp beyond the trust bound says
 * nothing and is ignored.
 */
export declare function rotationStamp(prior: number | undefined, now: number): number;
/** True when a rotation stamped now would itself be past the trust bound. */
export declare function rotationStampUntrusted(prior: number | undefined, now: number): boolean;
/** The legacy-shaped roster row for a new row. */
export declare function rosterRowFor(input: {
    id: string;
    credential: PoolCredential;
    identity?: string;
    label?: string;
    addedAt: number;
}): Record<string, unknown>;
/** The state-file fields a credential occupies, in the older readers' names. */
export declare function stateFieldsFor(credential: PoolCredential, lastRefreshedAt: number | undefined): Record<string, unknown>;
export declare function storedCredential(credential: PoolCredential, lastRefreshedAt: number | undefined): StoredCredential;
export declare function credentialProblem(credential: unknown, options?: {
    baseURLOptional?: boolean;
}): string | undefined;
