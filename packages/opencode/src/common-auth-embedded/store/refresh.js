import { randomUUID } from 'node:crypto';
import { PoolOperationError } from './errors.js';
import { assertNotInsideHook, runInsideHook } from './hooks.js';
import { IDENTITY_CONTRADICTED_REASON_PREFIX, recordIdentityIn, } from './identity.js';
import { runOperation, withTransaction } from './mutate.js';
import { acceptProviderState, mergedProviderState } from './provider-state.js';
import { rotateIn } from './rows.js';
import { readRow, refusal, requireBound, rowLockSpec, } from './runtime.js';
import { rotationStamp, rotationStampUntrusted, rowLockKey, } from './schema.js';
import { applyTransition } from './torn.js';
function requireRefreshable(id, row) {
    if (!row)
        throw refusal('refresh', id, 'unknown-row', `no row ${id} in the pool`);
    if (row.invalid)
        throw refusal('refresh', id, 'invalid-row', `row ${id} is invalid`);
    if (row.type !== 'oauth' || row.credential?.type !== 'oauth')
        throw refusal('refresh', id, 'no-credential', `row ${id} holds no OAuth credential`);
    if (!row.enabled)
        throw refusal('refresh', id, 'row-disabled', `row ${id} is disabled`);
    return row;
}
function stampAhead(id) {
    return refusal('refresh', id, 'refresh-stamp-ahead', `row ${id}'s stored refresh stamp is ahead of the clock; a rotation now could not be stamped newer within the trust bound`, true);
}
/**
 * Refreshes one OAuth row. Locks are taken in the fixed order row lock,
 * provider-wide lock, extra locks, and the store locks only around the
 * capture and the commit; ownership of every held lease is asserted after
 * each wait, immediately before the provider call and before each write.
 */
