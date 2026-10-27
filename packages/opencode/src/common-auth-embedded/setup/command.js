import { select } from '../auth-menu/select.js';
import { isInteractive, printLine, processTerminal, } from '../auth-menu/terminal.js';
import { enrollmentAuthority, hostEnrollmentPaths, } from '../claustrum/enrollment.js';
import { recordSetupEnrollment, setupEnrollmentLine } from './command-error.js';
import { defaultCommandRunner } from './command-runner.js';
import { detectHosts } from './detect.js';
import { connectSetupHost, HostNotEnrolledError } from './enroll.js';
import { parseSetupFlags, UNAVAILABLE_HOST_MESSAGE } from './flags.js';
import { setupPaths } from './paths.js';
import { assertHostsStopped, createProcessFence, ProcessFenceViolationError, ProcessInspectionError, } from './process-fence.js';
import { selectSetupHosts } from './prompts.js';
import { planOpenCodeRegistration, registerOpenCode, registerPi, } from './register.js';
export const AMBIGUOUS_OPENCODE_MESSAGE = 'Multiple OpenCode generations found. Choose --opencode=1|2|both before running noninteractive setup.';
function validatePlugin(plugin) {
    for (const pkg of Object.values(plugin.packages)) {
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg))
            throw new Error('Setup requires npm package names.');
    }
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(plugin.version))
        throw new Error('Setup requires a concrete package version.');
    for (const host of Object.values(plugin.vault.hosts)) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(host.name))
            throw new Error('Setup requires lowercase vault names containing only letters, digits and dashes.');
    }
}
/**
 * Turn what setup recorded into one outcome per selected host, in setup order.
 * A host setup never reached was never asked to enroll. Only a host whose
 * enrollment was in flight when setup failed is checked on disk, by reading its
 * enrollment files once with `enrollmentAuthority`; if that read fails it stays
 * `unknown`.
 */
