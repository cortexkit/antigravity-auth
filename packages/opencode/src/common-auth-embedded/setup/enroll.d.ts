import { type MenuTerminal } from '../auth-menu/terminal.js';
import type { SetupHost, SetupIO, SetupPlugin } from './types.js';
/** Fixed text: no version, host or account detail, so it is safe to print anywhere. */
export declare const UNSUPPORTED_VAULT_MESSAGE = "This Claustrum vault is too old to connect plugins. Run ck upgrade to move to Claustrum v0.2.0 or newer (read \"Upgrading from v0.1.3\" in its release notes first), or run setup without --claustrum to use local accounts.";
/**
 * The longest setup waits, in total, for the vault to create the enrollment
 * request and for an operator to approve it. It matches the wait setup always
 * had (300 one-second polls), but is now measured on the clock: a vault that
 * answers each request slowly can no longer stretch it.
 */
export declare const ENROLLMENT_WAIT_MS = 300000;
/** Why a host's enrollment ended without a token. */
export type HostNotEnrolledReason = 'connection-failed' | 'unsupported-vault' | 'request-not-created' | 'approval-pending' | 'refused' | 'invalid-request' | 'incomplete';
/**
 * Thrown when the enrollment ended without writing the host's token: the vault
 * could not be reached, it cannot enroll plugins, it refused the request, it
 * never created one, approval never came before setup stopped waiting, or
 * the enrollment failed in some other way (`incomplete`).
 * Setup can then report the host as not connected without reading its files.
 * The message is fixed text built only from vetted values, never from what
 * the vault or client threw. `lastErrorCode` is the last enrollment error code
 * setup saw, from the vault or from the client's transport (for example
 * `transport_error`), for diagnostics; it carries no secret.
 */
export declare class HostNotEnrolledError extends Error {
    readonly reason: HostNotEnrolledReason;
    readonly lastErrorCode?: string;
    constructor(message: string, details: {
        reason: HostNotEnrolledReason;
        lastErrorCode?: string;
    });
}
/** Enroll an independently revocable host; plugin callbacks choose its credential store and account permissions. */
export declare function connectSetupHost(plugin: SetupPlugin, host: SetupHost, io: SetupIO, terminal: MenuTerminal, fence: () => Promise<void>): Promise<void>;
