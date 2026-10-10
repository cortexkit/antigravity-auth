import { recordQuota } from './attribution.js';
import { initializePool, readPool, } from './mutate.js';
import { updateProviderStateRow, } from './provider-state.js';
import { publication, publishRoster, } from './publication.js';
import { PullScheduler } from './pull.js';
import { refreshRow, } from './refresh.js';
import { POOL_LOCK_DEFAULTS, } from './refresh-lock.js';
import { addRow, disableRow, enableRow, recordRowIdentity, removeRow, reorderRows, replaceRow, rotateRow, } from './rows.js';
import { POOL_SCHEMA_VERSION, } from './schema.js';
import { readPoolSettings, updatePoolSettings, } from './settings.js';
/**
 * Process-wide memory per config file: ids whose per-row entry a library
 * write dropped (not reused in this process), and rows a load-time pull
 * already fired for.
 */
const processMemory = new Map();
function memoryFor(configPath) {
    let memory = processMemory.get(configPath);
    if (!memory) {
        memory = { removedIds: new Set(), firedAtLoad: new Set() };
        processMemory.set(configPath, memory);
    }
    return memory;
}
function toLoad(result) {
    if (result.status === 'ready')
        return {
            status: 'ready',
            schemaVersion: POOL_SCHEMA_VERSION,
            rows: result.rows,
        };
    if (result.status === 'pending-migration')
        return {
            status: 'pending-migration',
            roster: Array.isArray(result.config.accounts)
                ? result.config.accounts
                : [],
        };
    return result;
}
export function openPoolStore(options) {
    const memory = memoryFor(options.configPath);
    const lockDefaults = {
        ...POOL_LOCK_DEFAULTS,
        ...options.lockOptions,
    };
    const ctx = {
        provider: options.provider,
        configPath: options.configPath,
        statePath: options.statePath,
        codec: options.quota,
        ...(options.providerState ? { providerState: options.providerState } : {}),
        now: options.now ?? Date.now,
        storeLocks: options.storeLocks ?? [
            { name: 'save', path: options.configPath },
            { name: 'save', path: options.statePath },
        ],
        lockDefaults,
        lockEnv: {
            now: options.now ?? Date.now,
            ...(options.onLockEvent ? { onLockEvent: options.onLockEvent } : {}),
            ...(options.onLockStep ? { onLockStep: options.onLockStep } : {}),
        },
        removedIds: memory.removedIds,
        requireCredentialStamps: options.requireCredentialStamps === true,
        requireRemovedFingerprint: options.requireRemovedFingerprint === true,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.onStep ? { onStep: options.onStep } : {}),
        ...(options.hold ? { hold: options.hold } : {}),
    };
    const pulls = new PullScheduler(() => rt, options.pull, options.onPullFailure, memory.firedAtLoad, options.logger);
    const rt = {
        ctx,
        providerLock: options.providerLock ?? {
            name: `provider-${encodeURIComponent(options.provider)}`,
            path: options.statePath,
        },
        rowLockOptions: options.rowLockOptions ?? {},
        firePull: (id, reason) => pulls.fire(id, reason),
    };
    return {
        async load() {
            const result = await readPool(ctx);
            if (result.status === 'ready') {
                // A torn row is no candidate, but its pull is fired too: the pull
                // completes the row on disk before reading it, so an interrupted
                // replace of an OAuth row heals at the next load.
                for (const row of result.rows)
                    if ((row.candidate || (row.torn && row.enabled)) &&
                        row.type === 'oauth' &&
                        row.needsFirstReading)
                        pulls.fire(row.id, 'load');
            }
            return toLoad(result);
        },
        async read() {
            return toLoad(await readPool(ctx));
        },
        async initialize(input = {}) {
            return { status: await initializePool(ctx, input.dropKeys ?? []) };
        },
        add: (input, callOptions) => addRow(rt, input, callOptions),
        publishRoster: (plan, callOptions) => publishRoster(rt, plan, callOptions),
        publication: (operationId) => publication(rt, operationId),
        replace: (id, credential, input, callOptions) => replaceRow(rt, id, credential, input, callOptions),
        rotate: (id, credential, input, callOptions) => rotateRow(rt, id, credential, input, callOptions),
        updateProviderState: (id, fence, mutator, callOptions) => updateProviderStateRow(rt, id, fence, mutator, callOptions),
        disable: (id, reason, callOptions) => disableRow(rt, id, reason, callOptions),
        enable: (id, callOptions) => enableRow(rt, id, callOptions),
        remove: (id, callOptions) => removeRow(rt, id, callOptions),
        reorder: (ids, callOptions) => reorderRows(rt, ids, callOptions),
        readSettings: () => readPoolSettings(rt),
        updateSettings: (mutator, callOptions) => updatePoolSettings(rt, mutator, callOptions),
        recordIdentity: (id, identity, attribution, callOptions) => recordRowIdentity(rt, id, identity, attribution, callOptions),
        refresh: (id, provider, callOptions) => refreshRow(rt, id, provider, callOptions),
        recordQuota: (id, attribution, observation) => recordQuota(rt, id, attribution, observation),
        requestReading: (id) => pulls.fire(id, 'admission'),
        pullsSettled: () => pulls.settled(),
    };
}
