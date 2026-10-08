export interface StickyPin {
    accountId: string;
    /** The row's recorded wire identity when the pin was made, if known. */
    wireIdentity?: string;
    /** The request size recorded with the pin; weighs pending bytes. */
    inputBytes?: number;
    /** The projection time the placement was judged on. */
    quotaCheckedAt?: number;
}
/**
 * A pin survives while its row id is in `validIds` and the row still holds
 * the account it was placed on. Only two known, differing identities prove
 * the account changed: an unknown identity on either side keeps the pin,
 * because re-placing a session on missing evidence throws its cache away.
 */
export declare function isPinValid(pin: StickyPin, validIds: ReadonlySet<string>, currentIdentity: string | undefined): boolean;
/**
 * Sums the request bytes of every other session's pin per row, as openai-auth
 * does. A pin counts only while it was judged on the row's current
 * projection time, so a fresh reading resets the row's pending load.
 */
export declare function pendingBytesForPins(pins: Iterable<readonly [sessionKey: string, pin: StickyPin]>, quotaCheckedAtById: ReadonlyMap<string, number | undefined>, excludedSessionKey?: string): Map<string, number>;
