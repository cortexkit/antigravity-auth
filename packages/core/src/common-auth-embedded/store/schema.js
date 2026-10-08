import { createHash } from 'node:crypto';
/** Top-level key of the config file that holds everything the pool adds. */
export const POOL_KEY = 'commonAuthPool';
/** The pool schema this library reads and writes. */
export const POOL_SCHEMA_VERSION = 1;
/** Property of `commonAuthPool` holding the per-row entries, keyed by local id. */
export const POOL_ROWS_KEY = 'rows';
/**
 * Property of `commonAuthPool` (since 0.8.0) holding, per id, the highest
 * credential epoch a row with that id held when the store last dropped it
 * from the pool. A row added later under the same id starts past it (see
 * `nextAddEpochIn`), so an attribution taken for the dropped row never
 * matches the new one. Older readers ignore it, and older writers keep it
 * as they keep every pool key they do not know.
 */
export const POOL_RETIRED_EPOCHS_KEY = 'retiredEpochs';
/** The `version` older readers of the same files expect at the top level. */
export const LEGACY_STORE_VERSION = 1;
/**
 * How far ahead of the clock a stored `lastRefreshedAt` may sit and still be
 * trusted. Older readers of the state file apply the same bound, and a stamp
 * strictly above it counts as absent when they compare two copies of a token.
 */
export const REFRESH_STAMP_TOLERANCE_MS = 5 * 60_000;
/**
 * Key, inside a state-file account entry, of the stamp naming what the
 * credential beside it belongs to. Older readers ignore it.
 */
export const CREDENTIAL_STAMP_KEY = POOL_KEY;
/**
 * Key, inside a state-file account entry, of the provider state kept beside
 * the credential. Older readers ignore it.
 */
export const PROVIDER_STATE_KEY = 'commonAuthProviderState';
export function isRecord(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * Ids are stored exactly as given. Older readers trim ids, so an id with
 * surrounding whitespace would be renamed by them; such ids, empty ids and
 * prototype keys are refused instead of being rewritten.
 */
export function idProblem(id) {
    if (typeof id !== 'string' || id.length === 0)
        return 'id must be non-empty';
    if (id.trim() !== id)
        return 'id must not carry surrounding whitespace';
    if (UNSAFE_IDS.has(id))
        return 'id is a reserved object key';
    return undefined;
}
/** Same URL rule the older readers apply to an API-key row's `baseURL`. */
export function isValidBaseURL(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw)
        return false;
    try {
        const url = new URL(raw);
        return ((url.protocol === 'http:' || url.protocol === 'https:') &&
            !url.username &&
            !url.password);
    }
    catch {
        return false;
    }
}
function secretOf(credential) {
    return credential.type === 'oauth'
        ? `oauth\0${credential.refresh}`
        : `api\0${credential.apiKey}`;
}
export function fingerprintOf(credential) {
    return createHash('sha256').update(secretOf(credential)).digest('hex');
}
/**
 * The digest a credential stamp carries. It is kept apart from the
 * fingerprint (a different input prefix) so the persisted value is never the
 * dedupe key.
 */
export function credentialDigest(credential) {
    return createHash('sha256')
        .update(`credential-stamp\0${secretOf(credential)}`)
        .digest('hex');
}
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
export function dispatchDigest(credential) {
    const parts = credential.type === 'oauth'
        ? [
            'oauth',
            typeof credential.access === 'string' ? credential.access : null,
            credential.refresh,
            typeof credential.expires === 'number' &&
                Number.isFinite(credential.expires)
                ? credential.expires
                : null,
        ]
        : [
            'api',
            credential.apiKey,
            credential.baseURL.trim(),
            credential.authHeader ?? 'authorization-bearer',
        ];
    return createHash('sha256')
        .update(`credential-dispatch\0${JSON.stringify(parts)}`)
        .digest('hex');
}
/**
 * The stamp for a credential written into a row at `credentialEpoch`, beside
 * the config `binding` describes. `replace` is set only by a replace.
 */
