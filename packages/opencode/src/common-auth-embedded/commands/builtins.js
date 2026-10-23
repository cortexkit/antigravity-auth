// The four sections every plugin gets from the library: Accounts, Quota,
// Routing and Limits. They read the pool and the plugin's settings through
// the store and write only through store operations, so a menu action takes
// the same locks as any other writer of those files.
import { formatQuota, isQuotaMap, projectQuota, quotaWindowName, } from '../quota/index.js';
import { DEFAULT_FORMER_MAIN_ID, orderForPlacement, resolveRoutingMode, } from '../routing/index.js';
import { CommandError, projectFailure, } from './seam.js';
/** `disabledReason` recorded when the user disables an account from the menu. */
export const MENU_DISABLED_REASON = 'disabled from the command menu';
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value) {
    return isRecord(value) ? { ...value } : {};
}
/** The rows the menu can name: one per id, in roster order. */
function distinctRows(load) {
    if (load.status !== 'ready')
        return [];
    const seen = new Set();
    return load.rows.filter((row) => {
        if (seen.has(row.id))
            return false;
        seen.add(row.id);
        return true;
    });
}
function rowName(row, identity) {
    return row.label ?? identity ?? row.id;
}
function projected(row, scope) {
    return isQuotaMap(row.quota) ? projectQuota(row.quota, scope) : undefined;
}
/** Real plurals for counts in summaries: `1 account`, `3 accounts`. */
function count(n, noun) {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
/** The header every section's own actions are listed under. */
const ACTIONS_GROUP = 'Actions';
function loadProblem(load) {
    if (load.status === 'pending-migration')
        return 'The account pool has not been migrated yet.';
    if (load.status === 'error')
        return `The ${load.file} file cannot be read: ${load.reason}`;
    return undefined;
}
function addedText(name, result) {
    switch (result.outcome) {
        case 'added':
            return `Added ${name}.`;
        case 'added-disabled':
            return `Added ${name}, disabled: another enabled account has the same identity.`;
        case 'completed':
            return `Finished adding ${name}.`;
        case 'rotated':
            return `${name} was already in the pool; its credential was updated.`;
        case 'exists':
            return `${name} was already in the pool; its credential is unchanged.`;
    }
}
/**
 * What the user is told about a failed late login: the projected message,
 * never the exception's own text, which can quote the login's request.
 */
function failureMessage(error) {
    return projectFailure(error).text;
}
async function snapshot(options) {
    const { store } = options;
    const load = await store.read();
    const read = await store.readSettings();
    const vault = await options.routing?.vaultOrder?.();
    return {
        load,
        rows: distinctRows(load),
        settings: read.status === 'error' ? {} : read.settings,
        ...(vault ? { vault } : {}),
    };
}
function accountView(row, options) {
    const identity = options.accounts?.describeIdentity
        ? options.accounts.describeIdentity(row)
        : row.identity;
    // Copy only the fields the menu shows: the store row also carries its
    // credential and fingerprint, which must never reach a payload.
    const account = {
        id: row.id,
        ...(row.label !== undefined ? { label: row.label } : {}),
        enabled: row.enabled,
        type: row.type,
        ...(identity !== undefined ? { identity } : {}),
    };
    return { account, name: rowName(row, identity) };
}
function accountsSection(options, snap) {
    const { store, extraLocks } = options;
    const locks = extraLocks ? { extraLocks } : {};
    const ids = snap.rows.map((row) => row.id);
    const problem = loadProblem(snap.load);
    const enabledCount = snap.rows.filter((row) => row.enabled).length;
    const items = snap.rows.map((row, index) => {
        const { account, name } = accountView(row, options);
        // An Accounts row shows only the credential type, identity and any
        // disabled reason; the account's quota windows are shown in the Quota
        // section instead, so this row fits one line.
        const detail = [
            row.type === 'api' ? 'API key' : 'OAuth',
            ...(account.identity !== undefined ? [account.identity] : []),
            ...(!row.invalid && !row.enabled && row.disabledReason
                ? [`disabled: ${row.disabledReason}`]
                : []),
        ].join(' · ');
        const status = row.invalid
            ? 'invalid'
            : row.enabled
                ? 'enabled'
                : 'disabled';
        const actions = [];
        if (!row.invalid && row.enabled)
            actions.push({
                id: 'disable',
                label: 'Disable',
                run: async () => {
                    await store.disable(row.id, MENU_DISABLED_REASON, locks);
                    return `Disabled ${name}.`;
                },
            });
        if (!row.invalid && !row.enabled)
            actions.push({
                id: 'enable',
                label: 'Enable',
                run: async () => {
                    await store.enable(row.id, locks);
                    return `Enabled ${name}.`;
                },
            });
        if (ids.length > 1)
            actions.push({
                id: 'move',
                label: 'Move',
                knobs: [
                    {
                        kind: 'choice',
                        id: 'position',
                        label: 'Position',
                        choices: ids.map((_, at) => ({
                            value: String(at + 1),
                            label: String(at + 1),
                        })),
                        value: String(index + 1),
                    },
                ],
                run: async ({ values }) => {
                    const position = Number(values.position);
                    const order = ids.filter((id) => id !== row.id);
                    order.splice(position - 1, 0, row.id);
                    const result = await store.reorder(order, locks);
                    return result.outcome === 'unchanged'
                        ? `${name} is already at position ${position}.`
                        : `Moved ${name} to position ${position}.`;
                },
            });
        actions.push({
            id: 'remove',
            label: 'Remove',
            irreversible: true,
            confirm: `Remove ${name}? Its stored credential is deleted.`,
            run: async () => {
                await store.remove(row.id, {
                    ...locks,
                    ...(options.accounts?.protect
                        ? { protect: options.accounts.protect }
                        : {}),
                });
                return `Removed ${name}.`;
            },
        });
        return {
            id: row.id,
            label: name,
            detail,
            group: 'Accounts',
            status,
            account,
            actions,
        };
    });
    const login = options.accounts?.login;
    const actions = [];
    if (login && !problem)
        actions.push({
            id: 'add',
            label: login.label ?? 'Add account',
            group: ACTIONS_GROUP,
            knobs: login.knobs ?? [],
            run: async ({ values, invocation }) => {
                const outcome = await login.run(values, invocation);
                if (outcome.status === 'cancelled')
                    return { ok: false, text: outcome.message ?? 'Login cancelled.' };
                if (outcome.status === 'ready') {
                    const result = await store.add(outcome.account, locks);
                    return addedText(outcome.account.label ?? result.id, result);
                }
                // The login finishes after this call returns: add the account then,
                // and send the outcome to the invocation that started the login.
                void outcome.completion
                    .then(async (account) => {
                    if (!account) {
                        invocation.notify('Login cancelled.', 'warning');
                        return;
                    }
                    const result = await store.add(account, locks);
                    invocation.notify(addedText(account.label ?? result.id, result));
                }, (error) => {
                    invocation.notify(`Adding the account failed: ${failureMessage(error)}`, 'error');
                })
                    .catch((error) => {
                    invocation.notify(`Adding the account failed: ${failureMessage(error)}`, 'error');
                });
                return outcome.message;
            },
        });
    return {
        id: 'accounts',
        slot: 'accounts',
        title: 'Accounts',
        content: {
            lines: problem
                ? [problem]
                : [
                    snap.rows.length === 0
                        ? 'No accounts yet'
                        : `${count(snap.rows.length, 'account')}, ${enabledCount} enabled`,
                ],
            items: problem ? [] : items,
            actions,
        },
    };
}
function quotaSection(options, snap) {
    const scope = options.quota?.scope ?? 'all';
    const now = options.now();
    // A scoped menu names its model family in the header, since the quota
    // shown is that family's view of each account.
    const group = scope === 'all' ? 'Accounts' : `Accounts · ${scope}`;
    // Checking quota asks the provider for a fresh reading. A plugin that
    // polls its accounts itself (its own HTTP quota call) supplies
    // `quota.check`; otherwise each row's reading is requested from the store,
    // which runs the plugin's pull for that row. Checking one account and
    // checking all use the same path.
    const check = async (ids, invocation) => {
        if (options.quota?.check)
            await options.quota.check(ids, invocation);
        else {
            for (const id of ids)
                options.store.requestReading(id);
            await options.store.pullsSettled();
        }
    };
    // Only a routing candidate (enabled, valid and holding a credential) is a
    // row, because a row must do something when chosen and its action checks
    // that account's quota. Any other account becomes a read-only line naming
    // why it can't be checked (disabled, invalid, no credential), followed by
    // its last stored quota reading.
    const candidates = snap.rows.filter((row) => row.candidate);
    const items = candidates.map((row) => {
        const { account, name } = accountView(row, options);
        const quota = projected(row, scope);
        return {
            id: row.id,
            label: name,
            group,
            status: formatQuota(quota, { now, form: 'compact' }),
            detail: formatQuota(quota, { now, form: 'full' }),
            account,
            actions: [
                {
                    id: 'check',
                    label: 'Check this account',
                    run: async ({ invocation }) => {
                        await check([row.id], invocation);
                        return `Checked quota for ${name}.`;
                    },
                },
            ],
        };
    });
    const unchecked = snap.rows
        .filter((row) => !row.candidate)
        .map((row) => {
        const { name } = accountView(row, options);
        const reason = row.invalid
            ? 'invalid'
            : !row.enabled
                ? 'disabled'
                : row.credential === undefined
                    ? 'no credential'
                    : 'unavailable';
        const quota = formatQuota(projected(row, scope), {
            now,
            form: 'compact',
        });
        return `${name} (${reason}): ${quota}`;
    });
    const actions = [];
    if (candidates.length > 0)
        actions.push({
            id: 'check',
            label: 'Check now',
            description: 'Checks every account that can be checked.',
            group: ACTIONS_GROUP,
            run: async ({ invocation }) => {
                const ids = candidates.map((row) => row.id);
                await check(ids, invocation);
                return `Checked quota for ${count(ids.length, 'account')}.`;
            },
        });
    return {
        id: 'quota',
        slot: 'quota',
        title: 'Quota',
        content: {
            lines: snap.rows.length === 0 ? ['No accounts yet'] : unchecked,
            items,
            actions,
        },
    };
}
/**
 * Sets the vault order. The roster's own refusal of the list (`invalid-order`:
 * an account left out, which it counts without naming) is shown with its own
 * message; any other failure is projected as usual. The kind is read from
 * the error object so the menu does not import the vault client.
 */
async function reorderVault(vault, order) {
    try {
        return await vault.reorder(order);
    }
    catch (error) {
        if (error instanceof Error &&
            error.name === 'ClaustrumConsumerError' &&
            error.kind === 'invalid-order')
            throw new CommandError('vault-invalid-order', error.message, {
                cause: error,
            });
        throw error;
    }
}
function invalidVaultOrder(message) {
    return new CommandError('vault-invalid-order', message);
}
/**
 * How the Routing section names vault accounts: by label, since route ids
 * are long and opaque. A typed entry may be a label or a route id, and must
 * name exactly one account. Refusals quote only the entry the user typed.
 */
function vaultNames(vault) {
    const rows = vault.rows.map((row) => ({
        id: row.id,
        label: row.label.trim() || row.id,
    }));
    const matches = (entry) => rows.filter((row) => row.id === entry || row.label === entry);
    return {
        ids: rows.map((row) => row.id),
        nameOf: (id) => rows.find((row) => row.id === id)?.label ?? id,
        /**
         * What the order input starts with for an account: its label when
         * typing that label back names this account alone, else its route id
         * (two accounts sharing a label, or a label with a comma or line break
         * in it, either of which would split it into two entries).
         */
        entryOf: (id) => {
            const row = rows.find((entry) => entry.id === id);
            return row && !/[,\n]/.test(row.label) && matches(row.label).length === 1
                ? row.label
                : id;
        },
        /** The route ids the typed entries name, in order; refuses before any write. */
        resolve: (entries) => {
            const ids = [];
            for (const entry of entries) {
                const found = matches(entry);
                if (found.length === 0)
                    throw invalidVaultOrder(`"${entry}" is not a vault account.`);
                if (found.length > 1)
                    throw invalidVaultOrder(`"${entry}" matches more than one vault account; enter those accounts by route id.`);
                const id = found[0].id;
                if (ids.includes(id))
                    throw invalidVaultOrder(`"${entry}" names an account already in the order.`);
                ids.push(id);
            }
            return ids;
        },
    };
}
function routingSection(options, snap) {
    const { store, extraLocks } = options;
    const locks = extraLocks ? { extraLocks } : {};
    const choices = [
        { value: 'ordered', label: 'Ordered (roster order)' },
        ...(options.routing?.orderedVariants ?? []),
        { value: 'sticky-balanced', label: 'Sticky balanced' },
    ];
    const raw = record(snap.settings.routing).mode;
    const current = typeof raw === 'string' && choices.some((choice) => choice.value === raw)
        ? raw
        : 'ordered';
    const resolved = resolveRoutingMode(current);
    // In vault mode routing tries the vault accounts, so their order is the
    // one shown and set here; the pool roster's order is not used.
    const vault = snap.vault ? vaultNames(snap.vault) : undefined;
    const ids = vault ? vault.ids : snap.rows.map((row) => row.id);
    const nameOf = (id) => (vault ? vault.nameOf(id) : id);
    const tried = orderForPlacement(ids, resolved.placement, options.routing?.formerMainId ?? DEFAULT_FORMER_MAIN_ID);
    const label = choices.find((choice) => choice.value === current)?.label ?? current;
    const lines = [`Mode: ${label}`];
    if (ids.length > 0)
        lines.push(`${vault ? 'Vault account order' : 'Roster order'}: ${ids.map(nameOf).join(', ')}`);
    if (resolved.mode === 'ordered' && tried.join() !== ids.join())
        lines.push(`Tried in order: ${tried.map(nameOf).join(', ')}`);
    const actions = [
        {
            id: 'mode',
            label: 'Change mode',
            group: ACTIONS_GROUP,
            knobs: [
                { kind: 'choice', id: 'mode', label: 'Mode', choices, value: current },
            ],
            run: async ({ values }) => {
                const mode = String(values.mode);
                await store.updateSettings((settings) => {
                    settings.routing = { ...record(settings.routing), mode };
                    return undefined;
                }, locks);
                return `Routing mode set to ${choices.find((choice) => choice.value === mode)?.label ?? mode}.`;
            },
        },
    ];
    if (ids.length > 1)
        actions.push({
            id: 'order',
            label: 'Set order',
            group: ACTIONS_GROUP,
            knobs: [
                {
                    kind: 'text',
                    id: 'order',
                    label: vault
                        ? 'Vault accounts, first to last, separated by commas'
                        : 'Account ids, first to last',
                    value: vault ? ids.map(vault.entryOf).join(', ') : ids.join(', '),
                    required: true,
                },
            ],
            run: async ({ values }) => {
                const text = String(values.order);
                // A vault label may contain spaces, so vault entries are separated by
                // commas or line breaks, not spaces; pool ids never contain spaces.
                const entries = text
                    .split(vault ? /[,\n]+/ : /[\s,]+/)
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0);
                const result = snap.vault && vault
                    ? await reorderVault(snap.vault, vault.resolve(entries))
                    : await store.reorder(entries, locks);
                return result.outcome === 'unchanged'
                    ? 'The order is unchanged.'
                    : `Order set to ${result.ids.map(nameOf).join(', ')}.`;
            },
        });
    return {
        id: 'routing',
        slot: 'routing',
        title: 'Routing',
        content: { lines, actions },
    };
}
function floorLabels(options, snap) {
    if (options.limits?.labels)
        return [...options.limits.labels];
    const scope = options.quota?.scope ?? 'all';
    const labels = [];
    for (const row of snap.rows)
        for (const limit of projected(row, scope)?.limits ?? [])
            if (!labels.includes(limit.label))
                labels.push(limit.label);
    return labels.length > 0 ? labels : ['primary'];
}
/**
 * The display name for each floor. A floor is keyed by the quota window
 * label the plugin stores readings under (`primary`, `five_hour`). When some
 * account's stored quota reading records that window's length, the floor is
 * shown under the same name `formatQuota` gives the window (`5h`, `7d`);
 * otherwise under the label itself. The settings file keeps the label.
 */
