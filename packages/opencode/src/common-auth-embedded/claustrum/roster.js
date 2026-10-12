import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { acquireRefreshFileLock, withLock, writeJsonAtomic, } from '../fs/index.js';
import { isQuotaMap, mergeQuotaObservation, } from '../quota/index.js';
import { ClaustrumConsumerError } from './errors.js';
import { acceptAccount, declineAccount, isDeclined, } from './interlock.js';
export const DEFAULT_ROUTE_PREFIX = 'vault:';
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function defaultLabel(credential) {
    // `oauth:<provider>:<label>` is the vault's conventional spelling; use the
    // trailing label when present and fall back to the account's email.
    const parts = credential.credentialId.split(':');
    const label = parts.length >= 3 ? parts.slice(2).join(':').trim() : undefined;
    return label || credential.email || credential.credentialId;
}
function groupKey(member) {
    return member.identity !== undefined
        ? `identity:${member.identity}`
        : `credential:${member.credential.credentialId}`;
}
function memberIds(row) {
    return [row.credentialId, ...(row.aliases ?? [])];
}
/**
 * Project the vault's list onto the previous roster. Pure: callers serialize
 * discovery and commit. Route ids, quota and the time an account was added
 * survive for the same account; a credential that now logs into a different
 * known account gets a new route id and no inherited quota.
 *
 * A record listed without an identity keeps the last account it was known to
 * log into (the row is marked `unclaimed`). Dropping that binding would let a
 * later different account look like an identity learned for the first time
 * and inherit the first account's route and quota.
 *
 * A reply with unusable records is incomplete: a previous member it does not
 * account for (its record was rejected, or a rejected record has no usable id
 * and could be any of them) is kept, as an alias of its live account or as a
 * `stale` row. Only a complete reply removes an account.
 */