export function stampFor(credential, credentialEpoch, binding, options = {}) {
    return {
        credentialEpoch,
        digest: credentialDigest(credential),
        dispatch: dispatchDigest(credential),
        binding: { ...binding },
        ...(options.replace ? { replace: true } : {}),
        ...(options.providerState !== undefined
            ? { providerState: options.providerState }
            : {}),
    };
}
/**
 * The digest a stamp carries for a provider state: of its credential-bound
 * part (`ProviderStateCodec.credentialBound`, the whole value without it), as
 * it serializes. The store only ever stores values that survive a JSON round
 * trip unchanged, so the digest of a value read back from disk equals the one
 * computed when it was written. Its input prefix differs from every other
 * digest the store writes.
 */
export function providerStateDigest(codec, value) {
    const bound = codec?.credentialBound ? codec.credentialBound(value) : value;
    return createHash('sha256')
        .update(`provider-state\0${JSON.stringify(bound ?? null)}`)
        .digest('hex');
}
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
export function boundProviderStateDigest(account, credential, credentialEpoch, identity) {
    if (!credential || credentialEpoch === undefined)
        return undefined;
    if (!isRecord(account) || !Object.hasOwn(account, PROVIDER_STATE_KEY))
        return undefined;
    const stamp = parseStamp(account[CREDENTIAL_STAMP_KEY]);
    if (!stamp ||
        stamp.providerState === undefined ||
        stamp.digest !== credentialDigest(credential) ||
        stamp.credentialEpoch !== credentialEpoch ||
        stamp.binding?.identity !== identity)
        return undefined;
    return stamp.providerState;
}
/**
 * A credential epoch is a positive safe integer. Above `MAX_SAFE_INTEGER`,
 * adding one may give back the same number, so a replace would not move the
 * epoch and nothing could tell the old credential's work from the new one's.
 */
export function isCredentialEpoch(value) {
    return Number.isSafeInteger(value) && value >= 1;
}
/** A well-formed stamp, or undefined for anything else (which is ignored). */
export function parseStamp(raw) {
    if (!isRecord(raw))
        return undefined;
    const epoch = raw.credentialEpoch;
    if (!isCredentialEpoch(epoch))
        return undefined;
    if (typeof raw.digest !== 'string')
        return undefined;
    if ('dispatch' in raw && typeof raw.dispatch !== 'string')
        return undefined;
    if ('replace' in raw && raw.replace !== true)
        return undefined;
    if ('providerState' in raw && typeof raw.providerState !== 'string')
        return undefined;
    const marks = {
        ...(typeof raw.dispatch === 'string' ? { dispatch: raw.dispatch } : {}),
        ...(raw.replace === true ? { replace: true } : {}),
        ...(typeof raw.providerState === 'string'
            ? { providerState: raw.providerState }
            : {}),
    };
    // Every stamp that carries a dispatch digest or a provider-state digest is
    // written with a binding; one without is not a stamp this store writes,
    // and it would leave the row's identity unchecked.
    if (!('binding' in raw))
        return 'dispatch' in raw || 'replace' in raw || 'providerState' in raw
            ? undefined
            : { credentialEpoch: epoch, digest: raw.digest };
    const binding = raw.binding;
    if (!isRecord(binding))
        return undefined;
    if ('identity' in binding &&
        (typeof binding.identity !== 'string' || !binding.identity))
        return undefined;
    if ('baseURL' in binding && !isValidBaseURL(binding.baseURL))
        return undefined;
    if ('authHeader' in binding &&
        binding.authHeader !== 'authorization-bearer' &&
        binding.authHeader !== 'x-api-key')
        return undefined;
    return {
        credentialEpoch: epoch,
        digest: raw.digest,
        ...marks,
        binding: {
            ...(typeof binding.identity === 'string'
                ? { identity: binding.identity }
                : {}),
            ...(typeof binding.baseURL === 'string'
                ? { baseURL: binding.baseURL.trim() }
                : {}),
            ...(binding.authHeader === 'authorization-bearer' ||
                binding.authHeader === 'x-api-key'
                ? { authHeader: binding.authHeader }
                : {}),
        },
    };
}
/**
 * Whether the binding of a stamp is the row's: the identity it names (or its
 * naming none) must be exactly the row's recorded identity, and an endpoint
 * it names must be the one the row sends its API key to.
 *
 * Every write that gives a row an identity (`add`, `replace`, `rotate` or a
 * refresh that learns one, `recordIdentity`) writes the stamp naming it
 * before the config, so this store never leaves a config identity beside a
 * stamp that names none or another: that is another writer's doing and is
 * `mismatched`. The reverse, a stamp naming an identity beside a config that
 * has none, is such a write stopped between its two writes: the row as
 * `buildRawRows` reads it from the files is `mismatched`, but `loadRows`,
 * which every reader goes through, shows it with the identity recorded (see
 * `torn.ts`), where it is `bound`.
 */
