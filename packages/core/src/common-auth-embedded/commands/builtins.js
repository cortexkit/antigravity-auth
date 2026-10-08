// The four sections every plugin gets from the library: Accounts, Quota,
// Routing and Limits. They read the pool and the plugin's settings through
// the store and write only through store operations, so a menu action takes
// the same locks as any other writer of those files.
import { isQuotaMap, projectQuota, } from '../quota/index.js';
import { DEFAULT_FORMER_MAIN_ID, orderForPlacement, resolveRoutingMode, } from '../routing/index.js';
import { projectFailure, } from './seam.js';
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
function formatPercent(value) {
    return `${Math.round(value)}%`;
}
function formatReset(resetsAt, now) {
    if (resetsAt === undefined)
        return '';
    const at = Date.parse(resetsAt);
    if (!Number.isFinite(at))
        return '';
    const minutes = Math.max(0, Math.round((at - now) / 60_000));
    if (minutes < 60)
        return `, resets in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48)
        return `, resets in ${hours}h ${minutes % 60}m`;
    return `, resets in ${Math.floor(hours / 24)}d`;
}
/** One line per quota window: `primary 58% left` and the credit budget. */
function quotaSummary(quota) {
    if (!quota || (quota.limits.length === 0 && !quota.budget))
        return 'no quota reading yet';
    const parts = quota.limits.map((limit) => limit.kind === 'reading' && limit.remainingPercent !== undefined
        ? `${limit.label} ${formatPercent(limit.remainingPercent)} left`
        : `${limit.label} ${limit.kind === 'retired' ? 'retired' : 'not reported'}`);
    if (quota.budget)
        parts.push(quota.budget.reached
            ? 'credits spent'
            : quota.budget.remainingPercent !== undefined
                ? `credits ${formatPercent(quota.budget.remainingPercent)} left`
                : 'credits available');
    return parts.join(' · ');
}
function quotaFacts(quota, now) {
    const facts = {};
    for (const limit of quota?.limits ?? []) {
        facts[limit.label] =
            limit.kind === 'reading' && limit.usedPercent !== undefined
                ? `${formatPercent(limit.usedPercent)} used${formatReset(limit.resetsAt, now)}`
                : limit.kind === 'retired'
                    ? 'retired'
                    : 'not reported';
    }
    if (quota?.budget)
        facts.credits = quota.budget.reached
            ? `spent${formatReset(quota.budget.resetsAt, now)}`
            : quota.budget.remainingPercent !== undefined
                ? `${formatPercent(quota.budget.remainingPercent)} left`
                : 'available';
    return facts;
}
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
    }
}
/**
 * What the user is told about a failed late login: the projected message,
 * never the exception's own text, which can quote the login's request.
 */
function failureMessage(error) {
    return projectFailure(error).text;
}
async function snapshot(store) {
    const load = await store.read();
    const read = await store.readSettings();
    return {
        load,
        rows: distinctRows(load),
        settings: read.status === 'error' ? {} : read.settings,
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
    const scope = options.quota?.scope ?? 'all';
    const ids = snap.rows.map((row) => row.id);
    const problem = loadProblem(snap.load);
    const enabledCount = snap.rows.filter((row) => row.enabled).length;
    const items = snap.rows.map((row, index) => {
        const { account, name } = accountView(row, options);
        const detail = [
            row.type === 'api' ? 'API key' : 'OAuth',
            row.invalid
                ? 'invalid'
                : row.enabled
                    ? 'enabled'
                    : `disabled${row.disabledReason ? ` (${row.disabledReason})` : ''}`,
            ...(account.identity !== undefined ? [account.identity] : []),
            quotaSummary(projected(row, scope)),
        ].join(' · ');
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
        return { id: row.id, label: name, detail, account, actions };
    });
    const login = options.accounts?.login;
    const actions = [];
    if (login && !problem)
        actions.push({
            id: 'add',
            label: login.label ?? 'Add account',
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
                        ? 'No accounts yet.'
                        : `${snap.rows.length} account(s), ${enabledCount} enabled.`,
                ],
            items: problem ? [] : items,
            actions,
        },
    };
}
function quotaSection(options, snap) {
    const scope = options.quota?.scope ?? 'all';
    const now = options.now();
    const items = snap.rows.map((row) => {
        const { account, name } = accountView(row, options);
        const quota = projected(row, scope);
        return {
            id: row.id,
            label: name,
            detail: quotaSummary(quota),
            account,
            facts: quotaFacts(quota, now),
        };
    });
    const candidates = snap.rows.filter((row) => row.candidate);
    const actions = [];
    if (candidates.length > 0)
        actions.push({
            id: 'check',
            label: 'Check now',
            knobs: [
                {
                    kind: 'choice',
                    id: 'account',
                    label: 'Account',
                    choices: [
                        { value: '*', label: 'All accounts' },
                        ...candidates.map((row) => ({
                            value: row.id,
                            label: accountView(row, options).name,
                        })),
                    ],
                    value: '*',
                },
            ],
            run: async ({ values, invocation }) => {
                const ids = values.account === '*'
                    ? candidates.map((row) => row.id)
                    : [String(values.account)];
                if (options.quota?.check)
                    await options.quota.check(ids, invocation);
                else {
                    for (const id of ids)
                        options.store.requestReading(id);
                    await options.store.pullsSettled();
                }
                return `Checked quota for ${ids.length} account(s).`;
            },
        });
    return {
        id: 'quota',
        slot: 'quota',
        title: 'Quota',
        content: {
            lines: snap.rows.length === 0 ? ['No accounts yet.'] : [`Scope: ${scope}.`],
            items,
            actions,
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
    const ids = snap.rows.map((row) => row.id);
    const tried = orderForPlacement(ids, resolved.placement, options.routing?.formerMainId ?? DEFAULT_FORMER_MAIN_ID);
    const label = choices.find((choice) => choice.value === current)?.label ?? current;
    const lines = [`Mode: ${label}.`];
    if (ids.length > 0)
        lines.push(`Roster order: ${ids.join(', ')}.`);
    if (resolved.mode === 'ordered' && tried.join() !== ids.join())
        lines.push(`Tried in order: ${tried.join(', ')}.`);
    const actions = [
        {
            id: 'mode',
            label: 'Change mode',
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
            knobs: [
                {
                    kind: 'text',
                    id: 'order',
                    label: 'Account ids, first to last',
                    value: ids.join(', '),
                    required: true,
                },
            ],
            run: async ({ values }) => {
                const order = String(values.order)
                    .split(/[\s,]+/)
                    .filter((id) => id.length > 0);
                const result = await store.reorder(order, locks);
                return result.outcome === 'unchanged'
                    ? 'The order is unchanged.'
                    : `Order set to ${result.ids.join(', ')}.`;
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
function limitsSection(options, snap) {
    const { store, extraLocks } = options;
    const locks = extraLocks ? { extraLocks } : {};
    const killswitch = record(snap.settings.killswitch);
    const enabled = killswitch.enabled === true;
    const floors = record(killswitch.accounts);
    const labels = floorLabels(options, snap);
    const items = snap.rows.map((row) => {
        const { account, name } = accountView(row, options);
        const own = record(floors[row.id]);
        const set = labels.filter((label) => typeof own[label] === 'number');
        return {
            id: row.id,
            label: name,
            detail: set.length === 0
                ? 'no floors'
                : `floors: ${set.map((label) => `${label} ${own[label]}%`).join(', ')}`,
            account,
            actions: [
                {
                    id: 'floors',
                    label: 'Set floors',
                    knobs: labels.map((label) => ({
                        kind: 'number',
                        id: label,
                        label: `Minimum % left for ${label}`,
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
            lines: [
                `Killswitch: ${enabled ? 'on' : 'off'}.`,
                'With the killswitch on, an account whose quota falls below one of its floors is not used.',
            ],
            items,
            actions: [
                {
                    id: 'killswitch',
                    label: enabled ? 'Turn killswitch off' : 'Turn killswitch on',
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
    const snap = await snapshot(options.store);
    return [
        accountsSection(options, snap),
        quotaSection(options, snap),
        routingSection(options, snap),
        limitsSection(options, snap),
    ];
}
