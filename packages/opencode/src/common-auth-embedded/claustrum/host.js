import { ClaustrumCredentialError } from '@cortexkit/claustrum-client';
import { ClaustrumUnreachableError, classifyVaultFailure, } from './availability.js';
export const VAULT_HOST_STATUS = 'Served by Thalamus';
export const VAULT_HOST_CONNECT_REFUSAL = "This host gets its vault accounts from Thalamus, so it can't connect to the vault itself.";
// Object identity prevents a native client from carrying the host's empty token argument.
const hostClients = new WeakSet();
export function isVaultHostClient(client) {
    return hostClients.has(client);
}
/** The spawn marker, not a global installed by another plugin, selects authority. */
export function hasVaultHost() {
    return process.env.CORTEXKIT_VAULT_HOST === 'thalamus';
}
function hostError(error) {
    if (typeof error !== 'object' || error === null)
        return error;
    const value = error;
    if (typeof value.code === 'string' &&
        (value.class === 'transient' ||
            value.class === 'permanent' ||
            value.class === 'auth_required' ||
            value.class === 'context_overflow') &&
        (value.action === 'gone' ||
            value.action === 'reauth' ||
            value.action === 'retry' ||
            value.action === 'reduce_and_retry'))
        return new ClaustrumCredentialError(value.code, value.class, value.action);
    if (value.name === 'ClaustrumUnreachableError' ||
        (typeof value.code === 'string' &&
            classifyVaultFailure(Object.assign(new Error(), { code: value.code })) ===
                'unreachable'))
        return new ClaustrumUnreachableError(value.reason === 'host-accessor-missing' ||
            value.reason === 'host-accessor-failed'
            ? value.reason
            : undefined);
    return error;
}
function call(operation) {
    try {
        return operation();
    }
    catch (error) {
        throw hostError(error);
    }
}
async function request(operation) {
    try {
        return await operation();
    }
    catch (error) {
        throw hostError(error);
    }
}
/** Normalize only the host boundary; native clients keep their strict error identity. */
function wrapHostClient(client) {
    const watchScoped = client.watchScoped?.bind(client);
    const reportUsageScoped = client.reportUsageScoped?.bind(client);
    return {
        listScoped: (...args) => request(() => client.listScoped(...args)),
        getScoped: (...args) => request(() => client.getScoped(...args)),
        reportAuthFailureScoped: (...args) => request(() => client.reportAuthFailureScoped(...args)),
        close: () => call(() => client.close()),
        ...(watchScoped && {
            watchScoped: (...args) => {
                const watch = call(() => watchScoped(...args));
                return {
                    stop: () => call(() => watch.stop()),
                    closed: request(async () => {
                        const end = await watch.closed;
                        return end.kind === 'refused' || end.kind === 'transport_lost'
                            ? { ...end, error: hostError(end.error) }
                            : end;
                    }),
                };
            },
        }),
        ...(reportUsageScoped && {
            reportUsageScoped: (...args) => request(() => reportUsageScoped(...args)),
        }),
        ...(client.insula && {
            insula: wrapInsula(client.insula),
        }),
    };
}
function wrapInsula(transport) {
    const watchUsage = transport.watchUsage?.bind(transport);
    return {
        connectionFile: transport.connectionFile,
        getUsage: () => request(() => transport.getUsage()),
        ...(watchUsage && {
            watchUsage: (...args) => {
                const watch = call(() => watchUsage(...args));
                return {
                    stop: () => call(() => watch.stop()),
                    closed: request(() => watch.closed),
                };
            },
        }),
    };
}
/** Read at connect time so a bridge installed after the auth plugin can recover. */
export function connectVaultHost(pluginId) {
    if (!hasVaultHost() || !pluginId)
        throw new ClaustrumUnreachableError();
    try {
        const accessor = globalThis[Symbol.for('cortexkit.vault')];
        if (typeof accessor === 'function') {
            const client = wrapHostClient(accessor(pluginId));
            hostClients.add(client);
            return client;
        }
    }
    catch {
        throw new ClaustrumUnreachableError('host-accessor-failed');
    }
    throw new ClaustrumUnreachableError('host-accessor-missing');
}
