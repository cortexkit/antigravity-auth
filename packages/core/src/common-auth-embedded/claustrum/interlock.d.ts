/**
 * The declined-account interlock: the user's "do not use this vault account",
 * kept on the consumer side because the vault has no notion of it.
 *
 * A decline follows the provider account, not the vault record: an entry made
 * while the account was known matches any credential id or alias that logs
 * into that same account, so relabelling, adding an alias or removing and
 * re-adding the account never lifts it. A credential id that now logs into a
 * different known account does not match, because that account has its own
 * policy. While either side's account is unknown the entry falls back to the
 * credential id, so an adapter that makes no identity claim cannot slip past
 * it. Never keyed on the record version, so a token refresh cannot lift it.
 */
export interface DeclinedAccount {
    readonly credentialId: string;
    readonly accountIdentity?: string;
}
export declare function isDeclined(entries: readonly DeclinedAccount[], credentialId: string, accountIdentity?: string): boolean;
export declare function declineAccount(entries: readonly DeclinedAccount[], credentialId: string, accountIdentity?: string): DeclinedAccount[];
/**
 * Lift every entry that declines a row: the row's credential ids (the
 * representative and its aliases) under the row's account. An entry for a
 * different known account is left alone even when it names one of these
 * credential ids, so accepting a replacement never re-enables the account the
 * user declined.
 */
export declare function acceptAccount(entries: readonly DeclinedAccount[], credentialIds: readonly string[], accountIdentity?: string): DeclinedAccount[];
