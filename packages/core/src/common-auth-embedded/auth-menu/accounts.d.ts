import { type PoolLockSpec, type PoolRow, type PoolStore, type RemoveOptions } from '../store/index.js';
import { type DoctorCheck } from './doctor.js';
import { type LoginAccount, type MenuLogin } from './login.js';
import { type MenuAction, type MenuOutcome } from './menu.js';
import type { MenuTerminal } from './terminal.js';
/** The reason recorded on a row the menu disables. */
export declare const MENU_DISABLE_REASON = "disabled from the auth menu";
export interface AccountMenuOptions {
    /** The menu heading, naming the provider's accounts. */
    title: string;
    store: PoolStore;
    /** Defaults to the current process's terminal. */
    terminal?: MenuTerminal;
    /** The plugin's login. Without it, add and re-authenticate are not offered. */
    login?: MenuLogin;
    /** The id of a new account; defaults to the login's id, else `account-N`. */
    newAccountId?(account: LoginAccount, rows: readonly PoolRow[]): string;
    /**
     * Passed to every removal the menu makes, including delete-all: an id it
     * names a reason for is kept, with both store files untouched for it.
     */
    protect?: RemoveOptions['protect'];
    /** Locks the plugin takes around every row write, passed to the store. */
    extraLocks?: readonly PoolLockSpec[];
    /**
     * Fetches one row's quota as an observation for the store's quota codec
     * (a `/quota` observation when the store was opened with `quotaCodec`).
     * Without it, check quotas prints only what is stored.
     */
    pollQuota?(row: PoolRow): Promise<unknown>;
    /** Checks the doctor runs; without any, the doctor is not offered. */
    doctor?: readonly DoctorCheck[];
    /**
     * True when accounts come from a vault rather than from this machine:
     * the account actions become a read-only listing plus enable/disable,
     * because adding, signing in and removing happen in the vault.
     */
    custody?(): boolean | Promise<boolean>;
    /** Plugin lines shown above the accounts, such as the routing mode. */
    status?(): readonly string[] | Promise<readonly string[]>;
    /** The plugin's own actions, listed before delete-all. */
    extraActions?: readonly MenuAction[];
    /** Recorded on a row the menu disables; defaults to `MENU_DISABLE_REASON`. */
    disableReason?: string;
}
/**
 * Whether the store holds any usable credential. Meant as one half of an
 * `hasCredential` predicate (the other being the host's own slot); a row with
 * no credential does not count, since it gives the menu nothing to manage.
 */
export declare function poolHasCredential(store: PoolStore): Promise<boolean>;
/** Formats a row's stored quota map as one line per window. */
export declare function quotaLines(row: PoolRow): string[];
/** Adds an account through the plugin's login and reports what the store did. */
export declare function addAccountAction(options: AccountMenuOptions): MenuAction;
/**
 * Signs an existing account in again and replaces its credential. A login
 * that comes back as a different provider account is refused: replacing
 * would silently turn the row into another account.
 */
export declare function reauthenticateAction(options: AccountMenuOptions): MenuAction;
/** Removes one account after the operator confirms it by name. */
export declare function removeAccountAction(options: AccountMenuOptions): MenuAction;
/** Disables an enabled account, or enables a disabled one. */
export declare function toggleAccountAction(options: AccountMenuOptions): MenuAction;
/** Prints every account and its state, changing nothing. */
export declare function listAccountsAction(options: AccountMenuOptions): MenuAction;
/**
 * Polls each account's quota once, in order, records each reading through
 * the store (so it lands only on the credential it was taken with), then
 * prints every account's windows from what is stored.
 */
export declare function checkQuotasAction(options: AccountMenuOptions): MenuAction;
/**
 * Removes every account the plugin does not protect. Each removal goes
 * through `store.remove` with the plugin's `protect`, so a protected id is
 * refused under the store's locks and stays, with its files untouched.
 */
export declare function deleteAllAction(options: AccountMenuOptions): MenuAction;
/**
 * The menu's actions for this plugin and mode. Local mode: add,
 * re-authenticate, remove, enable/disable, check quotas, doctor, the
 * plugin's extras, delete all. Custody mode: list, enable/disable, check
 * quotas, doctor and the extras; nothing that adds, signs in or removes.
 */
export declare function accountMenuActions(options: AccountMenuOptions): Promise<MenuAction[]>;
/** Shows the account menu once and runs the chosen action. */
export declare function runAccountMenu(options: AccountMenuOptions): Promise<MenuOutcome>;
