import type { ClaustrumScopedClient } from './custody.js';
export declare const VAULT_HOST_STATUS = "Served by Thalamus";
export declare const VAULT_HOST_CONNECT_REFUSAL = "This host gets its vault accounts from Thalamus, so it can't connect to the vault itself.";
export declare function isVaultHostClient(client: ClaustrumScopedClient): boolean;
/** The spawn marker, not a global installed by another plugin, selects authority. */
export declare function hasVaultHost(): boolean;
/** Read at connect time so a bridge installed after the auth plugin can recover. */
export declare function connectVaultHost(pluginId?: string): ClaustrumScopedClient;
