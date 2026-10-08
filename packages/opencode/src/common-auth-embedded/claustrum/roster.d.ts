import { type QuotaMap, type QuotaObservation } from '../quota/index.js';
import type { RoutingRow } from '../routing/index.js';
import type { ClaustrumScopedAttempt, ClaustrumScopedCustody, SkippedVaultRecord, VaultCredential, VaultCredentialType, VaultInventory } from './custody.js';
import { type DeclinedAccount } from './interlock.js';
/**
 * One vault account as the pool sees it. It carries no bearer material: the
 * access token is fetched from the vault for every send. Several vault
 * records logged into the same provider account collapse into one row, so
 * duplicate logins never count as extra quota.
 */
export interface VaultRosterRow {
    routeId: string;
    credentialId: string;
    credentialType: VaultCredentialType;
    accountIdentity?: string;
    /** Other credential ids logged into the same provider account. */
    aliases?: string[];
    state: string;
    label: string;
    email?: string;
    orgName?: string;
    enabled: boolean;
    addedAt: number;
    quota?: QuotaMap;
    /**
     * The vault listed this record in a form this consumer could not use, so the
     * row is the last good projection kept as it was rather than dropped.
     */
    stale?: true;
    /**
     * The vault's latest list named no account for `credentialId`, so
     * `accountIdentity` is the last account that credential was known to log
     * into, kept until the vault names one again. It proves neither that the
     * credential still logs into that account nor that it changed accounts.
     */
    unclaimed?: true;
}
export interface VaultRosterFile {
    version: 1;
    view?: string;
    /**
     * False when the vault's reply carried records this consumer could not use.
     * An incomplete reply never removes an account it may still hold: every
     * previous member it does not account for is kept.
     */
    complete: boolean;
    /** The unusable records of an incomplete reply: a safe id and a fixed reason. */
    rejected?: SkippedVaultRecord[];
    rows: VaultRosterRow[];
    declined: DeclinedAccount[];
}
/** How a vault credential is presented in the pool. */
export type AccountMapper = (credential: VaultCredential) => {
    label?: string;
};
export interface ProjectionOptions {
    /** Ids already used by local rows; a vault route never takes one. */
    reservedRouteIds?: ReadonlySet<string>;
    /** Prefix for vault route ids, so they read differently from local ids. */
    routePrefix?: string;
    mapAccount?: AccountMapper;
    now?: number;
}
export declare const DEFAULT_ROUTE_PREFIX = "vault:";
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
export declare function projectVaultRoster(previous: VaultRosterFile | undefined, inventory: VaultInventory, options?: ProjectionOptions): VaultRosterFile;
/**
 * The rows `/routing` selects among. Only enabled, active accounts route;
 * a declined or cold vault account stays listed for the menu but never
 * reaches admission.
 */
export declare function vaultRoutingRows(roster: VaultRosterFile | undefined): RoutingRow[];
export declare function readVaultRoster(path: string): Promise<VaultRosterFile | undefined>;
/** The ownership assertion available to a roster mutation callback. */
export interface VaultRosterLockContext {
    assertOwned: () => Promise<void>;
}
export interface MutateVaultRosterOptions {
    /**
     * Runs when the new roster is fully staged on disk, immediately before the
     * rename that publishes it, so a caller can confirm a lease of its own at
     * the moment of publication rather than when `change` returned. If it
     * throws, nothing is published and the staged file is removed. The
     * roster's own write lock is reasserted right after it.
     */
    beforePublish?: () => Promise<void>;
}
/**
 * Read, change and write the roster under its write lock. `change` returns
 * undefined to leave the file as it is. Call `assertOwned()` immediately
 * before any rename performed inside `change`; if it throws, do not rename.
 */
export declare function mutateVaultRoster<T>(path: string, change: (current: VaultRosterFile | undefined, context: VaultRosterLockContext) => Promise<{
    next?: VaultRosterFile;
    result: T;
}> | {
    next?: VaultRosterFile;
    result: T;
}, options?: MutateVaultRosterOptions): Promise<T>;
/** Mark a vault account declined; it stays listed but never routes. */
export declare function declineVaultRoute(path: string, routeId: string): Promise<undefined>;
/** Lift the user's decline for a vault account and every alias of it. */
export declare function acceptVaultRoute(path: string, routeId: string): Promise<undefined>;
/**
 * The receipt fields a quota or profile observation must carry to say which
 * send (credential and account) it came from. Pass the
 * `ClaustrumScopedAttempt` that send was authorized with.
 */
export type QuotaReceipt = Pick<ClaustrumScopedAttempt, 'credentialId' | 'accountIdentity' | 'accountIdentitySource' | 'expectedAccountIdentity'>;
/**
 * Merge a quota observation into a vault row through `/quota`'s merge. The
 * write is fenced on the receipt the reading was taken with: it lands only
 * while the row still holds that receipt's credential (as representative or
 * alias) and account, so a slow read for a replaced account can never land on
 * its successor. Returns whether the observation was kept.
 */
export declare function recordVaultQuota(path: string, input: QuotaReceipt & {
    routeId: string;
    observation: QuotaObservation;
}): Promise<boolean>;
/**
 * Discover and commit the roster. The lease covers the list call and the
 * commit, not just the write: an opaque view cannot tell a delayed old reply
 * from a newer one, so a run that lost its lease is refused at commit. A
 * failed list, or custody switching off mid-run, never writes anything; a
 * peer holding the lease means its last committed roster is served instead.
 */
export declare function refreshVaultRoster(options: {
    path: string;
    custody: Pick<ClaustrumScopedCustody, 'discover'>;
    isActive?: () => boolean | Promise<boolean>;
    signal?: AbortSignal;
    projection?: ProjectionOptions | (() => ProjectionOptions);
}): Promise<VaultRosterFile | undefined>;
/**
 * A host-owned main account as last verified from the vault: the plugin's
 * logical route, the credential that serves it and the account it logs into.
 */
export interface VaultPrimaryBinding {
    routeId: string;
    credentialId: string;
    accountIdentity: string;
    view: string;
}
export type VaultPrimaryUnavailableReason = 'malformed' | 'unclaimed' | 'incomplete' | 'identity-changed';
export type VaultPrimary = 
/**
 * Main is bound. `replaced` is the previous binding when it named a
 * different account: everything owned by that account (quota, profile,
 * backoff, cache affinity) must be dropped, and outstanding observations
 * for it fenced, even though the logical route stays the same.
 */
{
    status: 'ready';
    binding: VaultPrimaryBinding;
    replaced?: VaultPrimaryBinding;
}
/** A complete reply lists no primary record: there is no main. */
 | {
    status: 'absent';
}
/**
 * The reply cannot say who main is. Not the same as absent: the last
 * verified binding is handed back untouched, and serving it still needs a
 * fresh receipt that matches it.
 */
 | {
    status: 'unavailable';
    reason: VaultPrimaryUnavailableReason;
    lastVerified?: VaultPrimaryBinding;
};
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
export declare function resolveVaultPrimary(input: {
    inventory: VaultInventory;
    complete?: boolean;
    previous?: VaultPrimaryBinding;
    expectedAccountIdentity?: string;
    primaryCredentialId: string;
    routeId: string;
}): VaultPrimary;
