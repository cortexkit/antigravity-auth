// The OpenCode v1 side of the account menu.
//
// `opencode auth login` calls an OAuth method's `authorize(inputs?)` and then
// awaits the returned result's `callback()`; a success there is stored as the
// provider's credential. `inputs` is passed only by the CLI, never by the TUI,
// which is what lets the CLI path open a menu while the TUI keeps signing in
// as before. The types here are structural copies of the host's
// `AuthOAuthResult` so the library does not depend on the host's package.
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
export function menuCompletedResult() {
    return {
        url: '',
        instructions: '',
        method: 'auto',
        callback: async () => ({ type: 'failed' }),
    };
}
/** Whether `authorize` was called by `opencode auth login` rather than the TUI. */
export function isCliAuthorize(inputs) {
    return inputs !== undefined;
}
/**
 * Builds an OAuth method's `authorize`: the TUI and a first CLI login get
 * the plugin's normal login; a CLI login on a machine with a credential gets
 * the menu, then the failed result described at `menuCompletedResult`. The
 * TUI path never runs `hasCredential`, so it reads nothing it did not before.
 */
export function menuAuthorize(options) {
    return async (inputs) => {
        if (!isCliAuthorize(inputs))
            return options.login();
        if (!(await options.hasCredential()))
            return options.login(inputs);
        await options.openMenu(inputs);
        return menuCompletedResult();
    };
}