function bindingAgrees(binding, credential, identity) {
    if (binding.identity !== identity)
        return false;
    if (binding.baseURL !== undefined &&
        (credential.type !== 'api' || credential.baseURL !== binding.baseURL))
        return false;
    if (binding.authHeader !== undefined &&
        (credential.type !== 'api' || credential.authHeader !== binding.authHeader))
        return false;
    return true;
}
/**
 * The stamp status of a loaded row (see `CredentialStampStatus`).
 * `credentialEpoch` is undefined only when the row's per-row entry exists but
 * failed validation, in which case no stamp can match it.
 */
function stampStatusOf(credential, credentialEpoch, identity, account) {
    if (!credential)
        return 'none';
    if (!isRecord(account) || !Object.hasOwn(account, CREDENTIAL_STAMP_KEY))
        return 'missing';
    const stamp = parseStamp(account[CREDENTIAL_STAMP_KEY]);
    if (!stamp)
        return 'malformed';
    if (stamp.digest !== credentialDigest(credential))
        return 'mismatched';
    // A stamp from 0.4.3 or earlier proves neither the token sent nor (its
    // binding being optional and identity-lenient) the account, so it is
    // reported as such whatever else it says, and never as bound.
    if (stamp.dispatch === undefined)
        return 'legacy';
    if (stamp.credentialEpoch !== credentialEpoch)
        return 'mismatched';
    // `parseStamp` refuses a stamp with a dispatch digest and no binding.
    if (!stamp.binding || !bindingAgrees(stamp.binding, credential, identity))
        return 'mismatched';
    if (stamp.dispatch !== dispatchDigest(credential))
        return 'mismatched';
    return 'bound';
}
export function classifyConfig(read) {
    if (!read.exists)
        return { status: 'ready', exists: false, config: {} };
    if ('parseError' in read)
        return { status: 'error', reason: 'config file is not valid JSON' };
    const value = read.value;
    if (!isRecord(value))
        return { status: 'error', reason: 'config root is not an object' };
    if ('accounts' in value && !Array.isArray(value.accounts))
        return { status: 'error', reason: 'config accounts is not an array' };
    if (!(POOL_KEY in value)) {
        return Array.isArray(value.accounts)
            ? { status: 'pending-migration', config: value }
            : { status: 'ready', exists: true, config: value };
    }
    const pool = value[POOL_KEY];
    if (!isRecord(pool))
        return { status: 'error', reason: `${POOL_KEY} is not an object` };
    const version = pool.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
        return { status: 'error', reason: `${POOL_KEY}.schemaVersion is invalid` };
    if (version > POOL_SCHEMA_VERSION)
        return {
            status: 'error',
            reason: `${POOL_KEY}.schemaVersion ${version} is newer than ${POOL_SCHEMA_VERSION}`,
        };
    if (POOL_ROWS_KEY in pool && !isRecord(pool[POOL_ROWS_KEY]))
        return {
            status: 'error',
            reason: `${POOL_KEY}.${POOL_ROWS_KEY} is not an object`,
        };
    return { status: 'ready', exists: true, config: value };
}
export function classifyState(read) {
    if (!read.exists)
        return { status: 'ready', exists: false, state: {} };
    if ('parseError' in read)
        return { status: 'error', reason: 'state file is not valid JSON' };
    if (!isRecord(read.value))
        return { status: 'error', reason: 'state root is not an object' };
    if ('accounts' in read.value && !isRecord(read.value.accounts))
        return { status: 'error', reason: 'state accounts is not an object' };
    return { status: 'ready', exists: true, state: read.value };
}
export function rosterOf(config) {
    return Array.isArray(config.accounts) ? config.accounts : [];
}
export function entriesOf(config) {
    const pool = config[POOL_KEY];
    if (!isRecord(pool))
        return {};
    const rows = pool[POOL_ROWS_KEY];
    return isRecord(rows) ? rows : {};
}
function stateAccountsOf(state) {
    return isRecord(state.accounts) ? state.accounts : {};
}
/** The reason a roster row cannot be loaded, mirroring the older readers. */
function rosterRowProblem(raw) {
    if (!isRecord(raw))
        return 'not an object';
    const problem = idProblem(raw.id);
    if (problem)
        return problem;
    if (raw.type === 'api')
        return isValidBaseURL(raw.baseURL) ? undefined : 'invalid baseURL';
    if (raw.type === 'oauth')
        return undefined;
    return 'unknown type';
}
function parseEntry(raw, codec) {
    if (!isRecord(raw))
        return undefined;
    const epoch = raw.credentialEpoch;
    if (!isCredentialEpoch(epoch))
        return undefined;
    if ('needsFirstReading' in raw && typeof raw.needsFirstReading !== 'boolean')
        return undefined;
    if ('disabledReason' in raw && typeof raw.disabledReason !== 'string')
        return undefined;
    if ('quota' in raw && !codec.validate(raw.quota))
        return undefined;
    return {
        credentialEpoch: epoch,
        needsFirstReading: raw.needsFirstReading === true,
        ...(typeof raw.disabledReason === 'string'
            ? { disabledReason: raw.disabledReason }
            : {}),
        ...('quota' in raw ? { quota: raw.quota } : {}),
    };
}
function credentialFor(raw, stateEntry) {
    if (!isRecord(stateEntry))
        return undefined;
    if (raw.type === 'api') {
        const apiKey = typeof stateEntry.apiKey === 'string' ? stateEntry.apiKey.trim() : '';
        if (!apiKey)
            return undefined;
        return {
            type: 'api',
            apiKey,
            baseURL: String(raw.baseURL).trim(),
            authHeader: raw.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer',
        };
    }
    if (raw.corrupt === true)
        return undefined;
    const refresh = stateEntry.refresh;
    if (typeof refresh !== 'string' || !refresh.trim())
        return undefined;
    return {
        type: 'oauth',
        refresh,
        ...(typeof stateEntry.access === 'string'
            ? { access: stateEntry.access }
            : {}),
        ...(typeof stateEntry.expires === 'number'
            ? { expires: stateEntry.expires }
            : {}),
        ...(typeof stateEntry.lastRefreshedAt === 'number'
            ? { lastRefreshedAt: stateEntry.lastRefreshedAt }
            : {}),
    };
}
/** The first roster row with this id (the one the pool loads). */
export function rosterRowIn(config, id) {
    return rosterOf(config).find((raw) => isRecord(raw) && raw.id === id);
}
/** The pool object of a config, created (empty) when absent. */
function ensurePool(config) {
    if (!isRecord(config[POOL_KEY]))
        config[POOL_KEY] = {};
    return config[POOL_KEY];
}
/** The per-row entries of a config, created (empty) when absent. */
export function ensureEntries(config) {
    const pool = ensurePool(config);
    if (!isRecord(pool[POOL_ROWS_KEY]))
        pool[POOL_ROWS_KEY] = {};
    return pool[POOL_ROWS_KEY];
}
export function entryIn(config, id) {
    const entries = entriesOf(config);
    const entry = Object.hasOwn(entries, id) ? entries[id] : undefined;
    return isRecord(entry) ? entry : undefined;
}
/** Sets an entry as an own property, so an id such as `toString` is safe. */
export function setEntryIn(config, id, entry) {
    Object.defineProperty(ensureEntries(config), id, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}
/**
 * The credential epoch recorded for a dropped id (see
 * `POOL_RETIRED_EPOCHS_KEY`), or undefined when none is. A value that is not
 * a credential epoch counts as none.
 */
export function retiredEpochIn(config, id) {
    const pool = config[POOL_KEY];
    if (!isRecord(pool))
        return undefined;
    const retired = pool[POOL_RETIRED_EPOCHS_KEY];
    if (!isRecord(retired) || !Object.hasOwn(retired, id))
        return undefined;
    const epoch = retired[id];
    return isCredentialEpoch(epoch) ? epoch : undefined;
}
/**
 * The epoch a per-row entry claims, read without validating the rest of the
 * entry, or undefined when it names none a reader would accept.
 */
function entryEpochIn(config, id) {
    const epoch = entryIn(config, id)?.credentialEpoch;
    return isCredentialEpoch(epoch) ? epoch : undefined;
}
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
export function nextAddEpochIn(config, id) {
    return (Math.max(retiredEpochIn(config, id) ?? 0, entryEpochIn(config, id) ?? 0) + 1);
}
/**
 * Records, in a config being written, the epochs of the ids it drops: for
 * each, the epoch its entry claims (1 for a row without one, the epoch such a
 * row is at), kept only when above what is already recorded, so the record
 * for an id never goes down. Valid recorded values of other ids are kept; a
 * record that is not an object, or a value in it that is not an epoch, says
 * nothing and is replaced. An entry whose epoch cannot be read records 1.
 */
export function retireEpochsIn(config, dropped) {
    const ids = [...dropped];
    if (ids.length === 0)
        return;
    const pool = ensurePool(config);
    const previous = isRecord(pool[POOL_RETIRED_EPOCHS_KEY])
        ? pool[POOL_RETIRED_EPOCHS_KEY]
        : {};
    const next = {};
    const define = (id, epoch) => Object.defineProperty(next, id, {
        value: epoch,
        enumerable: true,
        writable: true,
        configurable: true,
    });
    for (const [id, epoch] of Object.entries(previous))
        if (isCredentialEpoch(epoch))
            define(id, epoch);
    for (const id of ids)
        define(id, Math.max(retiredEpochIn(config, id) ?? 0, entryEpochIn(config, id) ?? 1));
    pool[POOL_RETIRED_EPOCHS_KEY] = next;
}
/**
 * Builds the rows of a ready pool from the files exactly as they are, without
 * looking at credential stamps (see `loadRows` for the rows every reader
 * gets). A roster row the older readers would reject, a duplicate id, or a
 * malformed per-row entry makes that one row invalid (never a candidate) and
 * blocks nothing else.
 */
export function buildRawRows(config, state, codec, providerCodec) {
    const entries = entriesOf(config);
    const stateAccounts = stateAccountsOf(state);
    const seen = new Set();
    const rows = [];
    for (const raw of rosterOf(config)) {
        const problem = rosterRowProblem(raw);
        const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined;
        if (problem || !isRecord(raw) || id === undefined || seen.has(id)) {
            if (id !== undefined && !seen.has(id))
                seen.add(id);
            if (id !== undefined)
                rows.push({
                    id,
                    type: isRecord(raw) && raw.type === 'api' ? 'api' : 'oauth',
                    enabled: false,
                    needsFirstReading: true,
                    hasEntry: Object.hasOwn(entries, id),
                    candidate: false,
                    invalid: 'roster',
                    stamp: 'none',
                });
            continue;
        }
        seen.add(id);
        const type = raw.type === 'api' ? 'api' : 'oauth';
        const hasEntry = Object.hasOwn(entries, id);
        const entry = hasEntry ? parseEntry(entries[id], codec) : undefined;
        const credential = credentialFor(raw, stateAccounts[id]);
        const enabled = raw.enabled !== false;
        // A row without a per-row entry is at credential epoch 1 (the epoch the
        // store stamps and later gives it), so its stamp is checked against 1.
        const stampEpoch = entry ? entry.credentialEpoch : hasEntry ? undefined : 1;
        const identity = typeof raw.accountId === 'string' && raw.accountId
            ? raw.accountId
            : undefined;
        const row = {
            id,
            type,
            enabled,
            needsFirstReading: entry ? entry.needsFirstReading : type === 'oauth',
            hasEntry,
            candidate: false,
            ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
            ...(typeof raw.addedAt === 'number' ? { addedAt: raw.addedAt } : {}),
            ...(identity !== undefined ? { identity } : {}),
            ...(credential
                ? { credential, fingerprint: fingerprintOf(credential) }
                : {}),
            ...(entry ? { credentialEpoch: entry.credentialEpoch } : {}),
            ...(entry?.disabledReason !== undefined
                ? { disabledReason: entry.disabledReason }
                : {}),
            ...(entry && 'quota' in entry ? { quota: entry.quota } : {}),
            ...providerStateFields(stateAccounts[id], credential, stampEpoch, identity, providerCodec),
            stamp: stampStatusOf(credential, stampEpoch, identity, stateAccounts[id]),
        };
        if (hasEntry && !entry) {
            row.invalid = 'entry';
        }
        else {
            row.candidate = enabled && credential !== undefined;
        }
        rows.push(row);
    }
    return rows;
}
/**
 * The provider-state fields of a loaded row. A value on disk is shown only
 * when the stamp beside the credential binds a provider state to this row's
 * credential, epoch and identity (see `boundProviderStateDigest`), the codec
 * accepts the value, and the value's credential-bound part has the digest
 * that stamp names. Otherwise the row says why it shows none and stays
 * usable: the value is the plugin's own derived data, which it can rebuild,
 * and the credential beside it may well be sound.
 */
function providerStateFields(account, credential, credentialEpoch, identity, codec) {
    if (!isRecord(account) || !Object.hasOwn(account, PROVIDER_STATE_KEY))
        return {};
    const digest = boundProviderStateDigest(account, credential, credentialEpoch, identity);
    if (digest === undefined)
        return { providerStateDropped: 'uncovered' };
    const value = account[PROVIDER_STATE_KEY];
    // The value is validated before it is projected, so the projection only
    // ever sees a value of the shape the codec accepts.
    if (!codec?.validate(value))
        return { providerStateDropped: 'invalid' };
    if (providerStateDigest(codec, value) !== digest)
        return { providerStateDropped: 'uncovered' };
    return { providerState: value };
}
/** The row-lock key: recorded wire identity when known, else the local id. */
export function rowLockKey(row) {
    return row.identity ?? row.id;
}
/**
 * The refresh stamp a write persists: the clock, raised to one past a prior
 * stamp that is still trusted, so a stale copy of the previous token can never
 * compare newer than the rotation. A prior stamp beyond the trust bound says
 * nothing and is ignored.
 */
export function rotationStamp(prior, now) {
    if (prior === undefined || prior > now + REFRESH_STAMP_TOLERANCE_MS)
        return now;
    return Math.max(now, prior + 1);
}
/** True when a rotation stamped now would itself be past the trust bound. */
export function rotationStampUntrusted(prior, now) {
    return rotationStamp(prior, now) > now + REFRESH_STAMP_TOLERANCE_MS;
}
/** The legacy-shaped roster row for a new row. */
export function rosterRowFor(input) {
    const { id, credential, identity, label, addedAt } = input;
    return {
        id,
        ...(label !== undefined ? { label } : {}),
        type: credential.type,
        addedAt,
        ...(identity !== undefined ? { accountId: identity } : {}),
        ...(credential.type === 'api'
            ? {
                baseURL: credential.baseURL.trim(),
                authHeader: credential.authHeader ?? 'authorization-bearer',
            }
            : {}),
    };
}
/** The state-file fields a credential occupies, in the older readers' names. */
export function stateFieldsFor(credential, lastRefreshedAt) {
    if (credential.type === 'api')
        return { apiKey: credential.apiKey };
    return {
        ...(credential.access !== undefined ? { access: credential.access } : {}),
        refresh: credential.refresh,
        ...(credential.expires !== undefined
            ? { expires: credential.expires }
            : {}),
        ...(lastRefreshedAt !== undefined ? { lastRefreshedAt } : {}),
    };
}
export function storedCredential(credential, lastRefreshedAt) {
    if (credential.type === 'api')
        return {
            ...credential,
            baseURL: credential.baseURL.trim(),
            authHeader: credential.authHeader ?? 'authorization-bearer',
        };
    return {
        ...credential,
        ...(lastRefreshedAt !== undefined ? { lastRefreshedAt } : {}),
    };
}
export function credentialProblem(credential, options = {}) {
    if (!isRecord(credential))
        return 'credential must be an object';
    if (credential.type === 'oauth') {
        if (typeof credential.refresh !== 'string' || !credential.refresh.trim())
            return 'oauth credential needs a refresh token';
        return undefined;
    }
    if (credential.type === 'api') {
        if (typeof credential.apiKey !== 'string' || !credential.apiKey.trim())
            return 'api credential needs an api key';
        if (credential.apiKey.trim() !== credential.apiKey)
            return 'api key must not carry surrounding whitespace';
        const omitted = options.baseURLOptional && credential.baseURL === undefined;
        if (!omitted && !isValidBaseURL(credential.baseURL))
            return 'api credential needs a valid baseURL';
        return undefined;
    }
    return 'credential type must be oauth or api';
}
