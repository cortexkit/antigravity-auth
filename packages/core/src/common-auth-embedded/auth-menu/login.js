import { execFileSync as defaultExecFileSync } from 'node:child_process';
/** Opens a URL with the platform's opener; false when that fails. */
export function openBrowserForMenu(url, platform = process.platform, execFileSync = defaultExecFileSync) {
    try {
        if (platform === 'win32') {
            execFileSync('cmd', ['/c', 'start', '', url], {
                stdio: 'ignore',
                timeout: 3000,
            });
        }
        else {
            execFileSync(platform === 'darwin' ? 'open' : 'xdg-open', [url], {
                stdio: 'ignore',
                timeout: 3000,
            });
        }
        return true;
    }
    catch {
        return false;
    }
}
function printFlow(context, flow) {
    context.print('');
    context.print('Open this URL in your browser and complete sign-in:');
    context.print('');
    context.print(flow.url);
    context.print('');
    if (flow.instructions) {
        context.print(flow.instructions);
        context.print('');
    }
}
/**
 * Runs a login for the menu: a browser login first and, when no browser can
 * be opened, a device-code login instead, so a headless machine can still
 * add an account. The URL is always printed, so an operator can open it by
 * hand when the opener reports success but nothing appears.
 */
export async function runMenuLogin(login, context) {
    const abort = new AbortController();
    let flow = await login.begin({ headless: false, signal: abort.signal });
    // Attached before the opener runs: an opener failure aborts this flow in
    // the same turn, and its rejection must not surface as unhandled.
    void flow.completion.catch(() => { });
    printFlow(context, flow);
    let opened = false;
    try {
        opened =
            (await (login.openBrowser ?? openBrowserForMenu)(flow.url)) !== false;
    }
    catch {
        opened = false;
    }
    if (!opened) {
        abort.abort();
        context.print('Could not open a browser. Switching to device authorization.');
        context.print('');
        flow = await login.begin({ headless: true });
        printFlow(context, flow);
    }
    return flow.completion;
}
