import { disableIdentityDuplicates, disableIn, enableIn, IDENTITY_CONTRADICTED_REASON_PREFIX, recordIdentityIn, } from './identity.js';
import { buildRawRows, CREDENTIAL_STAMP_KEY, credentialDigest, dispatchDigest, entryIn, isRecord, parseStamp, rosterRowIn, setEntryIn, } from './schema.js';
/*
 * A replace changes both files: the state file gets the new credential and
 * the config gets the new epoch, identity or endpoint. It writes the state
 * file first, stamping the credential with the epoch it belongs to and the
 * binding (identity, endpoint) the config is about to get. A crash between
 * the two writes therefore leaves a credential whose stamp is ahead of the
 * config's epoch, and that is how every reader tells such a torn row from a
 * whole one. The stamp holds everything the config write would have written,
 * so a torn row is completed forward: readers are shown the completed row
 * (never a candidate until it is on disk) and the next store write on it
 * writes the config to match.
 *
 * A stamp counts only beside the credential it was written with (its digest
 * matches): a writer that does not know about stamps may put another
 * credential beside an old one, and that stamp then says nothing. A stamp at
 * or behind the config's epoch is never torn as a replace: this store's own
 * writes leave the state file ahead of the config, never behind it.
 *
 * Only a replace's stamp is ever completed as a replace. Since 0.4.4 every
 * stamp carries a binding, so a replace's says so itself (`replace: true`); a
 * stamp written by 0.4.3 or earlier has no dispatch digest, and those
 * versions wrote a binding only on replace, so such a stamp with a binding is
 * a replace's. A stamp from any other write that sits ahead of the config was
 * not left by a crash (those writes keep the row's epoch), and completing it
 * would rewrite the row's identity and drop its quota on a foreign writer's
 * say-so. With `requireCredentialStamps` a 0.4.3-shaped replace stamp is not
 * completed either: it proves nothing about the token sent, so the strict
 * store leaves the row as it is on disk (`legacy`, unbound) rather than act
 * on it; a store without the option completes it as before.
 *
 * A strict store also completes a replace only when its stamp describes what
 * the completed row would send: the stamp's dispatch digest must be that of
 * the credential beside it, with an API key moved to the endpoint the binding
 * names. The lineage digest alone covers the refresh token or API key, so
 * without this check another writer that changed only the access token, the
 * expiry or the endpoint would still have the strict store rewrite the row's
 * epoch, identity and quota before refusing the row as unbound. A store
 * without the option never compared dispatch digests here and still does not.
 *
 * A write that gives a row its first identity (`recordIdentity`, or a
 * `rotate` or refresh that learns one) follows the same order: the stamp
 * naming the identity first, then the config recording it. A crash between
 * leaves a stamp at the row's epoch, matching the credential beside it
 * exactly (digest and dispatch digest), that names an identity the config
 * does not record; that is completed forward the same way, by recording the
 * identity.
 *
 * An attributed `disable` or `enable` that also changes the provider state
 * follows the same order. Its state write carries the new value and, in the
 * stamp, the transition (`transition: {mark, enabled, reason?}`, see
 * `StampedTransition`); its config write then flips the row and records the
 * transition's mark in the row's entry (`transitionMark`). A stamp bound to
 * the row (this credential, epoch and identity, the binding that also shows
 * the provider state beside it) whose transition mark the entry does not
 * record is such a write stopped between its two writes, and is completed
 * forward the same way: readers are shown the row disabled or enabled as the
 * transition says, beside the value written with it. Once the config records
 * the mark the transition says nothing more, so a later `enable` or
 * `disable` of the row is never undone by it; a credential write drops it
 * with the rest of the old stamp.
 */
/** Key, inside a credential stamp, of an attributed enable or disable. */
export const TRANSITION_STAMP_KEY = 'transition';
/**
 * Key, inside a per-row config entry, of the mark of the last transition the
 * config carries out. Older readers ignore it.
 */
