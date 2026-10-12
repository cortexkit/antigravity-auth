import type { PoolRow } from './schema.js';
/**
 * What the identity rules edit: a transaction, or a config being completed
 * in memory.
 */
export interface RowEditor {
    rows(): PoolRow[];
    rosterRow(id: string): Record<string, unknown> | undefined;
    entry(id: string): Record<string, unknown> | undefined;
    setEntry(id: string, entry: Record<string, unknown>): void;
}
/** Prefix of a refresh quarantine reason, followed by JSON of the expected and returned identities. */
export declare const IDENTITY_CONTRADICTED_REASON_PREFIX = "identity-contradicted: ";
/** The reason recorded on a row disabled because an earlier row is the same account. */
export declare const DUPLICATE_IDENTITY_REASON = "duplicate-identity";
/**
 * Enabled OAuth rows holding a credential whose wire identity is not yet
 * known. API-key rows and disabled rows never count.
 */
export declare function countUnknownIdentityRows(rows: readonly PoolRow[]): number;
/**
 * Marks a row disabled with a reason: `enabled: false` in the roster row,
 * which older readers honour, and the reason in the per-row entry. A row
 * without an entry gets one at epoch 1. Nothing is ever deleted.
 */
export declare function disableIn(tx: RowEditor, id: string, reason: string): void;
/**
 * Marks a row enabled: `enabled: true` in the roster row and no
 * `disabledReason` in its entry. A row without an entry is not given one.
 */
export declare function enableIn(tx: RowEditor, id: string): void;
/**
 * Two enabled OAuth rows with one wire identity are the same account: the
 * earlier row in roster order stays enabled and every later one is disabled
 * with a reason. Returns the ids it disabled.
 */
export declare function disableIdentityDuplicates(tx: RowEditor, identity: string): string[];
/** Records a row's wire identity in its roster row, then applies dedupe. */
export declare function recordIdentityIn(tx: RowEditor, id: string, identity: string): string[];