export function projectVaultRoster(previous, inventory, options = {}) {
    const now = options.now ?? Date.now();
    const prefix = options.routePrefix ?? DEFAULT_ROUTE_PREFIX;
    const reserved = options.reservedRouteIds ?? new Set();
    const previousRows = previous?.rows ?? [];
    // Declines follow the account and outlive its records, so none is pruned.
    const declined = [...(previous?.declined ?? [])];
    const complete = inventory.skipped.length === 0;
    const listed = new Set(inventory.credentials.map((credential) => credential.credentialId));
    const rejectedIds = new Set(inventory.skipped.flatMap((record) => record.credentialId === undefined ? [] : [record.credentialId]));
    const unrecoverable = inventory.skipped.some((record) => record.credentialId === undefined);
    const unaccounted = (id) => !listed.has(id) && (rejectedIds.has(id) || unrecoverable);
    const lastKnown = new Map();
    for (const row of previousRows) {
        if (row.accountIdentity === undefined)
            continue;
        for (const id of memberIds(row))
            if (!lastKnown.has(id))
                lastKnown.set(id, row.accountIdentity);
    }
    const groups = new Map();
    for (const credential of inventory.credentials) {
        const member = credential.accountIdentity !== undefined
            ? { credential, identity: credential.accountIdentity, claimed: true }
            : {
                credential,
                identity: lastKnown.get(credential.credentialId),
                claimed: false,
            };
        const key = groupKey(member);
        const group = groups.get(key) ?? [];
        group.push(member);
        groups.set(key, group);
    }
    const used = new Set();
    const taken = new Set(reserved);
    const projected = [];
    const byId = (left, right) => left.credential.credentialId.localeCompare(right.credential.credentialId);
    const sortedGroups = [...groups.values()]
        .map((group) => group.toSorted(byId))
        .sort((left, right) => (left[0] && right[0] ? byId(left[0], right[0]) : 0));
    for (const ordered of sortedGroups) {
        const identity = ordered[0]?.identity;
        const active = ordered.filter((entry) => entry.credential.state === 'active');
        const usable = active.length ? active : ordered;
        // A record that claims the account itself is preferred over one that is
        // only remembered as belonging to it.
        const claimed = usable.filter((entry) => entry.claimed);
        const choices = claimed.length ? claimed : usable;
        const members = new Set(ordered.map((entry) => entry.credential.credentialId));
        // An unknown previous account may be learned now; a known one must match.
        const bound = previousRows.find((row) => !used.has(row) &&
            memberIds(row).some((id) => members.has(id)) &&
            (row.accountIdentity === undefined || row.accountIdentity === identity));
        const chosen = choices.find((entry) => entry.credential.credentialId === bound?.credentialId) ?? choices[0];
        if (!chosen)
            continue;
        const representative = chosen.credential;
        const existing = bound ??
            (identity === undefined
                ? undefined
                : previousRows.find((row) => !used.has(row) && row.accountIdentity === identity));
        if (existing)
            used.add(existing);
        let routeId = existing?.routeId;
        if (!routeId || reserved.has(routeId)) {
            const base = `${prefix}${representative.credentialId}${identity === undefined ? '' : `~${hash(identity).slice(0, 10)}`}`;
            routeId = base;
            for (let suffix = 2; taken.has(routeId); suffix++)
                routeId = `${base}~${suffix}`;
        }
        taken.add(routeId);
        const retained = existing ? memberIds(existing).filter(unaccounted) : [];
        const aliases = [
            ...new Set([
                ...ordered.map((entry) => entry.credential.credentialId),
                ...retained,
            ]),
        ]
            .filter((id) => id !== representative.credentialId)
            .sort((left, right) => left.localeCompare(right));
        const mapped = options.mapAccount?.(representative) ?? {};
        projected.push({
            previousIndex: existing ? previousRows.indexOf(existing) : Infinity,
            row: {
                routeId,
                credentialId: representative.credentialId,
                credentialType: representative.credentialType,
                ...(identity !== undefined && { accountIdentity: identity }),
                ...(aliases.length && { aliases }),
                state: representative.state,
                label: mapped.label?.trim() || defaultLabel(representative),
                ...(representative.email !== undefined && {
                    email: representative.email,
                }),
                ...(representative.orgName !== undefined && {
                    orgName: representative.orgName,
                }),
                enabled: ![representative.credentialId, ...aliases].some((id) => isDeclined(declined, id, identity)),
                addedAt: existing?.addedAt ?? now,
                ...(existing?.quota !== undefined && { quota: existing.quota }),
                ...(!chosen.claimed && identity !== undefined && { unclaimed: true }),
            },
        });
    }
    // An account the reply does not account for keeps its last good projection:
    // a rejected record must not read as the account having been removed. A
    // credential this reply lists belongs to the live row it was projected into,
    // so it is taken out of the stale row: otherwise one credential could be
    // authorized, and its readings recorded, under two account bindings. A
    // stale row left with no member is dropped.
    previousRows.forEach((row, previousIndex) => {
        if (used.has(row) || !memberIds(row).some(unaccounted))
            return;
        if (taken.has(row.routeId))
            return;
        const [credentialId, ...aliases] = memberIds(row).filter((id) => !listed.has(id));
        if (credentialId === undefined)
            return;
        taken.add(row.routeId);
        const { aliases: _previousAliases, ...rest } = row;
        projected.push({
            previousIndex,
            row: {
                ...rest,
                credentialId,
                ...(aliases.length && { aliases }),
                stale: true,
            },
        });
    });
    projected.sort((left, right) => left.previousIndex === right.previousIndex
        ? left.row.credentialId.localeCompare(right.row.credentialId)
        : left.previousIndex - right.previousIndex);
    return {
        version: 1,
        view: inventory.view,
        complete,
        ...(!complete && {
            rejected: inventory.skipped.map((record) => ({
                ...(record.credentialId !== undefined && {
                    credentialId: record.credentialId,
                }),
                reason: record.reason,
            })),
        }),
        rows: projected.map((entry) => entry.row),
        declined,
    };
}
/**
 * The rows `/routing` selects among. Only enabled, active accounts route;
 * a declined or cold vault account stays listed for the menu but never
 * reaches admission.
 */
