import { assertNotInsideHook, runInsideHook } from './hooks.js';
import { runOperation, withTransaction } from './mutate.js';
import { readRow, refusal, requireBound, rowLockSpec, unknownRow, } from './runtime.js';
import { boundProviderStateDigest, CREDENTIAL_STAMP_KEY, credentialDigest, isCredentialEpoch, isRecord, PROVIDER_STATE_KEY, parseStamp, providerStateDigest, rowLockKey, } from './schema.js';
/**
 * A provider state as the store will store it: a JSON round trip of it (so
 * its digest is the same once read back from disk), accepted by the codec.
 * Refused before anything is written when the store has no codec, the value
 * is not JSON, or the codec rejects it.
 */
export function acceptProviderState(codec, operation, id, value, what = 'the provider state') {
    if (!codec)
        throw refusal(operation, id, 'invalid-input', 'the store was opened without a provider-state codec');
    let normalized;
    try {
        const text = JSON.stringify(value);
        normalized = text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        normalized = undefined;
    }
    if (normalized === undefined)
        throw refusal(operation, id, 'invalid-provider-state', `${what} cannot be stored as JSON`);
    if (!codec.validate(normalized))
        throw refusal(operation, id, 'invalid-provider-state', `the provider-state codec rejected ${what}`);
    return normalized;
}
/**
 * The write for a value a credential write brings (`add` of a secret the
 * pool holds, `rotate`, a refresh): merged with the row's value on disk by
 * the codec's `merge` when both exist, else the incoming value as is.
 */
export function mergedProviderState(codec, operation, id, onDisk, incoming) {
    if (onDisk === undefined || !codec?.merge)
        return { kind: 'set', value: incoming };
    return {
        kind: 'set',
        value: acceptProviderState(codec, operation, id, codec.merge(structuredClone(onDisk), structuredClone(incoming)), 'the merged provider state'),
    };
}
/**
 * The provider state a replace leaves on the row, decided before anything is
 * written: whatever the codec's `onReplace` returns (undefined clears it), or
 * without that hook the value handed to `replace`, else nothing. The old
 * credential's value is never kept by default: it describes the account the
 * replaced credential belonged to.
 */
export function replacementProviderState(codec, row, credentialEpoch, identity, incoming) {
    const hook = codec?.onReplace;
    const next = hook
        ? hook(row.providerState === undefined
            ? undefined
            : structuredClone(row.providerState), {
            id: row.id,
            credentialEpoch,
            ...(row.identity !== undefined
                ? { previousIdentity: row.identity }
                : {}),
            ...(identity !== undefined ? { identity } : {}),
            ...(incoming !== undefined
                ? { incoming: structuredClone(incoming) }
                : {}),
        })
        : incoming;
    if (next === undefined)
        return { kind: 'clear' };
    if (!hook)
        return { kind: 'set', value: next };
    return {
        kind: 'set',
        value: acceptProviderState(codec, 'replace', row.id, next, 'the provider state onReplace returned'),
    };
}
/**
 * The provider-state digest the stamp of a credential write carries, and the
 * state-file fields it changes. `set` binds the new value; `keep` carries the
 * old stamp's digest forward only when that stamp bound it to this row as it
 * stood before the write (same credential lineage, the epoch being written,
 * the identity recorded before the write); `clear` binds nothing.
 */
export function providerStateCoverage(codec, write, prior, priorRow, credentialEpoch) {
    if (write.kind === 'set')
        return providerStateDigest(codec, write.value);
    if (write.kind === 'clear')
        return undefined;
    return boundProviderStateDigest(prior, priorRow?.credential, credentialEpoch, priorRow?.identity);
}
/**
 * Changes a row's provider state without touching its credential, in one
 * state-file write under the row lock, the caller's extra locks and the
 * store locks. `fence` is what the caller read the row at: the write is
 * refused (`attribution`, retryable) when the row has since moved to another
 * credential epoch or recorded identity, and (`unknown-row`) once it is
 * removed, so a writer that read the row before a replace or a removal never
 * lands its value on the new credential or brings a removed row's state back.
 *
 * The value is bound by the stamp already beside the credential. When its
 * credential-bound part is unchanged the stamp is left byte for byte as it
 * is; otherwise only the stamp's provider-state digest changes, so the
 * credential's stamp status never moves. With `requireCredentialStamps`, an
 * unbound row refuses (`unbound-credential`) as every other strict path
 * does. Without it, a row whose stamp was not written by this store with this
 * credential at the row's epoch and identity refuses the same way: no stamp
 * could bind the value, so no reader would ever show it. A `rotate` or
 * `replace` stamps such a row.
 */
