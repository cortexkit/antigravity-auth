/** Prefix of a refresh quarantine reason, followed by JSON of the expected and returned identities. */
export const IDENTITY_CONTRADICTED_REASON_PREFIX = 'identity-contradicted: ';
/** The reason recorded on a row disabled because an earlier row is the same account. */
export const DUPLICATE_IDENTITY_REASON = 'duplicate-identity';
/**
 * Enabled OAuth rows holding a credential whose wire identity is not yet
 * known. API-key rows and disabled rows never count.
 */
export function countUnknownIdentityRows(rows) {
    return rows.filter((row) => row.invalid === undefined &&
        row.type === 'oauth' &&
        row.enabled &&
        row.credential !== undefined &&
        row.identity === undefined).length;
}
/**
 * Marks a row disabled with a reason: `enabled: false` in the roster row,
 * which older readers honour, and the reason in the per-row entry. A row
 * without an entry gets one at epoch 1. Nothing is ever deleted.
 */
export function disableIn(tx, id, reason) {
    const raw = tx.rosterRow(id);
    if (!raw)
        return;
    raw.enabled = false;
    const entry = tx.entry(id) ?? { credentialEpoch: 1, needsFirstReading: true };
    // A routine disable must not erase the evidence needed to refuse enable.
    const quarantined = typeof entry.disabledReason === 'string' &&
        entry.disabledReason.startsWith(IDENTITY_CONTRADICTED_REASON_PREFIX);
    tx.setEntry(id, {
        ...entry,
        disabledReason: quarantined ? entry.disabledReason : reason,
    });
}
/**
 * Marks a row enabled: `enabled: true` in the roster row and no
 * `disabledReason` in its entry. A row without an entry is not given one.
 */
export function enableIn(tx, id) {
    const raw = tx.rosterRow(id);
    if (!raw)
        return;
    raw.enabled = true;
    const entry = tx.entry(id);
    if (entry && 'disabledReason' in entry) {
        const next = { ...entry };
        delete next.disabledReason;
        tx.setEntry(id, next);
    }
}
/**
 * Two enabled OAuth rows with one wire identity are the same account: the
 * earlier row in roster order stays enabled and every later one is disabled
 * with a reason. Returns the ids it disabled.
 */
export function disableIdentityDuplicates(tx, identity) {
    const holders = tx
        .rows()
        .filter((row) => row.invalid === undefined &&
        row.type === 'oauth' &&
        row.enabled &&
        row.identity === identity);
    const disabled = [];
    for (const row of holders.slice(1)) {
        disableIn(tx, row.id, DUPLICATE_IDENTITY_REASON);
        disabled.push(row.id);
    }
    return disabled;
}
/** Records a row's wire identity in its roster row, then applies dedupe. */
export function recordIdentityIn(tx, id, identity) {
    const raw = tx.rosterRow(id);
    if (!raw)
        return [];
    raw.accountId = identity;
    return disableIdentityDuplicates(tx, identity);
}
