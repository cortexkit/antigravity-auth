/**
 * The host's own auth slot (OpenCode's stored login for the provider, Pi's
 * equivalent) must hold something, or the host drops the provider. Under
 * custody it holds this placeholder: an OAuth-shaped value that is never a
 * credential. Its empty access token also makes the vault's sealer refuse it,
 * should it ever be offered for import.
 */
export declare const CUSTODY_PLACEHOLDER_PREFIX = "claustrum-tombstone:v1:";
export declare function custodyPlaceholderKey(provider: string): string;
export declare function custodyPlaceholder(provider: string): {
    type: 'oauth';
    access: '';
    refresh: string;
    expires: 0;
};
export declare function isCustodyPlaceholderValue(value: unknown): value is string;
export declare function isCustodyPlaceholder(auth: unknown, provider: string): boolean;
/** What the host slot holds: the custody placeholder, a real login, or nothing usable. */
export type HostSlotContent = 'placeholder' | 'login' | 'empty';
export declare function classifyHostSlot(auth: unknown, provider: string): HostSlotContent;
/**
 * Check the host slot against the plugin's mode before serving anything.
 *
 * - Custody mode with a real login in the slot fails closed: someone signed in
 *   through the host while the vault owns the accounts, and serving either the
 *   login or the vault would silently pick one. The plugin surfaces the error
 *   and the user chooses (leave custody, or remove the login).
 * - Local mode with the placeholder in the slot also fails: there is no local
 *   credential to serve, and the user has to sign in.
 *
 * Returns the slot content when the combination is consistent.
 */
export declare function assertHostSlotMatchesMode(input: {
    mode: 'custody' | 'local';
    auth: unknown;
    provider: string;
}): HostSlotContent;
/** Refuse to run a local token refresh with the placeholder as the refresh token. */
export declare function assertNotCustodyPlaceholder(refreshToken: unknown, provider: string): void;
