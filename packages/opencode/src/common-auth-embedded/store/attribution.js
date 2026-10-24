import { PoolOperationError } from './errors.js';
import { toFailure, withTransaction, } from './mutate.js';
import { LockStack } from './refresh-lock.js';
import { refusal, requireBound, unknownRow, } from './runtime.js';
import { isCredentialEpoch } from './schema.js';
export function assertQuotaEpoch(id, attribution) {
    if (!isCredentialEpoch(attribution?.credentialEpoch))
        throw refusal('pull', id, 'invalid-input', 'the credential epoch the reading was issued for must be a positive safe integer');
}
// Shared by preflight and the locked commit: accepting into memory must never
// hide a refusal the immediate writer would have returned to its caller.
export function assertQuotaRow(id, attribution, row) {
    if (!row)
        throw unknownRow('pull', id);
    if (row.invalid)
        throw refusal('pull', id, 'invalid-row', `row ${id} is invalid`);
    if (!row.credential)
        throw refusal('pull', id, 'no-credential', `row ${id} holds no credential`);
    requireBound('pull', row);
    if (row.torn ||
        !row.hasEntry ||
        row.credentialEpoch !== attribution.credentialEpoch ||
        row.identity !== attribution.identity)
        throw new PoolOperationError({
            operation: 'pull',
            rowId: id,
            phase: 'pull',
            retryable: true,
            kind: 'attribution',
            message: `quota for ${id} was issued for a credential the row no longer holds`,
        });
}
export function mergedQuota(ctx, id, stored, observation) {
    const merged = ctx.codec.merge(stored, observation);
    if (!ctx.codec.validate(merged))
        throw refusal('pull', id, 'invalid-quota', 'the quota codec rejected the merged map');
    return merged;
}
/**
 * Merges a quota observation into a row's stored map under the store locks,
 * after attribution passes. Needs no row lock, so it is permitted from
 * inside hooks. Clears needs-first-reading on success.
 */
export async function recordQuota(rt, id, attribution, observation) {
    const { ctx } = rt;
    const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv);
    const progress = { writes: 0 };
    try {
        assertQuotaEpoch(id, attribution);
        await withTransaction(ctx, locks, progress, { operation: 'pull', rowId: id }, async (tx) => {
            tx.assertNotStaged(id);
            const row = tx.row(id);
            // A reading belongs to one (epoch, identity, credential). A row
            // holding no credential, or torn between the writes of a replace,
            // has no such triple on disk, so no reading is recorded for it.
            assertQuotaRow(id, attribution, row);
            const entry = tx.entry(id);
            if (!entry)
                throw unknownRow('pull', id);
            const merged = mergedQuota(ctx, id, entry.quota, observation);
            tx.setEntry(id, { ...entry, quota: merged, needsFirstReading: false });
            await tx.commitConfig();
        }, 
        // Recording a reading never completes a torn row: the fence above
        // refuses it, and the row's own next write completes it.
        { completeTorn: false });
    }
    catch (error) {
        throw toFailure(error, 'pull', id, progress);
    }
    finally {
        await locks.releaseAll();
    }
}
