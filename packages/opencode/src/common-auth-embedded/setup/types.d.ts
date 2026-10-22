import type { MenuTerminal } from '../auth-menu/terminal.js';
import type { ClaustrumEnrollmentConnection, hostEnrollmentPaths } from '../claustrum/index.js';
export type SetupHost = 'opencode' | 'pi';
export type OpenCodeGeneration = '1' | '2' | 'both';
export type SetupEnvironment = Record<string, string | undefined>;
/**
 * What a setup run recorded about one host's vault enrollment when it failed:
 * `enrolled` once approval landed and the token was written, `not-enrolled`
 * when the host was never asked or its enrollment was refused or gave up
 * waiting, and `unknown` when setup failed while the enrollment was still in
 * flight and the host's token file could not settle it.
 */
export type SetupEnrollmentOutcome = 'enrolled' | 'not-enrolled' | 'unknown';
export interface SetupHostEnrollment {
    host: SetupHost;
    outcome: SetupEnrollmentOutcome;
}
/**
 * What setup decided before calling a plugin callback. The OpenCode generation
 * is the one being registered, after `--opencode` or the interactive choice, so
 * a plugin can sign in the way that generation expects (OpenCode 2 does not
 * read OpenCode 1's login file).
 */
export interface SetupCallbackContext {
    opencodeGeneration: OpenCodeGeneration;
    mode: 'local' | 'claustrum';
    /**
     * Every host this run sets up, in order, so the first `beforeSignIn` can
     * check conditions across all of them (for example that their storage paths
     * do not overlap) before any host is changed.
     */
    hosts: readonly SetupHost[];
    /**
     * Pi's agent folder, resolved the way Pi itself does (`PI_CODING_AGENT_DIR`,
     * with `~` expanded, else `~/.pi/agent`). Pi's own `auth.json` lives here;
     * use it rather than a plugin path setting, which can point elsewhere.
     */
    piAgentDir: string;
}
/** Provider login, credential migration and vault activation stay in plugin callbacks. */
export interface SetupPlugin {
    packages: {
        opencode: string;
        pi: string;
    };
    version: string;
    displayName: string;
    slashCommand: string;
    vault: {
        connectionFile: string;
        hosts: Record<SetupHost, {
            name: string;
            paths: Parameters<typeof hostEnrollmentPaths>[0];
        }>;
    };
    /**
     * Runs for each host on a real run after the host, mode and generation are
     * chosen and before the vault ceremony or `signInLocal`, while nothing has
     * changed yet. Rejecting stops setup for that host, so a plugin can ask for
     * consent or check preconditions before any credential or authority change.
     */
    beforeSignIn?(host: SetupHost, context: SetupCallbackContext): Promise<void>;
    signInLocal(host: SetupHost, context: SetupCallbackContext): Promise<void>;
    migrate(host: SetupHost, context: SetupCallbackContext): Promise<void>;
    /** Reject mixed local/vault credentials and activate provider-specific vault access before registration. */
    beforeRegister?(host: SetupHost, mode: 'local' | 'claustrum', context: SetupCallbackContext): Promise<void>;
}
export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    spawnError?: boolean;
    stderrTruncated?: boolean;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    durationMs?: number;
}
export interface CommandRunner {
    run(file: string, args: readonly string[], options?: {
        env?: SetupEnvironment;
        timeoutMs?: number;
        windowsVerbatimArguments?: boolean;
    }): Promise<CommandResult>;
}
export interface SetupFileSystem {
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    isExecutable(path: string): boolean;
    readText(path: string): string;
    realpath(path: string): string;
}
export interface ProcessFence {
    listRunningHosts(env?: SetupEnvironment): Promise<Array<{
        pid: number;
        command: string;
    }>>;
    /**
     * For a dry run, which must change nothing: the hosts found without starting
     * any program that writes files. On Windows that skips the PowerShell query
     * for Node and Bun command lines (PowerShell writes a startup cache into the
     * user's profile), so Node or Bun processes are only counted. A fence without
     * it is previewed with `listRunningHosts`.
     */
    previewRunningHosts?(env?: SetupEnvironment): Promise<{
        hosts: Array<{
            pid: number;
            command: string;
        }>;
        uncheckedRuntimes: number;
    }>;
}
/** Defaults use the process terminal and environment; overrides are test seams. */
export interface SetupIO {
    terminal?: MenuTerminal;
    env?: SetupEnvironment;
    platform?: string;
    home?: string;
    cwd?: string;
    fs?: SetupFileSystem;
    runner?: CommandRunner;
    fence?: ProcessFence;
    connect?: (options: {
        connectionFile: string;
        handshakeTimeoutMs: number;
    }) => Promise<ClaustrumEnrollmentConnection>;
    wait?: (ms: number) => Promise<void>;
    /**
     * Monotonic milliseconds that bound the enrollment wait. Defaults to
     * `performance.now`; tests pair it with `wait` to run a fake clock.
     */
    now?: () => number;
}
export interface HostDetection {
    installed: boolean;
    executable: string | null;
    version: string | null;
    directory: string;
}
export interface SetupDetection {
    opencode: HostDetection & {
        generation: '1' | '2' | 'ambiguous';
    };
    pi: HostDetection;
    claustrum: {
        available: boolean;
        executable: string | null;
    };
}
export interface SetupResult {
    hosts: SetupHost[];
    dryRun: boolean;
    mode: 'local' | 'claustrum';
    detection: SetupDetection;
}