export function vaultRoutingRows(roster) {
    return (roster?.rows ?? [])
        .filter((row) => row.enabled && row.state === 'active')
        .map((row) => ({
        id: row.routeId,
        kind: row.credentialType === 'oauth' ? 'oauth' : 'api-key',
        ...(row.quota !== undefined && { quota: row.quota }),
    }));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalString(value) {
    return value === undefined || typeof value === 'string';
}
function decodeRow(value) {
    if (!isRecord(value) ||
        typeof value.routeId !== 'string' ||
        typeof value.credentialId !== 'string' ||
        (value.credentialType !== 'oauth' && value.credentialType !== 'api_key') ||
        typeof value.state !== 'string' ||
        typeof value.label !== 'string' ||
        typeof value.enabled !== 'boolean' ||
        typeof value.addedAt !== 'number' ||
        !optionalString(value.accountIdentity) ||
        !optionalString(value.email) ||
        !optionalString(value.orgName) ||
        (value.aliases !== undefined &&
            (!Array.isArray(value.aliases) ||
                !value.aliases.every((alias) => typeof alias === 'string'))) ||
        (value.quota !== undefined && !isQuotaMap(value.quota)) ||
        (value.stale !== undefined && value.stale !== true) ||
        (value.unclaimed !== undefined && value.unclaimed !== true))
        return undefined;
    return value;
}
const SKIPPED_REASONS = new Set([
    'empty credential id',
    'duplicate credential id',
    'blank account identity',
    'empty state',
]);
function decodeRejected(value) {
    if (!Array.isArray(value))
        return undefined;
    const records = [];
    for (const entry of value) {
        if (!isRecord(entry) ||
            !optionalString(entry.credentialId) ||
            typeof entry.reason !== 'string' ||
            !SKIPPED_REASONS.has(entry.reason))
            return undefined;
        records.push(entry);
    }
    return records;
}
function decodeRoster(value) {
    if (!isRecord(value) ||
        value.version !== 1 ||
        !optionalString(value.view) ||
        !Array.isArray(value.rows) ||
        !Array.isArray(value.declined) ||
        (value.complete !== undefined && typeof value.complete !== 'boolean') ||
        (value.rejected !== undefined && !decodeRejected(value.rejected)))
        throw new ClaustrumConsumerError('invalid-state', 'Claustrum roster file is not valid');
    const rows = [];
    for (const entry of value.rows) {
        const row = decodeRow(entry);
        if (!row)
            throw new ClaustrumConsumerError('invalid-state', 'Claustrum roster file is not valid');
        rows.push(row);
    }
    const declined = [];
    for (const entry of value.declined) {
        if (!isRecord(entry) ||
            typeof entry.credentialId !== 'string' ||
            !optionalString(entry.accountIdentity))
            throw new ClaustrumConsumerError('invalid-state', 'Claustrum roster file is not valid');
        declined.push(entry);
    }
    const rejected = decodeRejected(value.rejected);
    return {
        version: 1,
        ...(typeof value.view === 'string' && { view: value.view }),
        // A file written before completeness was recorded came from a reply
        // that was used whole, so it reads as complete.
        complete: value.complete !== false,
        ...(rejected && { rejected }),
        rows,
        declined,
    };
}
export async function readVaultRoster(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new ClaustrumConsumerError('invalid-state', 'Claustrum roster file is not valid');
    }
    return decodeRoster(value);
}
const WRITE_LOCK = {
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    timeoutMs: 5_000,
};
const DISCOVERY_LEASE = { name: 'claustrum-roster', ttlMs: 30_000 };
/**
 * Read, change and write the roster under its write lock. `change` returns
 * undefined to leave the file as it is. Call `assertOwned()` immediately
 * before any rename performed inside `change`; if it throws, do not rename.
 */