export async function updateProviderStateRow(rt, id, fence, mutator, options = {}) {
    assertNotInsideHook('updateProviderState');
    const { ctx } = rt;
    const operation = 'updateProviderState';
    return runOperation(ctx, operation, id, options.onFailure, async (locks, progress) => {
        const codec = ctx.providerState;
        if (!codec)
            throw refusal(operation, id, 'invalid-input', 'the store was opened without a provider-state codec');
        if (typeof mutator !== 'function')
            throw refusal(operation, id, 'invalid-input', 'a mutator is required');
        const captured = isRecord(fence) ? fence.credentialEpoch : undefined;
        if (!isCredentialEpoch(captured))
            throw refusal(operation, id, 'invalid-input', 'the credential epoch the provider state was read at is required');
        const { row: seen } = await readRow(rt, operation, id);
        await locks.acquire(rowLockSpec(rt, seen));
        for (const extra of options.extraLocks ?? [])
            await locks.acquire(extra);
        return withTransaction(ctx, locks, progress, { operation, rowId: id }, async (tx) => {
            const row = tx.row(id);
            if (!row)
                throw unknownRow(operation, id);
            if (rowLockKey(row) !== rowLockKey(seen))
                throw refusal(operation, id, 'row-key-changed', `row ${id}'s wire identity changed while its lock was being taken`, true);
            if (row.invalid)
                throw refusal(operation, id, 'invalid-row', `row ${id} failed validation`);
            if (!row.credential)
                throw refusal(operation, id, 'no-credential', `row ${id} holds no credential`);
            requireBound(operation, row);
            const epoch = row.credentialEpoch ?? 1;
            if (epoch !== captured || row.identity !== fence.identity)
                throw refusal(operation, id, 'attribution', `the provider state for ${id} was read for a credential or account the row no longer holds`, true);
            const plan = await planProviderStateIn(tx, codec, operation, row, mutator);
            if (plan.kind !== 'changed')
                return {
                    id,
                    outcome: 'unchanged',
                    ...(plan.kind === 'unchanged' && plan.value !== undefined
                        ? { providerState: plan.value }
                        : {}),
                };
            tx.setStateAccount(id, plan.account);
            await tx.commitState();
            return plan.value === undefined
                ? { id, outcome: 'cleared' }
                : { id, outcome: 'updated', providerState: plan.value };
        });
    });
}
/**
 * Returned by the provider-state mutator of an attributed `disable` or
 * `enable` to decline the whole transition: nothing is written, neither the
 * provider state nor the row's enabled flag, and the call resolves with
 * `declined: true`. A mutator declines when the state it is shown is newer
 * than what its caller saw, such as an eligibility recorded after the
 * request whose refusal is being acted on. It is a value of its own because
 * `undefined` already means "clear the provider state". `Symbol.for` keeps it
 * equal across two copies of this module loaded in one process.
 */
export const DECLINE_TRANSITION = Symbol.for('@cortexkit/common-auth/store/decline-transition');
/**
 * Runs a provider-state mutator for a row loaded under every lock and
 * already checked by the caller (present, valid, inside its attribution
 * fence), and plans the write. Refuses (`no-credential`) a row holding no
 * credential, and (`unbound-credential`) one whose credential carries no
 * stamp of this store at the row's epoch and identity: no stamp could bind
 * the value, so no reader would ever show it. `DECLINE_TRANSITION` is
 * honoured only when `declinable` is set; elsewhere it is not JSON and is
 * refused as such.
 */
export async function planProviderStateIn(tx, codec, operation, row, mutator, declinable = false) {
    const id = row.id;
    const credential = row.credential;
    if (!credential)
        throw refusal(operation, id, 'no-credential', `row ${id} holds no credential`);
    const epoch = row.credentialEpoch ?? 1;
    const account = tx.stateAccount(id);
    const rawStamp = account?.[CREDENTIAL_STAMP_KEY];
    const stamp = parseStamp(rawStamp);
    if (!isRecord(rawStamp) ||
        !stamp?.binding ||
        stamp.digest !== credentialDigest(credential) ||
        stamp.credentialEpoch !== epoch ||
        stamp.binding.identity !== row.identity)
        throw refusal(operation, id, 'unbound-credential', `row ${id}'s credential carries no stamp of this store to bind a provider state to (stamp ${row.stamp}); rotate or replace it first`);
    const current = row.providerState === undefined
        ? undefined
        : structuredClone(row.providerState);
    const returned = await runInsideHook(operation, () => mutator(current, row));
    if (declinable && returned === DECLINE_TRANSITION)
        return { kind: 'declined' };
    const next = returned === undefined
        ? undefined
        : acceptProviderState(codec, operation, id, returned, 'the provider state the mutator returned');
    const held = account !== undefined && Object.hasOwn(account, PROVIDER_STATE_KEY);
    if (next === undefined
        ? !held
        : row.providerState !== undefined &&
            JSON.stringify(row.providerState) === JSON.stringify(next))
        return { kind: 'unchanged', ...(next !== undefined ? { value: next } : {}) };
    const nextAccount = { ...account };
    if (next === undefined) {
        delete nextAccount[PROVIDER_STATE_KEY];
        const nextStamp = { ...rawStamp };
        delete nextStamp.providerState;
        nextAccount[CREDENTIAL_STAMP_KEY] = nextStamp;
    }
    else {
        nextAccount[PROVIDER_STATE_KEY] = next;
        const digest = providerStateDigest(codec, next);
        // A change confined to the part the codec does not bind to the
        // credential leaves the stamp exactly as it was.
        if (stamp.providerState !== digest)
            nextAccount[CREDENTIAL_STAMP_KEY] = { ...rawStamp, providerState: digest };
    }
    return {
        kind: 'changed',
        ...(next !== undefined ? { value: next } : {}),
        account: nextAccount,
    };
}
