import { isQuotaMap, projectQuota } from '../quota/index.js';
import { PoolOperationError, } from '../store/index.js';
import { doctorAction } from './doctor.js';
import { runMenuLogin } from './login.js';
import { runMenu, } from './menu.js';
/** The reason recorded on a row the menu disables. */
export const MENU_DISABLE_REASON = 'disabled from the auth menu';
/** At most this many account lines are shown above the actions. */
const STATUS_ACCOUNT_LINES = 8;
async function readRows(store) {
    const load = await store.read();
    if (load.status === 'ready')
        return { rows: load.rows };
    if (load.status === 'pending-migration')
        return { rows: [], problem: 'The account store has not been migrated yet.' };
    return {
        rows: [],
        problem: `The account store could not be read (${load.file}: ${load.reason}).`,
    };
}
/**
 * Whether the store holds any usable credential. Meant as one half of an
 * `hasCredential` predicate (the other being the host's own slot); a row with
 * no credential does not count, since it gives the menu nothing to manage.
 */
export async function poolHasCredential(store) {
    const { rows } = await readRows(store);
    return rows.some((row) => row.credential !== undefined);
}
function describeRow(row) {
    const parts = [];
    if (row.label)
        parts.push(row.label);
    if (row.invalid)
        parts.push(`invalid ${row.invalid}`);
    else if (!row.enabled)
        parts.push(row.disabledReason ? `disabled: ${row.disabledReason}` : 'disabled');
    else
        parts.push('enabled');
    if (!row.credential && !row.invalid)
        parts.push('no credential');
    return parts.join(', ');
}
function accountLines(read) {
    if (read.problem)
        return [read.problem];
    if (read.rows.length === 0)
        return ['No accounts yet.'];
    const lines = read.rows
        .slice(0, STATUS_ACCOUNT_LINES)
        .map((row) => `${row.id}: ${describeRow(row)}`);
    const more = read.rows.length - STATUS_ACCOUNT_LINES;
    if (more > 0)
        lines.push(`... and ${more} more`);
    return lines;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
async function pickAccount(context, rows, message) {
    if (rows.length === 0) {
        context.print('There are no accounts.');
        return null;
    }
    return context.select(rows.map((row) => ({ label: row.id, value: row, hint: describeRow(row) })), { message });
}
function defaultAccountId(account, rows) {
    const taken = new Set(rows.map((row) => row.id));
    if (account.id && !taken.has(account.id))
        return account.id;
    for (let n = 1;; n++) {
        const id = `account-${n}`;
        if (!taken.has(id))
            return id;
    }
}
/** Formats a row's stored quota map as one line per window. */
export function quotaLines(row) {
    if (!isQuotaMap(row.quota))
        return ['  no quota reading'];
    const projected = projectQuota(row.quota);
    const lines = [];
    for (const limit of projected.limits) {
        const name = limit.scope === 'all' ? limit.label : `${limit.scope}/${limit.label}`;
        if (limit.kind !== 'reading') {
            lines.push(`  ${name}: no limit reported`);
            continue;
        }
        const resets = limit.resetsAt ? `, resets ${limit.resetsAt}` : '';
        lines.push(`  ${name}: ${limit.remainingPercent}% left${resets}`);
    }
    if (projected.budget) {
        const budget = projected.budget;
        lines.push(budget.reached
            ? '  budget: reached'
            : budget.remainingPercent === undefined
                ? '  budget: available'
                : `  budget: ${budget.remainingPercent}% left`);
    }
    return lines.length > 0 ? lines : ['  no quota reading'];
}
/** Adds an account through the plugin's login and reports what the store did. */
export function addAccountAction(options) {
    return {
        id: 'add-account',
        label: 'Add account',
        hint: 'sign in to another account',
        async run(context) {
            const login = options.login;
            if (!login)
                throw new Error('No login is configured');
            const account = await runMenuLogin(login, context);
            const { rows } = await readRows(options.store);
            const id = (options.newAccountId ?? defaultAccountId)(account, rows);
            const added = await options.store.add({
                id,
                credential: account.credential,
                ...(account.identity !== undefined
                    ? { identity: account.identity }
                    : {}),
                ...(account.label !== undefined ? { label: account.label } : {}),
            }, options.extraLocks ? { extraLocks: options.extraLocks } : {});
            if (added.outcome === 'rotated')
                context.print(`That sign-in is already account ${added.id}; its credential was updated.`);
            else if (added.outcome === 'added-disabled')
                context.print(`Added account ${added.id}, disabled: another enabled account is the same provider account.`);
            else if (added.outcome === 'completed')
                context.print(`Finished adding account ${added.id}.`);
            else
                context.print(`Added account ${added.id}.`);
        },
    };
}
/**
 * Signs an existing account in again and replaces its credential. A login
 * that comes back as a different provider account is refused: replacing
 * would silently turn the row into another account.
 */
export function reauthenticateAction(options) {
    return {
        id: 'reauthenticate',
        label: 'Re-authenticate account',
        hint: 'sign an account in again',
        async run(context) {
            const login = options.login;
            if (!login)
                throw new Error('No login is configured');
            const { rows } = await readRows(options.store);
            const row = await pickAccount(context, rows, 'Re-authenticate which account?');
            if (!row)
                return;
            const account = await runMenuLogin(login, context);
            if (account.identity !== undefined &&
                row.identity !== undefined &&
                account.identity !== row.identity) {
                context.print(`That sign-in is a different account from ${row.id}; nothing was changed. Use Add account to add it.`);
                return;
            }
            const identity = account.identity ?? row.identity;
            await options.store.replace(row.id, account.credential, identity !== undefined ? { identity } : {}, options.extraLocks ? { extraLocks: options.extraLocks } : {});
            context.print(`Updated the sign-in of account ${row.id}.`);
        },
    };
}
function removeOptions(options) {
    return {
        ...(options.protect ? { protect: options.protect } : {}),
        ...(options.extraLocks ? { extraLocks: options.extraLocks } : {}),
    };
}
function protectedReason(error) {
    return error instanceof PoolOperationError && error.kind === 'row-protected'
        ? error.message
        : undefined;
}
/** Removes one account after the operator confirms it by name. */
export function removeAccountAction(options) {
    return {
        id: 'remove-account',
        label: 'Remove account',
        hint: 'delete one account',
        async run(context) {
            const { rows } = await readRows(options.store);
            const row = await pickAccount(context, rows, 'Remove which account?');
            if (!row)
                return;
            if (!(await context.confirm(`Remove account ${row.id}?`))) {
                context.print('Cancelled; nothing was changed.');
                return;
            }
            try {
                await options.store.remove(row.id, removeOptions(options));
            }
            catch (error) {
                const reason = protectedReason(error);
                if (reason === undefined)
                    throw error;
                context.print(`Account ${row.id} was kept: ${reason}`);
                return;
            }
            context.print(`Removed account ${row.id}.`);
        },
    };
}
/** Disables an enabled account, or enables a disabled one. */
export function toggleAccountAction(options) {
    return {
        id: 'toggle-account',
        label: 'Enable or disable account',
        hint: 'stop or resume using an account',
        async run(context) {
            const { rows } = await readRows(options.store);
            const row = await pickAccount(context, rows, 'Enable or disable which account?');
            if (!row)
                return;
            const toggle = options.extraLocks
                ? { extraLocks: options.extraLocks }
                : {};
            if (row.enabled) {
                await options.store.disable(row.id, options.disableReason ?? MENU_DISABLE_REASON, toggle);
                context.print(`Disabled account ${row.id}.`);
                return;
            }
            try {
                await options.store.enable(row.id, toggle);
            }
            catch (error) {
                if (error instanceof PoolOperationError &&
                    error.kind === 'duplicate-identity') {
                    context.print(`Account ${row.id} stays disabled: another enabled account is the same provider account.`);
                    return;
                }
                throw error;
            }
            context.print(`Enabled account ${row.id}.`);
        },
    };
}
/** Prints every account and its state, changing nothing. */
export function listAccountsAction(options) {
    return {
        id: 'list-accounts',
        label: 'List accounts',
        hint: 'show every account',
        async run(context) {
            const read = await readRows(options.store);
            if (read.problem) {
                context.print(read.problem);
                return;
            }
            if (read.rows.length === 0)
                context.print('No accounts yet.');
            for (const row of read.rows)
                context.print(`${row.id}: ${describeRow(row)}`);
        },
    };
}
/**
 * Polls each account's quota once, in order, records each reading through
 * the store (so it lands only on the credential it was taken with), then
 * prints every account's windows from what is stored.
 */
export function checkQuotasAction(options) {
    return {
        id: 'check-quotas',
        label: 'Check quotas',
        hint: 'poll and show the windows of each account',
        async run(context) {
            const before = await readRows(options.store);
            if (before.problem) {
                context.print(before.problem);
                return;
            }
            const errors = new Map();
            const poll = options.pollQuota;
            if (poll) {
                for (const row of before.rows) {
                    if (row.invalid ||
                        !row.credential ||
                        row.credentialEpoch === undefined) {
                        errors.set(row.id, 'no usable credential');
                        continue;
                    }
                    try {
                        const observation = await poll(row);
                        await options.store.recordQuota(row.id, {
                            credentialEpoch: row.credentialEpoch,
                            ...(row.identity !== undefined
                                ? { identity: row.identity }
                                : {}),
                        }, observation);
                    }
                    catch (error) {
                        errors.set(row.id, errorText(error));
                    }
                }
            }
            const after = await readRows(options.store);
            if (after.rows.length === 0)
                context.print('No accounts yet.');
            for (const row of after.rows) {
                context.print(`${row.id}:`);
                const error = errors.get(row.id);
                if (error)
                    context.print(`  quota check failed: ${error}`);
                for (const line of quotaLines(row))
                    context.print(line);
            }
        },
    };
}
/**
 * Removes every account the plugin does not protect. Each removal goes
 * through `store.remove` with the plugin's `protect`, so a protected id is
 * refused under the store's locks and stays, with its files untouched.
 */
export function deleteAllAction(options) {
    return {
        id: 'delete-all',
        label: 'Delete all accounts',
        destructive: true,
        confirm: 'Delete every account? Accounts the plugin keeps are not deleted.',
        async run(context) {
            const read = await readRows(options.store);
            if (read.problem) {
                context.print(read.problem);
                return;
            }
            const removed = [];
            const kept = [];
            for (const row of read.rows) {
                try {
                    await options.store.remove(row.id, removeOptions(options));
                    removed.push(row.id);
                }
                catch (error) {
                    const reason = protectedReason(error);
                    if (reason === undefined)
                        throw error;
                    kept.push(`${row.id} (${reason})`);
                }
            }
            context.print(`Deleted ${removed.length} account(s).`);
            if (kept.length > 0)
                context.print(`Kept: ${kept.join(', ')}.`);
        },
    };
}
/**
 * The menu's actions for this plugin and mode. Local mode: add,
 * re-authenticate, remove, enable/disable, check quotas, doctor, the
 * plugin's extras, delete all. Custody mode: list, enable/disable, check
 * quotas, doctor and the extras; nothing that adds, signs in or removes.
 */
export async function accountMenuActions(options) {
    return actionsFor(options, (await options.custody?.()) === true);
}
function actionsFor(options, custody) {
    const doctor = options.doctor?.length
        ? [doctorAction({ checks: options.doctor })]
        : [];
    const extras = [...(options.extraActions ?? [])];
    if (custody) {
        return [
            listAccountsAction(options),
            toggleAccountAction(options),
            checkQuotasAction(options),
            ...doctor,
            ...extras,
        ];
    }
    return [
        ...(options.login
            ? [addAccountAction(options), reauthenticateAction(options)]
            : []),
        removeAccountAction(options),
        toggleAccountAction(options),
        checkQuotasAction(options),
        ...doctor,
        ...extras,
        deleteAllAction(options),
    ];
}
/** Shows the account menu once and runs the chosen action. */
export async function runAccountMenu(options) {
    const custody = (await options.custody?.()) === true;
    const actions = actionsFor(options, custody);
    const [read, status] = await Promise.all([
        readRows(options.store),
        options.status?.() ?? [],
    ]);
    return runMenu({
        title: options.title,
        subtitle: custody
            ? 'Accounts come from the vault; select an action'
            : 'Select an account action',
        status: [...status, ...accountLines(read)],
        actions,
        ...(options.terminal ? { terminal: options.terminal } : {}),
    });
}