export async function refreshRow(rt, id, provider, options = {}) {
    assertNotInsideHook('refresh');
    const { ctx } = rt;
    return runOperation(ctx, 'refresh', id, options.onFailure, async (locks, progress) => {
        const { row: seen } = await readRow(rt, 'refresh', id);
        requireRefreshable(id, seen);
        const early = await options.refuse?.(seen);
        if (early !== undefined)
            return { status: 'refused', rowId: id, reason: early };
        let key = rowLockKey(seen);
        let captured;
        for (let attempt = 0;; attempt++) {
            await locks.acquire(rowLockSpec(rt, { id, identity: key === id ? undefined : key }));
            await locks.acquire(options.providerLock ?? rt.providerLock);
            for (const extra of options.extraLocks ?? [])
                await locks.acquire(extra);
            // The capture may write the config once, to give a row its per-row
            // entry. That write is setup, not the rotation, so it is counted apart
            // and never makes a later failure report `after-first-write`.
            const captureProgress = { writes: 0 };
            const read = await withTransaction(ctx, locks, captureProgress, { operation: 'refresh', rowId: id }, async (tx) => {
                let row = requireRefreshable(id, tx.row(id));
                requireBound('refresh', row);
                if (!row.hasEntry) {
                    tx.setEntry(id, { credentialEpoch: 1, needsFirstReading: true });
                    await tx.commitConfig();
                    row = requireRefreshable(id, tx.row(id));
                }
                if (rowLockKey(row) !== key)
                    return { keyNow: rowLockKey(row) };
                const reason = await options.refuse?.(row);
                if (reason !== undefined)
                    return { refused: reason };
                return {
                    row,
                    credential: row.credential,
                    credentialEpoch: row.credentialEpoch,
                    identity: row.identity,
                };
            });
            if ('refused' in read)
                return { status: 'refused', rowId: id, reason: read.refused };
            if ('keyNow' in read) {
                await locks.releaseAll();
                if (attempt >= 1)
                    throw refusal('refresh', id, 'row-key-changed', `row ${id}'s wire identity changed twice while its lock was held`, true);
                key = read.keyNow;
                continue;
            }
            captured = read;
            break;
        }
        if (rotationStampUntrusted(captured.credential.lastRefreshedAt, ctx.now()))
            throw stampAhead(id);
        await ctx.hold?.('refresh-before-provider', id);
        await locks.assertAll();
        let result;
        try {
            result = await provider(captured.credential, captured.row);
        }
        catch (cause) {
            throw new PoolOperationError({
                operation: 'refresh',
                rowId: id,
                phase: 'before-first-write',
                retryable: true,
                kind: 'provider',
                message: 'the provider refresh failed',
                cause,
            });
        }
        if (typeof result?.refresh !== 'string' || !result.refresh.trim())
            throw refusal('refresh', id, 'provider', 'the provider returned no refresh token', true);
        const incoming = result.providerState === undefined
            ? undefined
            : acceptProviderState(ctx.providerState, 'refresh', id, result.providerState, 'the provider state the provider returned');
        const commit = await withTransaction(ctx, locks, progress, { operation: 'refresh', rowId: id }, async (tx) => {
            const current = tx.row(id);
            const entry = tx.entry(id);
            if (!current ||
                current.invalid ||
                !entry ||
                entry.credentialEpoch !== captured.credentialEpoch ||
                current.identity !== captured.identity)
                throw new PoolOperationError({
                    operation: 'refresh',
                    rowId: id,
                    phase: 'before-first-write',
                    retryable: true,
                    kind: 'attribution',
                    message: `row ${id} changed credential while its refresh was in flight; the rotation is discarded`,
                });
            // The epoch fence above does not see a credential another writer
            // swapped in under the same epoch; the stamp does, and committing
            // the rotation would stamp the swapped row as bound.
            requireBound('refresh', current);
            const reason = await options.refuse?.(current);
            if (reason !== undefined)
                return { refused: reason };
            const now = ctx.now();
            const prior = current.credential?.type === 'oauth'
                ? current.credential.lastRefreshedAt
                : undefined;
            if (rotationStampUntrusted(prior, now))
                throw stampAhead(id);
            const credential = {
                type: 'oauth',
                access: result.access,
                refresh: result.refresh,
                expires: result.expires,
            };
            const contradiction = current.identity !== undefined &&
                result.identity !== undefined &&
                current.identity !== result.identity
                ? {
                    expectedIdentity: current.identity,
                    returnedIdentity: result.identity,
                }
                : undefined;
            const transition = contradiction
                ? {
                    mark: randomUUID(),
                    enabled: false,
                    reason: `${IDENTITY_CONTRADICTED_REASON_PREFIX}${JSON.stringify(contradiction)}`,
                }
                : undefined;
            const learnt = current.identity === undefined && result.identity
                ? result.identity
                : undefined;
            // The rotated credential's stamp names a learnt identity before the
            // config records it, so a crash between the two writes is completed
            // forward rather than leaving an identity no stamp proves.
            const stored = await rotateIn(rt, tx, id, credential, {
                stamp: rotationStamp(prior, now),
                // Write state first with the disable marker, then config below.
                // Once the successor is durable, recovery projects the disable even
                // if config has not landed. A crash before the first rename still
                // loses an in-memory provider reply, as in any ordinary refresh.
                transition,
                identity: learnt,
                ...(incoming !== undefined
                    ? {
                        providerState: mergedProviderState(ctx.providerState, 'refresh', id, current.providerState, incoming),
                    }
                    : {}),
            });
            if (transition !== undefined) {
                applyTransition(tx, id, transition);
                await tx.commitConfig();
            }
            let identity = current.identity;
            if (learnt !== undefined) {
                recordIdentityIn(tx, id, learnt);
                identity = learnt;
                await tx.commitConfig();
            }
            return { stored, identity, contradiction, refused: undefined };
        });
        if (commit.refused !== undefined)
            return { status: 'refused', rowId: id, reason: commit.refused };
        if (commit.contradiction !== undefined)
            return {
                status: 'identity-contradicted',
                rowId: id,
                ...commit.contradiction,
                credential: commit.stored,
            };
        if (options.onPersisted) {
            try {
                const persisted = options.onPersisted;
                await runInsideHook('refresh', () => persisted(id, commit.stored));
            }
            catch (cause) {
                throw new PoolOperationError({
                    operation: 'refresh',
                    rowId: id,
                    phase: 'after-first-write',
                    retryable: false,
                    kind: 'after-persist-hook',
                    committed: commit.stored,
                    message: 'the after-persist hook threw; the rotation stays committed',
                    cause,
                });
            }
        }
        return {
            status: 'rotated',
            rowId: id,
            credential: commit.stored,
            ...(commit.identity !== undefined ? { identity: commit.identity } : {}),
        };
    });
}
