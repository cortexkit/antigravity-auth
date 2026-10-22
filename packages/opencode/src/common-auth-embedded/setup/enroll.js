import { setTimeout as delay } from 'node:timers/promises';
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client';
import { printLine } from '../auth-menu/terminal.js';
import { ClaustrumEnrollmentManager, connectClaustrumEnrollmentClient, hostEnrollmentPaths, UNSUPPORTED_ENROLLMENT_CODE, } from '../claustrum/enrollment.js';
import { ProcessFenceViolationError, ProcessInspectionError, } from './process-fence.js';
const ENROLLMENT_INCOMPLETE_MESSAGE = 'Claustrum enrollment did not complete. Inspect and approve with ck, then rerun setup.';
/** Fixed text: no version, host or account detail, so it is safe to print anywhere. */
export const UNSUPPORTED_VAULT_MESSAGE = 'This Claustrum vault does not support connecting plugins yet, so setup cannot connect to it. Run setup without --claustrum to use local accounts.';
/**
 * The longest setup waits, in total, for the vault to create the enrollment
 * request and for an operator to approve it. It matches the wait setup always
 * had (300 one-second polls), but is now measured on the clock: a vault that
 * answers each request slowly can no longer stretch it.
 */
export const ENROLLMENT_WAIT_MS = 300_000;
/** The pause between polls while a created request waits for approval. */
const APPROVAL_POLL_MS = 1000;
/**
 * Pauses between proposals the vault failed to accept for a reason worth
 * retrying; the last value repeats until the overall wait runs out.
 */
const PROPOSE_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
/** Vault codes are short snake_case words; anything else is shown as `unknown`. */
function safeCode(code) {
    return code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unknown';
}
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
export class HostNotEnrolledError extends Error {
    reason;
    lastErrorCode;
    constructor(message, details) {
        super(message);
        this.name = 'HostNotEnrolledError';
        this.reason = details.reason;
        if (details.lastErrorCode !== undefined)
            this.lastErrorCode = safeCode(details.lastErrorCode);
    }
}
function approveCommand(requestId, name) {
    return `ck auth enroll approve --request-id ${requestId} --name ${name}`;
}
/** Enroll an independently revocable host; plugin callbacks choose its credential store and account permissions. */
export async function connectSetupHost(plugin, host, io, terminal, fence) {
    const { name, paths: input } = plugin.vault.hosts[host];
    const paths = hostEnrollmentPaths(input);
    await fence();
    const client = await (io.connect ?? connectClaustrumEnrollmentClient)({
        connectionFile: plugin.vault.connectionFile,
        handshakeTimeoutMs: 2000,
    }).catch(() => {
        throw new HostNotEnrolledError('Claustrum connection failed; start ck and rerun setup.', { reason: 'connection-failed' });
    });
    const now = io.now ?? (() => performance.now());
    const wait = io.wait ?? delay;
    try {
        const manager = new ClaustrumEnrollmentManager({
            proposedName: name,
            paths,
            // Each tick of the wait below checks the fence once, just before
            // reconcile proposes or polls. Checking again inside every vault call
            // doubled the process listings per tick, and on Windows each listing
            // starts PowerShell.
            client,
            writeTokenFile: async (path, file) => {
                // Writing the token is what connects the host: check once more.
                await fence();
                await writeEnrollmentTokenFile(path, file);
            },
        });
        printLine(terminal, `Asking the vault to connect ${name}…`);
        const deadline = now() + ENROLLMENT_WAIT_MS;
        let printedRequest;
        let lastCode;
        let reportedCode;
        let failedProposals = 0;
        for (;;) {
            await fence();
            const status = await manager.reconcile();
            if (status.state === 'approved') {
                printLine(terminal, `Connected ${host} to Claustrum.`);
                return;
            }
            if (status.state === 'unavailable' &&
                status.code === UNSUPPORTED_ENROLLMENT_CODE)
                throw new HostNotEnrolledError(UNSUPPORTED_VAULT_MESSAGE, {
                    reason: 'unsupported-vault',
                    lastErrorCode: status.code,
                });
            if (status.state !== 'pending' && status.state !== 'busy')
                throw new HostNotEnrolledError('Claustrum enrollment refused; inspect its status with ck before rerunning setup.', {
                    reason: 'refused',
                    ...('code' in status && { lastErrorCode: status.code }),
                });
            let pause = APPROVAL_POLL_MS;
            if (status.state === 'busy')
                lastCode = 'busy';
            else if (status.retryCode)
                lastCode = status.retryCode;
            if (status.state === 'pending' && status.requestId) {
                failedProposals = 0;
                if (status.requestId !== printedRequest) {
                    if (!/^[a-zA-Z0-9_-]+$/.test(status.requestId))
                        throw new HostNotEnrolledError('Invalid enrollment request id.', {
                            reason: 'invalid-request',
                        });
                    printedRequest = status.requestId;
                    printLine(terminal, 'Waiting for approval. In another terminal, run:');
                    printLine(terminal, `  ${approveCommand(status.requestId, name)}`);
                    printLine(terminal, `Enrollment files: ${paths.statePath}, ${paths.tokenPath}`);
                }
            }
            else if (status.state === 'pending' && status.retryCode) {
                // No request id came back. Back off instead of asking
                // again every second, and say so once per distinct code.
                pause =
                    PROPOSE_BACKOFF_MS[Math.min(failedProposals, PROPOSE_BACKOFF_MS.length - 1)] ?? APPROVAL_POLL_MS;
                failedProposals++;
                const code = safeCode(status.retryCode);
                if (code !== reportedCode) {
                    reportedCode = code;
                    printLine(terminal, `The vault has not created the request yet (${code}); retrying.`);
                }
            }
            const remaining = deadline - now();
            if (remaining <= 0)
                break;
            await wait(Math.min(pause, remaining));
        }
        if (printedRequest)
            throw new HostNotEnrolledError(`Claustrum approval is still pending. In another terminal, run: ${approveCommand(printedRequest, name)} and then rerun setup.`, {
                reason: 'approval-pending',
                ...(lastCode !== undefined && { lastErrorCode: lastCode }),
            });
        const code = safeCode(lastCode);
        throw new HostNotEnrolledError(`The vault never created the enrollment request (last error: ${code}). Check that ck is running, then rerun setup.`, { reason: 'request-not-created', lastErrorCode: code });
    }
    catch (error) {
        if (error instanceof ProcessFenceViolationError ||
            error instanceof ProcessInspectionError ||
            // Built above from fixed text and vetted values only.
            error instanceof HostNotEnrolledError)
            throw error;
        // Enrollment exceptions can carry request secrets or bearer tokens; never
        // display them. Only a vetted error code goes into the diagnostics.
        const code = error?.code;
        throw new HostNotEnrolledError(ENROLLMENT_INCOMPLETE_MESSAGE, {
            reason: 'incomplete',
            ...(typeof code === 'string' && { lastErrorCode: code }),
        });
    }
    finally {
        client.close();
    }
}