async function enrollmentReport(plugin, hosts, recorded) {
    const report = [];
    for (const host of hosts) {
        let outcome = recorded.get(host) ?? 'not-enrolled';
        if (outcome === 'unknown') {
            const { name, paths } = plugin.vault.hosts[host];
            const authority = await enrollmentAuthority(hostEnrollmentPaths(paths), name).catch(() => 'unreadable');
            if (authority === 'vault')
                outcome = 'enrolled';
            else if (authority === 'local')
                outcome = 'not-enrolled';
        }
        report.push({ host, outcome });
    }
    return report;
}
export async function runSetup(plugin, argv = [], io = {}) {
    const options = parseSetupFlags(argv);
    validatePlugin(plugin);
    const terminal = io.terminal ?? processTerminal();
    const detection = await detectHosts(plugin, io);
    printLine(terminal, `${plugin.displayName} setup`);
    for (const [label, host] of [
        ['OpenCode', detection.opencode],
        ['Pi', detection.pi],
    ]) {
        printLine(terminal, `${label}: ${host.installed ? `found (version ${host.version ?? 'unknown'})` : 'not found'} — ${host.directory}`);
    }
    printLine(terminal, `Claustrum: ${detection.claustrum.available ? 'available' : 'not available'}`);
    // Pi is registered by running its CLI, so a leftover Pi folder without the
    // CLI cannot be set up. Leave it out instead of failing the whole run, so it
    // never blocks setting up OpenCode.
    const piWithoutCli = detection.pi.installed && !detection.pi.executable;
    if (piWithoutCli)
        printLine(terminal, 'Pi: skipped, because its folder exists but pi is not on PATH. Install the Pi CLI and rerun setup to add it.');
    const found = ['opencode', 'pi'].filter((host) => detection[host].installed && !(host === 'pi' && piWithoutCli));
    if (options.hosts.some((host) => !found.includes(host)))
        throw new Error(UNAVAILABLE_HOST_MESSAGE);
    // A dry run changes nothing, so without a terminal it plans the --yes path
    // instead of refusing; scripts and CI can preview setup with --dry-run alone.
    const assumeYes = options.yes || (options.dryRun && !isInteractive(terminal));
    if (!assumeYes && !isInteractive(terminal))
        throw new Error('Setup requires a TTY or --yes.');
    const hosts = options.hosts.length
        ? found.filter((host) => options.hosts.includes(host))
        : assumeYes
            ? found
            : ((await selectSetupHosts(terminal, found)) ?? []);
    let generation = options.opencode ??
        (detection.opencode.generation === 'ambiguous'
            ? '1'
            : detection.opencode.generation);
    if (hosts.includes('opencode') &&
        !options.opencode &&
        detection.opencode.generation === 'ambiguous') {
        if (assumeYes || !isInteractive(terminal))
            throw new Error(AMBIGUOUS_OPENCODE_MESSAGE);
        const choice = await select(terminal, [
            { value: '1', label: 'OpenCode 1' },
            { value: '2', label: 'OpenCode 2' },
            { value: 'both', label: 'Both (one compatible registration)' },
        ], { message: 'Which OpenCode generation should be registered?' });
        if (choice === null)
            return { hosts: [], dryRun: options.dryRun, mode: 'local', detection };
        generation = choice;
    }
    if (!hosts.length) {
        printLine(terminal, 'No hosts selected. Install OpenCode or Pi and rerun setup.');
        return { hosts, dryRun: options.dryRun, mode: 'local', detection };
    }
    const { env, platform } = setupPaths(io);
    const fence = io.fence ??
        createProcessFence(io.runner ?? defaultCommandRunner, { platform });
    const stopped = async () => {
        try {
            await assertHostsStopped(fence, env);
        }
        catch (error) {
            if (error instanceof ProcessInspectionError)
                printLine(terminal, error.refusalText);
            throw error;
        }
    };
    printLine(terminal, 'Checking that OpenCode and Pi are not running…');
    if (options.dryRun) {
        try {
            const preview = fence.previewRunningHosts
                ? await fence.previewRunningHosts(env)
                : { hosts: await fence.listRunningHosts(env), uncheckedRuntimes: 0 };
            const active = preview.hosts;
            if (preview.uncheckedRuntimes > 0)
                printLine(terminal, 'Node or Bun programs are running; a real run checks whether any of them is OpenCode or Pi.');
            const names = new Set(new ProcessFenceViolationError(active).activeHosts.map((host) => host.command.toLowerCase() === 'pi' ? 'Pi' : 'OpenCode'));
            for (const name of names)
                printLine(terminal, `${name} is running; setup will ask you to quit it.`);
        }
        catch (error) {
            printLine(terminal, 'Process inspection failed; real setup will require successful inspection and stopped OpenCode/Pi hosts.');
            if (error instanceof ProcessInspectionError)
                printLine(terminal, error.refusalText);
        }
    }
    else
        await stopped();
    if ((options.claustrum || options.enrollOnly) &&
        !detection.claustrum.available)
        throw new Error('Claustrum is not available. Start ck, or omit vault-only flags and use --no-claustrum for local sign-in.');
    let useVault = options.claustrum || options.enrollOnly;
    if (!useVault &&
        !options.login &&
        !options.noClaustrum &&
        !assumeYes &&
        detection.claustrum.available &&
        isInteractive(terminal)) {
        // Not `confirm`: it reads Escape and Ctrl-C as "No", and "No" here means
        // a local sign-in. Cancelling must stop setup before anything changes.
        const choice = await select(terminal, [
            { label: 'No', value: false },
            { label: 'Yes', value: true },
        ], { message: 'Connect these hosts to the Claustrum vault?' });
        if (choice === null) {
            printLine(terminal, 'Setup cancelled. Nothing was changed.');
            return { hosts: [], dryRun: options.dryRun, mode: 'local', detection };
        }
        useVault = choice === true;
    }
    const mode = useVault ? 'claustrum' : 'local';
    // Validate configs before changing credentials; enrollment-only needs no registration plan.
    const writes = !options.enrollOnly && hosts.includes('opencode')
        ? planOpenCodeRegistration(plugin, generation, io)
        : [];
    for (const write of writes) {
        for (const entry of write.existingLocalEntries ?? [])
            printLine(terminal, `OpenCode: already registered from ${entry} in ${write.path}.`);
        const entries = [
            ...(write.existingLocalEntries ?? []),
            ...(write.existingNpmEntries ?? []),
        ];
        if (entries.length > 1)
            printLine(terminal, `Warning: ${plugin.displayName} may load twice in ${write.path}: ${entries.join(', ')}. Entries were left unchanged.`);
    }
    if (options.dryRun) {
        printLine(terminal, 'Dry run: no registrations, enrollment, sign-in or migration will be performed.');
        for (const host of hosts) {
            if (plugin.beforeSignIn)
                printLine(terminal, `Would run beforeSignIn(${host}, ${mode}).`);
            if (useVault) {
                const paths = hostEnrollmentPaths(plugin.vault.hosts[host].paths);
                printLine(terminal, `Would Connect ${host}: write ${paths.statePath} and ${paths.tokenPath}; wait for ck auth enroll approve.`);
            }
            else
                printLine(terminal, `Would sign in locally for ${host}.`);
            if (!options.enrollOnly && plugin.beforeRegister)
                printLine(terminal, `Would run beforeRegister(${host}, ${mode}).`);
        }
        for (const write of writes)
            printLine(terminal, `${write.changed ? 'Would write' : 'Unchanged'} ${write.path}:\n${write.content}`);
        if (!options.enrollOnly && hosts.includes('pi'))
            printLine(terminal, `Would run ${detection.pi.executable} install npm:${plugin.packages.pi}@${plugin.version}`);
        if (!options.enrollOnly && plugin.migrate)
            for (const host of hosts)
                printLine(terminal, `Would migrate ${host} using the plugin callback (provider-specific writes).`);
    }
    else {
        const context = {
            opencodeGeneration: generation,
            mode,
            hosts: Object.freeze([...hosts]),
            piAgentDir: detection.pi.directory,
        };
        // Each host's vault enrollment as it happens. A host the operator approved
        // stays enrolled if a later step fails, so a failure reports this record.
        const enrollment = new Map();
        try {
            for (const host of hosts) {
                await stopped();
                await plugin.beforeSignIn?.(host, context);
                await stopped();
                if (useVault) {
                    enrollment.set(host, 'unknown');
                    try {
                        await connectSetupHost(plugin, host, io, terminal, stopped);
                    }
                    catch (error) {
                        if (error instanceof HostNotEnrolledError)
                            enrollment.set(host, 'not-enrolled');
                        throw error;
                    }
                    enrollment.set(host, 'enrolled');
                }
                else
                    await plugin.signInLocal(host, context);
                await stopped();
                if (options.enrollOnly)
                    continue;
                await plugin.beforeRegister?.(host, mode, context);
                await stopped();
                if (host === 'opencode')
                    await registerOpenCode(writes, stopped);
                else
                    await registerPi(plugin, detection.pi.executable, io);
                await stopped();
                await plugin.migrate?.(host, context);
            }
        }
        catch (error) {
            // Before any enrollment began nothing is connected: nothing to report.
            if (enrollment.size === 0)
                throw error;
            // A host the operator approved stays enrolled after a later step fails.
            // Print which hosts are connected and record it for `setupEnrollment`,
            // then rethrow the original value untouched. Reporting must never
            // replace the failure, so its own errors are ignored.
            try {
                const report = await enrollmentReport(plugin, hosts, enrollment);
                recordSetupEnrollment(error, report);
                for (const entry of report)
                    printLine(terminal, setupEnrollmentLine(entry));
            }
            catch { }
            throw error;
        }
    }
    printLine(terminal, `${options.dryRun ? 'Planned' : options.enrollOnly ? 'Enrolled' : 'Configured'} ${plugin.displayName} for ${hosts.join(', ')} (${mode}).`);
    if (options.enrollOnly) {
        printLine(terminal, `Enroll-only: no host config or plugin registration ${options.dryRun ? 'will be' : 'was'} written.`);
        printLine(terminal, 'Next: register the plugin yourself in each selected host and enable vault access as required by the plugin.');
    }
    else
        printLine(terminal, `Next: ${hosts.includes('opencode') ? 'start OpenCode' : 'start Pi'} and run ${plugin.slashCommand}.`);
    return { hosts, dryRun: options.dryRun, mode, detection };
}