export async function mutateVaultRoster(path, change, options = {}) {
    return withLock(path, WRITE_LOCK, async (lock) => {
        const current = await readVaultRoster(path);
        const { next, result } = await change(current, {
            assertOwned: () => lock.assertOwned(),
        });
        if (next) {
            await lock.assertOwned();
            // Staging the file takes several awaited steps; check both the caller's
            // lease and this lock again at the last moment before the rename.
            await writeJsonAtomic(path, next, {
                beforeRename: async () => {
                    await options.beforePublish?.();
                    await lock.assertOwned();
                },
            });
        }
        return result;
    });
}
/** Mark a vault account declined; it stays listed but never routes. */
export function declineVaultRoute(path, routeId) {
    return mutateVaultRoster(path, (current) => {
        const row = current?.rows.find((entry) => entry.routeId === routeId);
        if (!current || !row)
            throw new ClaustrumConsumerError('route-unavailable', 'Claustrum route is not in the roster');
        const declined = declineAccount(current.declined, row.credentialId, row.accountIdentity);
        return {
            next: {
                ...current,
                declined,
                rows: current.rows.map((entry) => entry === row ? { ...entry, enabled: false } : entry),
            },
            result: undefined,
        };
    });
}
/** Lift the user's decline for a vault account and every alias of it. */
export function acceptVaultRoute(path, routeId) {
    return mutateVaultRoster(path, (current) => {
        const row = current?.rows.find((entry) => entry.routeId === routeId);
        if (!current || !row)
            throw new ClaustrumConsumerError('route-unavailable', 'Claustrum route is not in the roster');
        return {
            next: {
                ...current,
                declined: acceptAccount(current.declined, memberIds(row), row.accountIdentity),
                rows: current.rows.map((entry) => entry === row ? { ...entry, enabled: true } : entry),
            },
            result: undefined,
        };
    });
}
/**
 * What a receipt may do to a row's quota: `hold` (the row holds the receipt's
 * credential and account), `bind` (the row has never had a known account and
 * the receipt proves one, so the row takes that account with the reading) or
 * `refuse`.
 */
function receiptFence(row, receipt) {
    if (!memberIds(row).includes(receipt.credentialId))
        return 'refuse';
    // While the vault makes no claim, the roster's own expectation proves
    // nothing about which account the reading came from.
    if (row.unclaimed &&
        (receipt.accountIdentitySource === 'expected' ||
            receipt.accountIdentitySource === 'none'))
        return 'refuse';
    // Equality, never compatibility: a known account on one side does not match
    // an absent one on the other. The only absent-absent match is a row that
    // has never had a known account and a receipt that names none either.
    if (row.accountIdentity === receipt.accountIdentity)
        return 'hold';
    // A row that has never had a known account, reached by a receipt issued for
    // it in that state whose served or parsed identity names an account. The
    // reading belongs to that account, so keeping it without the account would
    // let the next list that names a different account inherit it as if that
    // account had been learned for the first time. The row takes the account
    // with the reading instead: a later list naming another account is then a
    // known replacement and inherits nothing. Only a single-credential row is
    // bound, since one credential's account says nothing about the others.
    if (row.accountIdentity === undefined &&
        receipt.expectedAccountIdentity === undefined &&
        receipt.accountIdentity !== undefined &&
        (receipt.accountIdentitySource === 'asserted' ||
            receipt.accountIdentitySource === 'parsed') &&
        memberIds(row).length === 1)
        return 'bind';
    return 'refuse';
}
/**
 * Merge a quota observation into a vault row through `/quota`'s merge. The
 * write is fenced on the receipt the reading was taken with: it lands only
 * while the row still holds that receipt's credential (as representative or
 * alias) and account, so a slow read for a replaced account can never land on
 * its successor. Returns whether the observation was kept.
 */
