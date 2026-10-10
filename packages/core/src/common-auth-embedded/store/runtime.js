import { PoolOperationError } from './errors.js';
import { notReadyError, readPool, } from './mutate.js';
import { assertNotReserved } from './reserved.js';
import { CREDENTIAL_STAMP_KEY, entryIn, isRecord, rowLockKey, } from './schema.js';
/**
 * The row lock's (name, path): keyed by the row's recorded wire identity when
 * known, else its local id, beside the state file. The key is prefixed and
 * URL-encoded so it can never name a store lock or leave the directory.
 */
export function rowLockSpec(rt, row) {
    return {
        ...rt.rowLockOptions,
        name: `row-${encodeURIComponent(rowLockKey(row))}`,
        path: rt.ctx.statePath,
    };
}
/** An unlocked read that must find a ready pool holding the row. */
export async function readRow(rt, operation, id) {
    const result = await readPool(rt.ctx);
    if (result.status !== 'ready')
        throw notReadyError(result, operation, id);
    const row = result.rows.find((candidate) => candidate.id === id);
    const entry = entryIn(result.config, id);
    const accounts = result.state.accounts;
    const account = isRecord(accounts) && Object.hasOwn(accounts, id) ? accounts[id] : undefined;
    const stamp = isRecord(account) ? account[CREDENTIAL_STAMP_KEY] : undefined;
    if (row &&
        !['enable', 'disable'].includes(operation) &&
        entry &&
        Object.hasOwn(entry, 'staged'))
        assertNotReserved(operation, id, entry.staged);
    if (!row && isRecord(stamp) && Object.hasOwn(stamp, 'staged'))
        assertNotReserved(operation, id, stamp.staged);
    if (!row)
        throw unknownRow(operation, id);
    return { result, row };
}
export function unknownRow(operation, id) {
    return new PoolOperationError({
        operation,
        rowId: id,
        phase: operation === 'pull' ? 'pull' : 'before-first-write',
        retryable: false,
        kind: 'unknown-row',
        message: `no row ${id} in the pool`,
    });
}
/**
 * Refuses a row the store was told to distrust: opened with
 * `requireCredentialStamps`, a row whose credential stamp is not bound loads
 * `unbound` (see `PoolRow.unbound`). Called on every locked read of the row
 * an operation acts on, before it calls a provider or writes, so a credential
 * another writer swapped in while the operation waited is refused too.
 */
export function requireBound(operation, row) {
    if (row.unbound)
        throw refusal(operation, row.id, 'unbound-credential', `row ${row.id}'s credential is not the one this store stamped for it (stamp ${row.stamp}); replace it with fresh material`);
}
export function refusal(operation, id, kind, message, retryable = false) {
    return new PoolOperationError({
        operation,
        rowId: id,
        phase: operation === 'pull' ? 'pull' : 'before-first-write',
        retryable,
        kind,
        message,
    });
}