export const TRANSITION_MARK_KEY = 'transitionMark';
/** The well-formed transition in a raw stamp, or undefined. */
function stampedTransition(rawStamp) {
    if (!isRecord(rawStamp))
        return undefined;
    const raw = rawStamp[TRANSITION_STAMP_KEY];
    if (!isRecord(raw))
        return undefined;
    if (typeof raw.mark !== 'string' || raw.mark.length === 0)
        return undefined;
    if (raw.enabled === true)
        return { mark: raw.mark, enabled: true };
    if (raw.enabled === false && typeof raw.reason === 'string')
        return { mark: raw.mark, enabled: false, reason: raw.reason };
    return undefined;
}
/**
 * Carries a transition out in a config being edited: the row's enabled flag
 * and reason as the transition says, and its mark recorded in the entry (a
 * row without an entry gets one at epoch 1, as `disableIn` gives it). An
 * enable then applies the duplicate-identity rule, as every write that
 * enables an OAuth row with a known identity does: the earlier row in roster
 * order keeps the identity.
 */
export function applyTransition(editor, id, transition) {
    if (transition.enabled)
        enableIn(editor, id);
    else
        disableIn(editor, id, transition.reason ?? '');
    if (!editor.rosterRow(id))
        return;
    const entry = editor.entry(id) ?? {
        credentialEpoch: 1,
        needsFirstReading: true,
    };
    editor.setEntry(id, { ...entry, [TRANSITION_MARK_KEY]: transition.mark });
    if (!transition.enabled)
        return;
    const row = editor.rows().find((candidate) => candidate.id === id);
    if (row?.type === 'oauth' && row.identity !== undefined)
        disableIdentityDuplicates(editor, row.identity);
}
/**
 * The credential a torn replace leaves once its config write lands: the
 * credential loaded beside the stamp, with the endpoint the stamp's binding
 * names. Only an API key's endpoint lives in the config (an OAuth credential
 * is entirely in the state file, which the replace has already written). A
 * replace that moves a key to a new endpoint leaves the old `baseURL` and
 * `authHeader` in the config until its config write, so the binding's
 * `baseURL` and `authHeader` are the ones the replacement will be sent with.
 */
function projectedReplacement(credential, binding) {
    if (credential.type !== 'api')
        return credential;
    return {
        ...credential,
        ...(binding.baseURL !== undefined ? { baseURL: binding.baseURL } : {}),
        ...(binding.authHeader !== undefined
            ? { authHeader: binding.authHeader }
            : {}),
    };
}
/** Whether a well-formed stamp was written by a replace. */
function isReplaceStamp(stamp) {
    if (!stamp.binding)
        return false;
    return stamp.replace === true || stamp.dispatch === undefined;
}
/** Rows left between the two writes of an operation, by row id. */
export function tornStamps(config, state, codec, options = {}) {
    const accounts = isRecord(state.accounts) ? state.accounts : {};
    const torn = new Map();
    for (const row of buildRawRows(config, state, codec)) {
        if (row.invalid || !row.credential)
            continue;
        const account = Object.hasOwn(accounts, row.id)
            ? accounts[row.id]
            : undefined;
        if (!isRecord(account))
            continue;
        const stamp = parseStamp(account[CREDENTIAL_STAMP_KEY]);
        if (!stamp?.binding)
            continue;
        if (stamp.digest !== credentialDigest(row.credential))
            continue;
        // A row without an entry is at epoch 1, as everywhere else.
        const epoch = row.credentialEpoch ?? 1;
        if (stamp.credentialEpoch > epoch) {
            if (!isReplaceStamp(stamp))
                continue;
            if (options.requireCredentialStamps) {
                if (stamp.dispatch === undefined)
                    continue;
                // `digest` covers only the refresh token or API key, so another
                // writer may still have changed the access token, the expiry or the
                // endpoint the stamp names. `dispatch` covers all of what a request
                // sends; completing the replace when it disagrees would move the
                // row's epoch, identity and quota on a stamp that does not describe
                // the credential. So the replacement as it would be sent (the loaded
                // credential with the binding's endpoint) must have the stamp's
                // dispatch digest; otherwise the row stays as on disk (unbound).
                if (stamp.dispatch !==
                    dispatchDigest(projectedReplacement(row.credential, stamp.binding)))
                    continue;
            }
            torn.set(row.id, {
                kind: 'replace',
                stamp: { ...stamp, binding: stamp.binding },
            });
        }
        else if (stamp.credentialEpoch === epoch &&
            stamp.dispatch !== undefined &&
            stamp.dispatch === dispatchDigest(row.credential) &&
            stamp.binding.identity !== undefined &&
            row.identity === undefined) {
            torn.set(row.id, { kind: 'identity', identity: stamp.binding.identity });
        }
        else if (stamp.credentialEpoch === epoch &&
            stamp.binding.identity === row.identity) {
            // The lineage digest alone misses an access-token or expiry edit. A
            // strict store must not repair the config from a transition whose stamp
            // no longer describes the credential; the row stays unbound instead.
            if (options.requireCredentialStamps &&
                stamp.dispatch !== dispatchDigest(row.credential))
                continue;
            const transition = stampedTransition(account[CREDENTIAL_STAMP_KEY]);
            if (transition &&
                entryIn(config, row.id)?.[TRANSITION_MARK_KEY] !== transition.mark)
                torn.set(row.id, { kind: 'transition', transition });
        }
    }
    return torn;
}
/**
 * The config half of a replacement: the row's entry moves to the new epoch,
 * loses its quota and needs a first reading; its roster row gets the new
 * identity (or loses the old one) and, for an API key, the new endpoint.
 * Disabling later rows that share the new identity is left to the caller
 * (`disableIdentityDuplicates`), so several rows can be bound first.
 */
