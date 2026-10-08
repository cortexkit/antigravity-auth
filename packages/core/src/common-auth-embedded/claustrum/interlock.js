function matches(entry, credentialId, accountIdentity) {
    if (entry.accountIdentity !== undefined && accountIdentity !== undefined)
        return entry.accountIdentity === accountIdentity;
    return entry.credentialId === credentialId;
}
export function isDeclined(entries, credentialId, accountIdentity) {
    return entries.some((entry) => matches(entry, credentialId, accountIdentity));
}
export function declineAccount(entries, credentialId, accountIdentity) {
    const entry = {
        credentialId,
        ...(accountIdentity !== undefined && { accountIdentity }),
    };
    return [
        ...entries.filter((existing) => existing.credentialId !== credentialId ||
            existing.accountIdentity !== accountIdentity),
        entry,
    ];
}
/**
 * Lift every entry that declines a row: the row's credential ids (the
 * representative and its aliases) under the row's account. An entry for a
 * different known account is left alone even when it names one of these
 * credential ids, so accepting a replacement never re-enables the account the
 * user declined.
 */
export function acceptAccount(entries, credentialIds, accountIdentity) {
    return entries.filter((entry) => !credentialIds.some((id) => matches(entry, id, accountIdentity)));
}
