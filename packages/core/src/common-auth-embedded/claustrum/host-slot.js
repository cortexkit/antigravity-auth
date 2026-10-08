import { ClaustrumConsumerError } from './errors.js';
/**
 * The host's own auth slot (OpenCode's stored login for the provider, Pi's
 * equivalent) must hold something, or the host drops the provider. Under
 * custody it holds this placeholder: an OAuth-shaped value that is never a
 * credential. Its empty access token also makes the vault's sealer refuse it,
 * should it ever be offered for import.
 */
export const CUSTODY_PLACEHOLDER_PREFIX = 'claustrum-tombstone:v1:';
export function custodyPlaceholderKey(provider) {
    return `${CUSTODY_PLACEHOLDER_PREFIX}${provider}`;
}
export function custodyPlaceholder(provider) {
    return {
        type: 'oauth',
        access: '',
        refresh: custodyPlaceholderKey(provider),
        expires: 0,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isCustodyPlaceholderValue(value) {
    return (typeof value === 'string' && value.startsWith(CUSTODY_PLACEHOLDER_PREFIX));
}
export function isCustodyPlaceholder(auth, provider) {
    if (!isRecord(auth) || auth.type !== 'oauth')
        return false;
    return auth.refresh === custodyPlaceholderKey(provider);
}
export function classifyHostSlot(auth, provider) {
    if (isCustodyPlaceholder(auth, provider))
        return 'placeholder';
    if (isRecord(auth) &&
        auth.type === 'oauth' &&
        typeof auth.refresh === 'string' &&
        auth.refresh.length > 0 &&
        !isCustodyPlaceholderValue(auth.refresh))
        return 'login';
    if (isRecord(auth) &&
        auth.type === 'api' &&
        typeof auth.key === 'string' &&
        auth.key.length > 0)
        return 'login';
    return 'empty';
}
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
export function assertHostSlotMatchesMode(input) {
    const content = classifyHostSlot(input.auth, input.provider);
    if (input.mode === 'custody' && content === 'login')
        throw new ClaustrumConsumerError('host-slot-login', `${input.provider} has a host login while its accounts are vault-custodied; refusing to serve until one is removed`);
    if (input.mode === 'local' && content === 'placeholder')
        throw new ClaustrumConsumerError('host-slot-placeholder', `${input.provider} host slot holds the vault placeholder; sign in to use local accounts`);
    return content;
}
/** Refuse to run a local token refresh with the placeholder as the refresh token. */
export function assertNotCustodyPlaceholder(refreshToken, provider) {
    if (isCustodyPlaceholderValue(refreshToken))
        throw new ClaustrumConsumerError('placeholder-refresh', `${provider} credentials are vault-custodied; local token refresh is forbidden`);
}