export function recordVaultQuota(path, input) {
    return mutateVaultRoster(path, (current) => {
        const row = current?.rows.find((entry) => entry.routeId === input.routeId);
        const fence = !current || !row ? 'refuse' : receiptFence(row, input);
        if (!current || !row || fence === 'refuse')
            return { result: false };
        const quota = mergeQuotaObservation(row.quota, input.observation);
        // A bound account is `unclaimed`: the vault's list has not named it, and
        // the next projection keeps it as the account this credential last
        // logged into until the vault names one.
        const bound = fence === 'bind'
            ? { accountIdentity: input.accountIdentity, unclaimed: true }
            : {};
        return {
            next: {
                ...current,
                rows: current.rows.map((entry) => entry === row ? { ...entry, ...bound, quota } : entry),
            },
            result: true,
        };
    });
}
/**
 * Discover and commit the roster. The lease covers the list call and the
 * commit, not just the write: an opaque view cannot tell a delayed old reply
 * from a newer one, so a run that lost its lease is refused at commit. A
 * failed list, or custody switching off mid-run, never writes anything; a
 * peer holding the lease means its last committed roster is served instead.
 */
export async function refreshVaultRoster(options) {
    options.signal?.throwIfAborted();
    const active = async () => (await options.isActive?.()) ?? true;
    if (!(await active()))
        return undefined;
    const lease = await acquireRefreshFileLock({
        ...DISCOVERY_LEASE,
        path: options.path,
        renew: true,
    });
    if (!lease) {
        const persisted = await readVaultRoster(options.path);
        options.signal?.throwIfAborted();
        if (!persisted?.view)
            throw new ClaustrumConsumerError('roster-busy', 'Claustrum account discovery is already in progress');
        return persisted;
    }
    try {
        const inventory = await options.custody.discover(options.signal);
        options.signal?.throwIfAborted();
        return await mutateVaultRoster(options.path, async (current) => {
            if (!(await active()))
                return { result: undefined };
            options.signal?.throwIfAborted();
            await lease.assertOwned();
            const projection = typeof options.projection === 'function'
                ? options.projection()
                : options.projection;
            const next = projectVaultRoster(current, inventory, projection);
            const changed = JSON.stringify(current) !== JSON.stringify(next);
            return { ...(changed && { next }), result: next };
        });
    }
    finally {
        await lease.release();
    }
}
/**
 * The seam for a plugin that keeps a main account: one fixed account the host
 * owns under a logical route, outside the pool's rotating rows. The library
 * has no main convention of its own: the plugin names the
 * vault record that holds the role (`primaryCredentialId`) and its logical
 * route. Main follows the account that record claims; another credential of
 * that same account may serve it when the record itself is not active, but a
 * credential of any other account is never promoted into main.
 *
 * Inputs are the plugin's filtered inventory, whether that inventory is
 * complete (defaults to the reply having no unusable records; pass the
 * roster's `complete` or false to override), the previous verified binding
 * and, on the request path, the account the chosen request expects.
 */
export function resolveVaultPrimary(input) {
    const { inventory, previous } = input;
    const unavailable = (reason) => ({
        status: 'unavailable',
        reason,
        ...(previous && { lastVerified: previous }),
    });
    const record = inventory.credentials.find((credential) => credential.credentialId === input.primaryCredentialId);
    if (!record) {
        if (inventory.skipped.some((skipped) => skipped.credentialId === input.primaryCredentialId))
            return unavailable('malformed');
        // A rejected record without a usable id could be the primary record.
        const incomplete = input.complete === false ||
            inventory.skipped.some((skipped) => skipped.credentialId === undefined);
        return incomplete ? unavailable('incomplete') : { status: 'absent' };
    }
    const identity = record.accountIdentity;
    if (identity === undefined)
        return unavailable('unclaimed');
    if (input.expectedAccountIdentity !== undefined &&
        input.expectedAccountIdentity !== identity)
        return unavailable('identity-changed');
    const representative = record.state === 'active'
        ? record
        : (inventory.credentials
            .filter((credential) => credential.accountIdentity === identity &&
            credential.state === 'active')
            .toSorted((left, right) => left.credentialId.localeCompare(right.credentialId))[0] ?? record);
    const binding = {
        routeId: input.routeId,
        credentialId: representative.credentialId,
        accountIdentity: identity,
        view: inventory.view,
    };
    return {
        status: 'ready',
        binding,
        ...(previous &&
            previous.accountIdentity !== identity && { replaced: previous }),
    };
}
