/**
 * Prefix of every placeholder secret. No provider issues tokens of this
 * shape, so a placeholder that escaped to the wire is refused by the
 * provider and recognisable in any log.
 */
export const PLACEHOLDER_PREFIX = 'common-auth-placeholder';
/** How long a placeholder claims to be valid; refresh simply issues another. */
export const PLACEHOLDER_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** Metadata key marking a host credential as a placeholder. */
export const PLACEHOLDER_METADATA_KEY = 'commonAuthPlaceholder';
/** The non-routable secret the host holds for an integration. */
export function placeholderSecret(integrationID) {
    return `${PLACEHOLDER_PREFIX}.${integrationID}`;
}
/**
 * The credential the host stores for an integration whose real accounts live
 * in the plugin's pool. It keeps the provider catalogued and usable in the
 * host, and carries nothing that works against the provider.
 */
export function placeholderCredential(input) {
    const secret = placeholderSecret(input.integrationID);
    return {
        type: 'oauth',
        methodID: input.methodID,
        access: secret,
        refresh: secret,
        expires: input.now + PLACEHOLDER_LIFETIME_MS,
        metadata: { [PLACEHOLDER_METADATA_KEY]: true },
    };
}
/** Whether a host credential is a placeholder (for any integration, or the one named). */
export function isPlaceholderCredential(value, integrationID) {
    if (value?.type !== 'oauth')
        return false;
    const expected = integrationID === undefined ? undefined : placeholderSecret(integrationID);
    const matches = (secret) => expected === undefined
        ? secret.startsWith(`${PLACEHOLDER_PREFIX}.`)
        : secret === expected;
    return matches(value.access) && matches(value.refresh);
}
/**
 * Shown by `opencode auth login` when the vault method starts. The host has no
 * page to open for this method, so the text only says what happens instead.
 */
export const VAULT_ACTIVATION_INSTRUCTIONS = 'No browser sign-in: this connects the plugin to the accounts in its vault.';
/**
 * Registers the plugin's own login methods with the host so that a login lands
 * in the plugin's pool and the host keeps only a placeholder credential.
 *
 * With `vault`, one more method lets a host whose accounts all live in a vault
 * activate the plugin: it calls `activate`, writes nothing to the pool and
 * hands the host the same placeholder under its own method ID.
 *
 * Host-driven refresh never reaches the pool: it renews only this integration's
 * placeholder and refuses every other credential without replacing it. Plugins
 * must register under their own method IDs; a plugin importing an existing
 * host login should read it through `ctx.integration.connection` instead.
 */
export async function registerOpenCode2AuthMethods(ctx, options) {
    const now = options.now ?? Date.now;
    const { integrationID } = options;
    const placeholderFor = (methodID) => placeholderCredential({ integrationID, methodID, now: now() });
    const store = async (result, methodID) => {
        await options.onLogin(result, { integrationID, methodID });
        return placeholderFor(methodID);
    };
    const authorizeWith = (login) => async (answer) => {
        const methodID = login.method.id;
        const pending = await login.authorize(answer);
        const common = {
            url: pending.url,
            instructions: pending.instructions,
            ...(pending.expiresAt === undefined
                ? {}
                : { expiresAt: pending.expiresAt }),
        };
        if (pending.mode === 'auto') {
            return {
                ...common,
                mode: 'auto',
                callback: pending.callback.then((result) => store(result, methodID)),
            };
        }
        const callback = pending.callback;
        return {
            ...common,
            mode: 'code',
            callback: async (code) => store(await callback(code), methodID),
        };
    };
    return ctx.integration.transform((editor) => {
        const label = options.label === undefined ? {} : { label: () => options.label };
        for (const login of options.methods) {
            editor.method.update({
                integrationID,
                method: login.method,
                authorize: authorizeWith(login),
                refresh: async (credential) => {
                    if (!isPlaceholderCredential(credential, integrationID)) {
                        throw new Error("This login method refreshes only its pool placeholder; sign in again with the plugin's login method.");
                    }
                    return placeholderFor(credential.methodID);
                },
                ...label,
            });
        }
        const vault = options.vault;
        if (vault === undefined)
            return;
        const methodID = vault.method.id;
        editor.method.update({
            integrationID,
            method: vault.method,
            // OpenCode 2 has no login method kind that needs no user step: OAuth
            // expects a page, a key method a typed secret, a command method a
            // program. An automatic OAuth authorization with an empty `url` fits:
            // on 2.0.22 the CLI's and the TUI's browser openers refuse anything but
            // an http(s) URL, and the host stores what `callback` resolves to as
            // soon as it settles, so the login completes with no browser.
            authorize: async () => ({
                url: '',
                instructions: vault.instructions ?? VAULT_ACTIVATION_INSTRUCTIONS,
                mode: 'auto',
                // Activation runs in the callback, not before returning, so a refusal
                // marks the host's login attempt failed with the plugin's own message,
                // which the host shows as is.
                callback: Promise.resolve()
                    .then(() => vault.activate({ integrationID, methodID }))
                    .then(() => placeholderFor(methodID)),
            }),
            // Nothing to renew in the vault: only this method's own placeholder is
            // reissued, and anything else must be signed in again.
            refresh: async (credential) => {
                if (!isPlaceholderCredential(credential, integrationID) ||
                    credential.methodID !== methodID) {
                    throw new Error("This login method refreshes only its vault placeholder; choose the plugin's vault login method again.");
                }
                return placeholderFor(methodID);
            },
            ...label,
        });
    });
}
