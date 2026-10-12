import { execFileSync as defaultExecFileSync, spawn as defaultSpawn, } from 'node:child_process';
/** Opens a URL with the platform's opener; false when that fails. */
export function openBrowserForMenu(url, platform = process.platform, execFileSync = defaultExecFileSync, spawn = defaultSpawn) {
    try {
        if (platform === 'win32') {
            // Start-Process opens the URL with its associated app. Base64 UTF-16LE
            // keeps cmd from parsing the URL; Microsoft documents both options:
            // https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-7.5
            // https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1#-encodedcommand-base64encodedcommand
            // PowerShell is launched without waiting for it: a cold Windows
            // PowerShell start took about 6 s on a Windows Server 2022 runner, and a
            // waiting caller with a short timeout killed it before the browser
            // opened. It is not detached: a detached PowerShell has no console and
            // never ran the command on any Windows runner.
            const command = `Start-Process '${url.replaceAll("'", "''")}'`;
            const child = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-WindowStyle',
                'Hidden',
                '-EncodedCommand',
                Buffer.from(command, 'utf16le').toString('base64'),
            ], { stdio: 'ignore', windowsHide: true });
            // A failed launch reports asynchronously; without a listener it would
            // become an uncaught exception after this function has returned.
            child.on('error', () => { });
            child.unref();
            // Node leaves pid undefined when the process could not be started.
            return child.pid !== undefined;
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
