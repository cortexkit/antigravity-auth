/** The inputs the CLI passes to `authorize`; the TUI passes none. */
export type AuthorizeInputs = Record<string, string>;
/** The automatic-method result OpenCode v1 awaits after `authorize`. */
export interface MenuCompletedResult {
    url: '';
    instructions: '';
    method: 'auto';
    callback(): Promise<{
        type: 'failed';
    }>;
}
/**
 * The result to hand back after the menu has run, whatever the action did.
 *
 * The host's result type has no top-level "done, store nothing": every
 * result ends in a callback whose success the host files as the provider's
 * own credential. An account added, re-authenticated or repaired from the
 * menu is already stored by the plugin, and storing it again in the host's
 * slot would make an extra account the provider's main credential. A failed
 * callback is the only result that stores nothing, so the operator sees
 * "Failed to authorize" after every menu action; that line is expected.
 */
export declare function menuCompletedResult(): MenuCompletedResult;
/** Whether `authorize` was called by `opencode auth login` rather than the TUI. */
export declare function isCliAuthorize(inputs: AuthorizeInputs | undefined): inputs is AuthorizeInputs;
export interface MenuAuthorizeOptions<R> {
    /**
     * Whether this machine is past its first sign-in: a real credential exists,
     * in the host's slot or in the plugin's store.
     *
     * Do not answer "the account roster is not empty". The signed-in account
     * is usually the only one there is and may not be a roster row, so a
     * roster check hides the menu from exactly the operator who came to add
     * their first extra account, and on a headless machine leaves them no way
     * to do it.
     */
    hasCredential(): boolean | Promise<boolean>;
    /** Shows the menu and runs the chosen action. */
    openMenu(inputs: AuthorizeInputs): Promise<unknown>;
    /** The plugin's normal login, used by the TUI and by a first CLI login. */
    login(inputs?: AuthorizeInputs): Promise<R>;
}
/**
 * Builds an OAuth method's `authorize`: the TUI and a first CLI login get
 * the plugin's normal login; a CLI login on a machine with a credential gets
 * the menu, then the failed result described at `menuCompletedResult`. The
 * TUI path never runs `hasCredential`, so it reads nothing it did not before.
 */
export declare function menuAuthorize<R>(options: MenuAuthorizeOptions<R>): (inputs?: AuthorizeInputs) => Promise<R | MenuCompletedResult>;
