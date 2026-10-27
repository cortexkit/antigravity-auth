import type { OpenCodeGeneration, SetupHost } from './types.js';
export declare const UNAVAILABLE_HOST_MESSAGE = "Requested setup host is unknown or unavailable. Use --host=opencode or --host=pi with a detected host.";
type SwitchKey = 'yes' | 'dryRun' | 'claustrum' | 'noClaustrum' | 'login' | 'enrollOnly';
/**
 * One flag the shared setup parser accepts. A switch sets `key` to true; a
 * value flag takes one of `values` as `--name=value`, and also as the next
 * argument (`--name value`) when `spaceForm` is set. `invalid` replaces the
 * unknown-argument refusal when a value flag gets a value it does not accept.
 */
export type SetupFlag = {
    name: string;
    key: SwitchKey;
    description: string;
} | {
    name: string;
    key: 'hosts' | 'opencode';
    values: readonly string[];
    spaceForm?: boolean;
    invalid?: string;
    description: string;
};
/**
 * Every flag `runSetup` accepts. The parser and `setupUsage` both read this
 * table, so the help a plugin prints cannot list a flag the parser refuses or
 * leave out one it accepts.
 */
export declare const SETUP_FLAGS: readonly SetupFlag[];
export interface SetupFlags {
    yes: boolean;
    dryRun: boolean;
    claustrum: boolean;
    noClaustrum: boolean;
    login: boolean;
    enrollOnly: boolean;
    hosts: SetupHost[];
    opencode: OpenCodeGeneration | undefined;
}
/** Parse setup's arguments against `SETUP_FLAGS`, refusing anything else. */
export declare function parseSetupFlags(argv: readonly string[]): SetupFlags;
/**
 * The flags `runSetup` accepts, one per line, for a plugin's `setup --help`.
 * The shared parser has no `--help` of its own: the plugin's bin checks for
 * `--help` or `-h` before calling `runSetup`, prints this text and any lines of
 * its own, and exits 0. With `command` the text starts with a usage line, such
 * as `Usage: example-auth setup [flags]`.
 */
export declare function setupUsage(options?: {
    command?: string;
}): string;
export {};