function floorNames(options, snap) {
    const scope = options.quota?.scope ?? 'all';
    const names = new Map();
    for (const row of snap.rows)
        for (const limit of projected(row, scope)?.limits ?? [])
            if (limit.windowMinutes !== undefined && !names.has(limit.label))
                names.set(limit.label, quotaWindowName(limit));
    return (label) => names.get(label) ?? label;
}
function limitsSection(options, snap) {
    const { store, extraLocks } = options;
    const locks = extraLocks ? { extraLocks } : {};
    const killswitch = record(snap.settings.killswitch);
    const enabled = killswitch.enabled === true;
    const floors = record(killswitch.accounts);
    const labels = floorLabels(options, snap);
    const nameOf = floorNames(options, snap);
    const state = enabled ? 'on' : 'off';
    const items = snap.rows.map((row) => {
        const { account, name } = accountView(row, options);
        const own = record(floors[row.id]);
        const set = labels.filter((label) => typeof own[label] === 'number');
        return {
            id: row.id,
            label: name,
            group: `Floors · killswitch ${state}`,
            // A floor is the least "% left" the account may fall to.
            status: set.length === 0
                ? 'no floors'
                : set.map((label) => `${nameOf(label)} ≥${own[label]}%`).join(' · '),
            account,
            actions: [
                {
                    id: 'floors',
                    label: 'Set floors',
                    knobs: labels.map((label) => ({
                        kind: 'number',
                        id: label,
                        label: `Minimum % left for ${nameOf(label)}`,
                        min: 0,
                        max: 100,
                        ...(typeof own[label] === 'number'
                            ? { value: own[label] }
                            : {}),
                    })),
                    run: async ({ values }) => {
                        await store.updateSettings((settings) => {
                            const next = record(settings.killswitch);
                            const accounts = record(next.accounts);
                            const mine = record(accounts[row.id]);
                            for (const label of labels) {
                                const value = values[label];
                                if (typeof value === 'number')
                                    mine[label] = value;
                                else if (value === null)
                                    delete mine[label];
                            }
                            if (Object.keys(mine).length > 0)
                                accounts[row.id] = mine;
                            else
                                delete accounts[row.id];
                            if (Object.keys(accounts).length > 0)
                                next.accounts = accounts;
                            else
                                delete next.accounts;
                            settings.killswitch = next;
                            return undefined;
                        }, locks);
                        return `Floors updated for ${name}.`;
                    },
                },
            ],
        };
    });
    return {
        id: 'limits',
        slot: 'limits',
        title: 'Limits',
        content: {
            lines: [`Killswitch ${state}`],
            items,
            actions: [
                {
                    id: 'killswitch',
                    label: enabled ? 'Turn killswitch off' : 'Turn killswitch on',
                    description: 'With the killswitch on, an account whose quota falls below one of its floors is not used.',
                    group: ACTIONS_GROUP,
                    knobs: [
                        {
                            kind: 'toggle',
                            id: 'enabled',
                            label: 'Killswitch',
                            value: !enabled,
                        },
                    ],
                    run: async ({ values }) => {
                        const on = values.enabled === true;
                        await store.updateSettings((settings) => {
                            settings.killswitch = {
                                ...record(settings.killswitch),
                                enabled: on,
                            };
                            return undefined;
                        }, locks);
                        return `Killswitch ${on ? 'on' : 'off'}.`;
                    },
                },
            ],
        },
    };
}
/** The four built-in sections, in their fixed order, from one read of the store. */
export async function builtinSections(options) {
    const snap = await snapshot(options);
    return [
        accountsSection(options, snap),
        quotaSection(options, snap),
        routingSection(options, snap),
        limitsSection(options, snap),
    ];
}
