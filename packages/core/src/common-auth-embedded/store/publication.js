import { assertNotInsideHook } from './hooks.js';
import { notReadyError, readPool, runOperation, withTransaction, } from './mutate.js';
import { assertBoundRowAttribution, protectIn, validateAttribution, } from './rows.js';
import { refusal, rowLockSpec } from './runtime.js';
import { CREDENTIAL_STAMP_KEY, canonicalDigest, fingerprintOf, idProblem, isCredentialEpoch, isRecord, POOL_KEY, PROVIDER_STATE_KEY, parseStamp, rosterOf, rowLockKey, } from './schema.js';
function receiptsIn(config) {
    const pool = config[POOL_KEY];
    return isRecord(pool) && isRecord(pool.publications) ? pool.publications : {};
}
function receiptIn(config, operationId) {
    const receipts = receiptsIn(config);
    if (!Object.hasOwn(receipts, operationId))
        return undefined;
    const raw = receipts[operationId];
    if (!isRecord(raw) ||
        raw.operationId !== operationId ||
        typeof raw.planDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.planDigest) ||
        !['committed', 'cleaned'].includes(String(raw.phase)) ||
        !Array.isArray(raw.removed) ||
        !Array.isArray(raw.finalized) ||
        raw.removed.some((ref) => !isRecord(ref) ||
            typeof ref.id !== 'string' ||
            !isCredentialEpoch(ref.credentialEpoch)) ||
        raw.finalized.some((ref) => !isRecord(ref) ||
            typeof ref.id !== 'string' ||
            !isCredentialEpoch(ref.credentialEpoch) ||
            typeof ref.reservation !== 'string' ||
            !ref.reservation ||
            typeof ref.enabled !== 'boolean'))
        throw refusal('publishRoster', operationId, 'invalid-input', 'the stored publication receipt is malformed');
    return structuredClone(raw);
}
export async function publication(rt, operationId) {
    const result = await readPool(rt.ctx);
    if (result.status !== 'ready')
        throw notReadyError(result, 'publishRoster', operationId);
    return receiptIn(result.config, operationId);
}
function validatePlan(rt, plan) {
    const fail = () => {
        throw refusal('publishRoster', plan?.operationId ?? '', 'invalid-input', 'the publication plan is invalid');
    };
    if (!isRecord(plan) ||
        typeof plan.operationId !== 'string' ||
        !plan.operationId ||
        !Array.isArray(plan.remove) ||
        !Array.isArray(plan.finalize) ||
        !Array.isArray(plan.order))
        fail();
    const ids = new Set();
    for (const ref of [...plan.remove, ...plan.finalize]) {
        if (!isRecord(ref) ||
            typeof ref.id !== 'string' ||
            idProblem(ref.id) ||
            ids.has(ref.id) ||
            !ref.attribution)
            fail();
        ids.add(ref.id);
        validateAttribution('publishRoster', ref.id, ref.attribution);
        if (ref.attribution.identity !== undefined &&
            (typeof ref.attribution.identity !== 'string' ||
                !ref.attribution.identity))
            fail();
    }
    for (const ref of plan.remove)
        if ((rt.ctx.requireRemovedFingerprint && !ref.fingerprint) ||
            (ref.fingerprint !== undefined && typeof ref.fingerprint !== 'string'))
            fail();
    for (const ref of plan.finalize)
        if (typeof ref.reservation !== 'string' ||
            !ref.reservation ||
            typeof ref.enabled !== 'boolean' ||
            (ref.enabled
                ? ref.disabledReason !== undefined
                : typeof ref.disabledReason !== 'string'))
            fail();
    if (plan.order.some((id) => typeof id !== 'string' || idProblem(id)) ||
        new Set(plan.order).size !== plan.order.length)
        fail();
}
function saveReceipt(tx, receipt) {
    tx.entries();
    const pool = tx.config[POOL_KEY];
    const receipts = { ...receiptsIn(tx.config) };
    Object.defineProperty(receipts, receipt.operationId, {
        value: receipt,
        enumerable: true,
        writable: true,
        configurable: true,
    });
    pool.publications = receipts;
    // Never forget which plan used an operation id or the actual row epochs it
    // changed: otherwise an old replay could publish again against another pool.
    delete pool.publicationOrder;
}
function publicationSurvivors(tx, plan, rows) {
    const rosterIds = new Set();
    for (const raw of rosterOf(tx.config)) {
        if (!isRecord(raw) || typeof raw.id !== 'string')
            continue;
        if (rosterIds.has(raw.id))
            throw refusal('publishRoster', plan.operationId, 'invalid-input', 'publication needs a roster of unique named rows');
        rosterIds.add(raw.id);
    }
    const removedIds = new Set(plan.remove.map((ref) => ref.id));
    const survivors = rows.filter((row) => row.invalid !== 'roster' && !removedIds.has(row.id));
    if (survivors.length !== plan.order.length ||
        plan.order.some((id) => !survivors.some((row) => row.id === id)) ||
        survivors.some((row) => !plan.order.includes(row.id)))
        throw refusal('publishRoster', plan.operationId, 'invalid-input', 'order must name exactly the surviving roster');
    return survivors;
}
async function cleanup(tx, receipt) {
    await tx.assertAll();
    for (const ref of receipt.removed) {
        const stamp = parseStamp(tx.stateAccount(ref.id)?.[CREDENTIAL_STAMP_KEY]);
        // A later add uses a later epoch. Cleanup never deletes that successor.
        if (stamp?.credentialEpoch === ref.credentialEpoch && !tx.rosterRow(ref.id))
            tx.dropStateAccount(ref.id);
    }
    for (const ref of receipt.finalized) {
        const account = tx.stateAccount(ref.id);
        const stamp = parseStamp(account?.[CREDENTIAL_STAMP_KEY]);
        if (account &&
            stamp?.credentialEpoch === ref.credentialEpoch &&
            stamp.staged?.reservation === ref.reservation) {
            const next = {
                ...account[CREDENTIAL_STAMP_KEY],
            };
            delete next.staged;
            tx.setStateAccount(ref.id, { ...account, [CREDENTIAL_STAMP_KEY]: next });
        }
    }
    await tx.commitState(undefined, { durable: true });
    const cleaned = { ...receipt, phase: 'cleaned' };
    saveReceipt(tx, cleaned);
    await tx.commitConfig({ durable: true });
    return cleaned;
}
export async function publishRoster(rt, plan, options = {}) {
    assertNotInsideHook('publishRoster');
    return runOperation(rt.ctx, 'publishRoster', plan?.operationId ?? '', options.onFailure, async (locks, progress) => {
        if (!isRecord(plan) ||
            typeof plan.operationId !== 'string' ||
            !plan.operationId)
            throw refusal('publishRoster', plan?.operationId ?? '', 'invalid-input', 'the publication needs an operation id');
        plan = structuredClone(plan);
        const planDigest = canonicalDigest(plan);
        const named = [
            ...(Array.isArray(plan.remove) ? plan.remove : []),
            ...(Array.isArray(plan.finalize) ? plan.finalize : []),
        ].filter((ref) => isRecord(ref) && typeof ref.id === 'string');
        for (let attempt = 0;; attempt++) {
            const seen = await readPool(rt.ctx);
            if (seen.status !== 'ready')
                throw notReadyError(seen, 'publishRoster', plan.operationId);
            const keys = new Map(named.map(({ id }) => [
                id,
                rowLockKey(seen.rows.find((row) => row.id === id) ?? { id }),
            ]));
            // All row keys precede the provider lock. A refresh owns just one row
            // before that lock, so it cannot wait for a second row this call holds.
            for (const key of [...new Set(keys.values())].sort())
                await locks.acquire(rowLockSpec(rt, { id: key }));
            await locks.acquire(options.providerLock ?? rt.providerLock);
            for (const extra of options.extraLocks ?? [])
                await locks.acquire(extra);
            const result = await withTransaction(rt.ctx, locks, progress, { operation: 'publishRoster', rowId: plan.operationId }, async (tx) => {
                const rows = tx.rows();
                if (named.some(({ id }) => rowLockKey(rows.find((row) => row.id === id) ?? { id }) !==
                    keys.get(id)))
                    return undefined;
                const prior = receiptIn(tx.config, plan.operationId);
                if (prior) {
                    if (prior.planDigest !== planDigest)
                        throw refusal('publishRoster', plan.operationId, 'publication-mismatch', 'the operation id belongs to a different publication plan');
                    if (prior.phase === 'cleaned')
                        return { outcome: 'already-cleaned', receipt: prior };
                    tx.markPublicationDecision();
                    await tx.syncConfig();
                    return { outcome: 'cleaned', receipt: await cleanup(tx, prior) };
                }
                validatePlan(rt, plan);
                const survivors = publicationSurvivors(tx, plan, rows);
                const removed = [];
                for (const ref of plan.remove) {
                    tx.assertNotStaged(ref.id);
                    const row = rows.find((row) => row.id === ref.id);
                    if (!row)
                        throw refusal('publishRoster', ref.id, 'attribution', 'the removed row no longer exists');
                    assertBoundRowAttribution(ref.id, row, ref.attribution, 'publishRoster');
                    if (!row.credential ||
                        (ref.fingerprint !== undefined &&
                            fingerprintOf(row.credential) !== ref.fingerprint))
                        throw refusal('publishRoster', ref.id, 'attribution', 'the removed secret no longer matches');
                    removed.push(row);
                }
                const finalized = [];
                for (const ref of plan.finalize) {
                    const row = rows.find((row) => row.id === ref.id);
                    const stamp = parseStamp(tx.stateAccount(ref.id)?.[CREDENTIAL_STAMP_KEY]);
                    if (!row ||
                        row.staged?.reservation !== ref.reservation ||
                        stamp?.staged?.reservation !== ref.reservation ||
                        row.enabled)
                        throw refusal('publishRoster', ref.id, 'row-staged', 'the finalized row is not disabled under this reservation');
                    const account = tx.stateAccount(ref.id);
                    const raw = tx.rosterRow(ref.id);
                    const storedProviderState = account?.[PROVIDER_STATE_KEY];
                    const fullProviderDigest = storedProviderState === undefined
                        ? undefined
                        : canonicalDigest(storedProviderState);
                    if (!stamp?.staged ||
                        stamp.staged.label !== raw?.label ||
                        stamp.staged.disabledReason !== row.disabledReason ||
                        stamp.staged.providerState !== fullProviderDigest)
                        throw refusal('publishRoster', ref.id, 'row-staged', 'the staged label, disabled reason or full provider state no longer matches its stamp');
                    assertBoundRowAttribution(ref.id, row, ref.attribution, 'publishRoster');
                    finalized.push(row);
                }
                const tornSurvivor = survivors.find((row) => row.torn);
                if (tornSurvivor)
                    throw refusal('publishRoster', plan.operationId, 'attribution', `Row ${tornSurvivor.id} has an interrupted write; complete it with a normal store operation before publishing.`, false);
                const identities = new Set();
                for (const row of survivors) {
                    const enabled = plan.finalize.find((ref) => ref.id === row.id)?.enabled ??
                        row.enabled;
                    if (!enabled ||
                        row.type !== 'oauth' ||
                        row.identity === undefined)
                        continue;
                    if (identities.has(row.identity))
                        throw refusal('publishRoster', row.id, 'invalid-input', 'the final enabled roster repeats a known identity');
                    identities.add(row.identity);
                }
                for (const row of survivors) {
                    if (row.identity !== undefined &&
                        row.fingerprint !== undefined &&
                        survivors.some((other) => other.id !== row.id &&
                            other.identity !== undefined &&
                            other.identity !== row.identity &&
                            other.fingerprint === row.fingerprint))
                        throw refusal('publishRoster', row.id, 'attribution', 'the resulting pool gives the same secret different known identities');
                }
                for (const row of finalized)
                    if (row.identity !== undefined &&
                        removed.some((old) => old.identity !== undefined &&
                            old.identity !== row.identity &&
                            old.fingerprint === row.fingerprint))
                        throw refusal('publishRoster', row.id, 'attribution', 'the staged secret belonged to a different known identity');
                await protectIn(tx, plan.operationId, options.protect);
                const receipt = {
                    operationId: plan.operationId,
                    planDigest,
                    phase: 'committed',
                    removed: removed.map((row) => ({
                        id: row.id,
                        credentialEpoch: row.credentialEpoch ?? 1,
                    })),
                    finalized: plan.finalize.map((ref, index) => ({
                        id: ref.id,
                        credentialEpoch: finalized[index]?.credentialEpoch ?? 1,
                        reservation: ref.reservation,
                        enabled: ref.enabled,
                    })),
                };
                for (const ref of plan.remove)
                    tx.dropRosterRows(ref.id);
                for (const ref of plan.finalize) {
                    const raw = tx.rosterRow(ref.id);
                    raw.enabled = ref.enabled;
                    const entry = { ...tx.entry(ref.id) };
                    delete entry.staged;
                    if (ref.enabled)
                        delete entry.disabledReason;
                    else
                        entry.disabledReason = ref.disabledReason;
                    tx.setEntry(ref.id, entry);
                }
                const preserved = tx
                    .roster()
                    .filter((raw) => !isRecord(raw) ||
                    typeof raw.id !== 'string' ||
                    rows.find((row) => row.id === raw.id)?.invalid === 'roster');
                tx.config.accounts = [
                    ...plan.order.map((id) => tx.rosterRow(id)),
                    ...preserved,
                ];
                saveReceipt(tx, receipt);
                // This durable rename is the irreversible roster decision. Everything
                // after it follows only the receipt, including after a process restart.
                await tx.syncState();
                await tx.commitConfig({ durable: true, publicationDecision: true });
                return { outcome: 'published', receipt: await cleanup(tx, receipt) };
            }, { completeTorn: false });
            if (result)
                return result;
            await locks.releaseAll();
            if (attempt >= 1)
                throw refusal('publishRoster', plan.operationId, 'row-key-changed', 'a named row changed lock key twice during publication', true);
        }
    });
}
