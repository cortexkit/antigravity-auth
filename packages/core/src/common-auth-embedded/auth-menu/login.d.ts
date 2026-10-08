import type { PoolCredential } from '../store/index.js';
import type { MenuContext } from './menu.js';
/** An account a login produced, ready to become a pool row. */
export interface LoginAccount {
    credential: PoolCredential;
    /** The provider's account identity, recorded on the row when known. */
    identity?: string;
    label?: string;
    /** The row id to use for a new account; the menu makes one otherwise. */
    id?: string;
}
/** A started login: where the operator signs in, and its eventual account. */
export interface LoginFlow {
    url: string;
    instructions: string;
    completion: Promise<LoginAccount>;
}
/** The plugin's login, supplied to the menu's add and re-authenticate actions. */
export interface MenuLogin {
    /**
     * Starts a browser login (`headless: false`, abortable through `signal`) or
     * a device-code login (`headless: true`) for a machine without a browser.
     */
    begin(options: {
        headless: boolean;
        signal?: AbortSignal;
    }): Promise<LoginFlow>;
    /**
     * Opens the URL in a browser; false or a throw means no browser could be
     * opened. Defaults to `openBrowserForMenu`.
     */
    openBrowser?(url: string): boolean | undefined | Promise<boolean | undefined>;
}
type BrowserExec = (file: string, args: string[], options: {
    stdio: 'ignore';
    timeout: number;
}) => unknown;
/** Opens a URL with the platform's opener; false when that fails. */
export declare function openBrowserForMenu(url: string, platform?: NodeJS.Platform, execFileSync?: BrowserExec): boolean;
/**
 * Runs a login for the menu: a browser login first and, when no browser can
 * be opened, a device-code login instead, so a headless machine can still
 * add an account. The URL is always printed, so an operator can open it by
 * hand when the opener reports success but nothing appears.
 */
export declare function runMenuLogin(login: MenuLogin, context: MenuContext): Promise<LoginAccount>;
export {};