export function bindReplacement(editor, id, credentialEpoch, binding) {
    const entry = editor.entry(id) ?? {};
    const next = {
        ...entry,
        credentialEpoch,
        needsFirstReading: true,
    };
    delete next.quota;
    // An explicit identity supplied with a replacement is the adapter's validated
    // account binding. Clear its quarantine on completion, including crash recovery,
    // but leave the row disabled until a separate enable.
    if (binding.identity !== undefined &&
        typeof next.disabledReason === 'string' &&
        next.disabledReason.startsWith(IDENTITY_CONTRADICTED_REASON_PREFIX))
        delete next.disabledReason;
    editor.setEntry(id, next);
    const raw = editor.rosterRow(id);
    if (!raw)
        return;
    if (binding.identity !== undefined)
        raw.accountId = binding.identity;
    else
        delete raw.accountId;
    if (binding.baseURL !== undefined)
        raw.baseURL = binding.baseURL;
    if (binding.authHeader !== undefined)
        raw.authHeader = binding.authHeader;
}
/**
 * The config with every torn row completed as its interrupted write would
 * have left it, and the ids completed. The config passed in is not modified;
 * when nothing is torn it is returned as is.
 */
export function completeTornRows(config, state, codec, options = {}) {
    const completions = tornStamps(config, state, codec, options);
    if (completions.size === 0)
        return { config, torn: [] };
    const next = structuredClone(config);
    const editor = {
        rows: () => buildRawRows(next, state, codec),
        rosterRow: (id) => rosterRowIn(next, id),
        entry: (id) => entryIn(next, id),
        setEntry: (id, entry) => setEntryIn(next, id, entry),
    };
    for (const [id, completion] of completions)
        if (completion.kind === 'replace')
            bindReplacement(editor, id, completion.stamp.credentialEpoch, completion.stamp.binding);
    for (const [id, completion] of completions) {
        if (completion.kind === 'identity')
            recordIdentityIn(editor, id, completion.identity);
        else if (completion.kind === 'transition')
            applyTransition(editor, id, completion.transition);
        else if (completion.stamp.binding.identity !== undefined)
            disableIdentityDuplicates(editor, completion.stamp.binding.identity);
    }
    return { config: next, torn: [...completions.keys()] };
}
/**
 * The rows every reader gets. A torn row is shown completed (the identity,
 * endpoint and epoch its stamp names, beside the credential it stamps), is
 * marked `torn` and is never a candidate; every other row is as on disk.
 * With `requireCredentialStamps`, a row whose stamp is not `bound` is marked
 * `unbound` and is never a candidate either. A torn row is shown with the
 * stamp of the interrupted write, which binds the completed row, so it is not
 * unbound; once a store write puts its completion on disk it is no longer
 * torn and is a candidate again like any other row.
 */
export function loadRows(config, state, codec, options = {}) {
    const { config: whole, torn } = completeTornRows(config, state, codec, options);
    // A torn replace wrote its provider state beside the new credential, under
    // the stamp naming the new epoch, so the completed row shows the new
    // credential with the state written for it, never with the old one.
    const rows = buildRawRows(whole, state, codec, options.providerState);
    for (const row of rows) {
        if (torn.includes(row.id)) {
            row.torn = true;
            row.candidate = false;
        }
        if (options.requireCredentialStamps && row.stamp !== 'bound') {
            row.unbound = true;
            row.candidate = false;
        }
    }
    return rows;
}
