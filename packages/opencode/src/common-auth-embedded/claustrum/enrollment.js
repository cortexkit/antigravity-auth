import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink, } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, } from 'node:path';
import { ClaustrumCredentialError, ClaustrumClient as ClaustrumWireClient, writeEnrollmentTokenFile, } from '@cortexkit/claustrum-client';
import { acquireRefreshFileLock } from '../fs/index.js';
import { ClaustrumConsumerError } from './errors.js';
const ENROLLMENT_SCHEMA = 1;
const ENROLLMENT_FILE_MAX_BYTES = 16 * 1024;
const ENROLLMENT_LOCK_TTL_MS = 30_000;
const TOKEN_RE = /^[0-9a-f]{64}$/;
/**
 * Codes the vault's closed enrollment-refusal vocabulary marks permanent. The
 * client labels some module error frames transient/retry regardless, so the
 * producer's code takes precedence over the client's action for these.
 */
export const TERMINAL_ENROLLMENT_CODES = new Set([
    'invalid_params',
    'pending_exists',
    'not_found',
    'already_consumed',
    'superseded',
    'stale_generation',
]);
/** Codes that are always worth another ceremony tick, whatever the action says. */
export const RETRYABLE_ENROLLMENT_CODES = new Set([
    'pending_queue_full',
]);
/**
 * Classify an enrollment transport refusal as `(code, disposition)`. The
 * vault's own code wins: a terminal code is terminal even when the client
 * says retry, queue saturation is retryable even when it says gone, and any
 * other code follows the client's action. Errors that are not producer
 * refusals return undefined and are the caller's to rethrow.
 */
export function classifyEnrollmentError(error) {
    if (!(error instanceof ClaustrumCredentialError))
        return undefined;
    if (TERMINAL_ENROLLMENT_CODES.has(error.code))
        return { code: error.code, disposition: 'terminal' };
    if (RETRYABLE_ENROLLMENT_CODES.has(error.code))
        return { code: error.code, disposition: 'retry' };
    return {
        code: error.code,
        disposition: error.action === 'retry' ? 'retry' : 'terminal',
    };
}
/**
 * The name a plugin proposes for one host, for example `openai-auth-opencode`.
 * Each host enrolls separately so the operator can revoke one without the other.
 */
export function enrollmentName(plugin, host) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin) ||
        !/^[a-z0-9][a-z0-9-]*$/.test(host))
        throw new ClaustrumConsumerError('invalid-state', 'Claustrum enrollment names use lowercase letters, digits and dashes');
    return `${plugin}-${host}`;
}
/**
 * Connect the enrollment ceremony. Setup calls this; the request path never
 * does. `connectionFile` is required because this library reads no
 * environment and knows no host paths.
 */
export function connectClaustrumEnrollmentClient(options) {
    return ClaustrumWireClient.connect(options);
}
/** The ceremony state file sits next to the token: `x.json` pairs with `x-state.json`. */
export function getClaustrumEnrollmentPaths(tokenPath) {
    const extension = extname(tokenPath) || '.json';
    const stem = basename(tokenPath, extname(tokenPath));
    return {
        statePath: join(dirname(tokenPath), `${stem}-state${extension}`),
        tokenPath,
    };
}
/**
 * One host's token and state paths. Every host gets its own pair under the
 * plugin's state directory, so an OpenCode enrollment and a Pi enrollment can
 * be approved and revoked independently. A plugin-resolved override replaces
 * the default token path; a relative override resolves against `cwd`.
 */
export function hostEnrollmentPaths(input) {
    const override = input.override?.trim();
    if (override && !isAbsolute(override) && !input.cwd)
        throw new ClaustrumConsumerError('invalid-state', 'A relative Claustrum enrollment override needs a base directory');
    const tokenPath = override
        ? isAbsolute(override)
            ? override
            : resolve(input.cwd, override)
        : join(input.stateDir, `${input.host}-enrollment.json`);
    return getClaustrumEnrollmentPaths(tokenPath);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validTimestamp(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validGeneration(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function invalidState() {
    return new ClaustrumConsumerError('invalid-state', 'invalid Claustrum enrollment state');
}
function decodeEnrollmentState(value) {
    if (!isRecord(value) ||
        value.version !== ENROLLMENT_SCHEMA ||
        typeof value.proposedName !== 'string' ||
        value.proposedName.length === 0) {
        throw invalidState();
    }
    if (value.phase === 'pending') {
        if (!TOKEN_RE.test(String(value.requestSecret ?? '')) ||
            (value.requestId !== undefined &&
                (typeof value.requestId !== 'string' ||
                    value.requestId.length === 0)) ||
            !validTimestamp(value.createdAt) ||
            !validTimestamp(value.updatedAt)) {
            throw invalidState();
        }
        return {
            version: 1,
            phase: 'pending',
            proposedName: value.proposedName,
            requestSecret: value.requestSecret,
            ...(value.requestId !== undefined && {
                requestId: value.requestId,
            }),
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
        };
    }
    if (value.phase === 'approved') {
        if ((value.approvedName !== undefined &&
            (typeof value.approvedName !== 'string' ||
                value.approvedName.length === 0)) ||
            !validGeneration(value.tokenGeneration) ||
            !validTimestamp(value.updatedAt)) {
            throw invalidState();
        }
        return {
            version: 1,
            phase: 'approved',
            proposedName: value.proposedName,
            ...(value.approvedName !== undefined && {
                approvedName: value.approvedName,
            }),
            tokenGeneration: value.tokenGeneration,
            updatedAt: value.updatedAt,
        };
    }
    if (value.phase === 'denied' || value.phase === 'blocked') {
        if ((value.errorCode !== undefined && typeof value.errorCode !== 'string') ||
            !validTimestamp(value.updatedAt)) {
            throw invalidState();
        }
        return {
            version: 1,
            phase: value.phase,
            proposedName: value.proposedName,
            ...(value.errorCode !== undefined && {
                errorCode: value.errorCode,
            }),
            updatedAt: value.updatedAt,
        };
    }
    throw invalidState();
}
function decodeTokenFile(value) {
    if (!isRecord(value) ||
        !TOKEN_RE.test(String(value.token ?? '')) ||
        !validGeneration(value.token_generation)) {
        throw new ClaustrumConsumerError('invalid-token', 'invalid Claustrum enrollment token file');
    }
    return {
        token: value.token,
        token_generation: value.token_generation,
    };
}
function validateReadableSecretFile(metadata) {
    if (!metadata.isFile()) {
        throw new ClaustrumConsumerError('unsafe-file', 'Claustrum enrollment file must be a regular file');
    }
    if ((metadata.mode & 0o077) !== 0) {
        throw new ClaustrumConsumerError('unsafe-file', 'Claustrum enrollment file must be owner-only');
    }
    const expectedUid = process.geteuid?.();
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
        throw new ClaustrumConsumerError('unsafe-file', 'Claustrum enrollment file must be owned by the current user');
    }
}
/** Parse secret-bearing JSON without letting a parser message echo its bytes. */
function parseSecretJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new ClaustrumConsumerError('invalid-state', 'Claustrum enrollment file is not valid JSON');
    }
}
async function readBoundedJson(path) {
    let descriptor;
    try {
        // O_NOFOLLOW: a symlink planted at the path must not redirect a secret read.
        descriptor = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw new ClaustrumConsumerError('unsafe-file', 'Claustrum enrollment file could not be opened safely');
    }
    try {
        validateReadableSecretFile(await descriptor.stat());
        const source = Buffer.alloc(ENROLLMENT_FILE_MAX_BYTES + 1);
        const { bytesRead } = await descriptor.read(source, 0, source.byteLength, 0);
        if (bytesRead > ENROLLMENT_FILE_MAX_BYTES) {
            throw new ClaustrumConsumerError('unsafe-file', 'Claustrum enrollment file is too large');
        }
        return parseSecretJson(source.subarray(0, bytesRead).toString('utf8'));
    }
    finally {
        await descriptor.close();
    }
}
function accountRecords(text, fields) {
    const records = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '' || line.startsWith('#'))
            continue;
        const parts = line.split(':');
        if (parts.length !== fields ||
            !/^[^\s:,]+$/.test(parts[0] ?? '') ||
            !/^\d+$/.test(parts[2] ?? '') ||
            !Number.isSafeInteger(Number(parts[2])) ||
            (fields === 7 &&
                (!/^\d+$/.test(parts[3] ?? '') ||
                    !Number.isSafeInteger(Number(parts[3])))) ||
            (fields === 4 &&
                parts[3] !== '' &&
                !/^[^\s:,]+(?:,[^\s:,]+)*$/.test(parts[3] ?? '')))
            return undefined;
        records.push(parts);
    }
    return records;
}
async function isPrivateGroup(uid, gid, options) {
    try {
        const [passwdText, groupText] = await Promise.all([
            readFile(options.passwdPath ?? '/etc/passwd', 'utf8'),
            readFile(options.groupPath ?? '/etc/group', 'utf8'),
        ]);
        const users = accountRecords(passwdText, 7);
        const groups = accountRecords(groupText, 4);
        if (!users || !groups)
            return false;
        const owners = users.filter((user) => Number(user[2]) === uid);
        const matchingGroups = groups.filter((group) => Number(group[2]) === gid);
        if (owners.length !== 1 || matchingGroups.length !== 1)
            return false;
        const name = owners[0]?.[0];
        const members = matchingGroups[0]?.[3] ?? '';
        return ((members === '' ||
            members.split(',').every((member) => member === name)) &&
            !users.some((user) => Number(user[2]) !== uid && Number(user[3]) === gid));
    }
    catch {
        // Missing local records (including NSS-only accounts) cannot prove exclusivity.
        return false;
    }
}
/**
 * Protect setup writes from directory replacement. Group write access is safe
 * only when local account records prove that the effective user's group is private.
 */
export async function refuseWritableAncestor(parent, options = {}) {
    const uid = process.geteuid?.();
    if (uid === undefined)
        return;
    const gid = process.getegid?.();
    let component;
    try {
        component = await realpath(parent);
    }
    catch {
        return;
    }
    // Load lazily, once per traversal: account changes take effect on the next write.
    let privateGroup;
    for (;;) {
        const metadata = await stat(component).catch(() => undefined);
        if (metadata &&
            (metadata.mode & 0o022) !== 0 &&
            (metadata.mode & 0o1000) === 0) {
            if (privateGroup === undefined) {
                privateGroup =
                    gid !== undefined && (await isPrivateGroup(uid, gid, options));
            }
            if ((metadata.mode & 0o002) !== 0 ||
                metadata.uid !== uid ||
                metadata.gid !== gid ||
                !privateGroup) {
                throw new ClaustrumConsumerError('unsafe-file', `Claustrum enrollment path has a writable ancestor: ${component}. Another user could replace it. Run: chmod g-w,o-w ${component}`);
            }
        }
        const next = dirname(component);
        if (next === component)
            return;
        component = next;
    }
}
/**
 * Create the enrollment directory owner-only (0700), and tighten it to 0700
 * when it already exists with group or other bits, so the token and the
 * request secret never sit in a directory another account can list.
 */
async function ensurePrivateDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await stat(directory);
    const uid = process.geteuid?.();
    if (uid !== undefined && metadata.uid !== uid) {
        throw new ClaustrumConsumerError('unsafe-file', 'Claustrum enrollment directory must be owned by the current user');
    }
    if ((metadata.mode & 0o077) !== 0)
        await chmod(directory, 0o700);
}
async function writeStateAtomic(path, state, ancestorOptions = {}) {
    const parent = dirname(path);
    await ensurePrivateDirectory(parent);
    await refuseWritableAncestor(parent, ancestorOptions);
    const bytes = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(bytes) > ENROLLMENT_FILE_MAX_BYTES) {
        throw new ClaustrumConsumerError('invalid-state', 'Claustrum enrollment state is too large');
    }
    const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    let created = false;
    try {
        descriptor = await open(temporary, 'wx', 0o600);
        created = true;
        await descriptor.writeFile(bytes, 'utf8');
        await descriptor.chmod(0o600);
        await descriptor.sync();
        await descriptor.close();
        descriptor = undefined;
        await rename(temporary, path);
        created = false;
    }
    finally {
        await descriptor?.close().catch(() => { });
        if (created)
            await unlink(temporary).catch(() => { });
    }
}
export async function readClaustrumEnrollmentStatus(paths, proposedName) {
    const tokenValue = await readBoundedJson(paths.tokenPath);
    const token = tokenValue === undefined ? undefined : decodeTokenFile(tokenValue);
    const stateValue = await readBoundedJson(paths.statePath);
    const state = stateValue === undefined ? undefined : decodeEnrollmentState(stateValue);
    if (token) {
        return {
            state: 'approved',
            proposedName: state?.proposedName ?? proposedName,
            ...(state?.phase === 'approved' &&
                state.approvedName !== undefined && {
                approvedName: state.approvedName,
            }),
            tokenGeneration: token.token_generation,
        };
    }
    if (!state)
        return { state: 'idle' };
    if (state.phase === 'approved') {
        return {
            state: 'blocked',
            proposedName: state.proposedName,
            code: 'missing_token',
        };
    }
    return statusFromState(state);
}
/**
 * Read fresh bearer material for one scoped operation; never publish it.
 * Re-reading per operation is what lets an operator reissue a token on disk.
 */
export async function readClaustrumEnrollmentToken(tokenPath) {
    // Reads rely on O_NOFOLLOW and regular, owner-only, effective-uid-owned files:
    // another user cannot plant a file owned by us. Ancestor checks protect writes
    // from placing our secret in a swapped directory, not reads; keep their
    // realpath/stat and account-file I/O off the authorization path.
    const value = await readBoundedJson(tokenPath);
    if (value === undefined)
        throw new ClaustrumConsumerError('not-enrolled', 'Claustrum enrollment is not configured');
    return decodeTokenFile(value);
}
function statusFromState(state) {
    if (state.phase === 'pending') {
        return {
            state: 'pending',
            proposedName: state.proposedName,
            ...(state.requestId !== undefined && { requestId: state.requestId }),
        };
    }
    if (state.phase === 'approved') {
        return {
            state: 'approved',
            proposedName: state.proposedName,
            ...(state.approvedName !== undefined && {
                approvedName: state.approvedName,
            }),
            tokenGeneration: state.tokenGeneration,
        };
    }
    if (state.phase === 'denied')
        return { state: 'denied', proposedName: state.proposedName };
    return {
        state: 'blocked',
        proposedName: state.proposedName,
        code: state.errorCode ?? 'unknown',
    };
}
function wrongConsumer() {
    return new ClaustrumConsumerError('wrong-consumer', 'Claustrum enrollment state belongs to a different consumer');
}
/**
 * The enrollment ceremony for one host. Run it from setup only: it proposes,
 * polls and persists, and every step can wait on an operator. The request
 * path reads the resulting token and never calls into this class.
 */
export class ClaustrumEnrollmentManager {
    #client;
    #paths;
    #proposedName;
    #now;
    #mintSecret;
    #writeTokenFile;
    #ancestorOptions;
    constructor(options) {
        this.#ancestorOptions = options.ancestorOptions ?? {};
        this.#client = options.client;
        this.#paths = options.paths;
        this.#proposedName = options.proposedName;
        this.#now = options.now ?? Date.now;
        this.#mintSecret =
            options.mintSecret ?? (() => randomBytes(32).toString('hex'));
        this.#writeTokenFile = options.writeTokenFile ?? writeEnrollmentTokenFile;
    }
    async status() {
        return readClaustrumEnrollmentStatus(this.#paths, this.#proposedName);
    }
    async resetTerminal() {
        return resetClaustrumEnrollmentState(this.#paths, this.#proposedName);
    }
    async #block(state, code) {
        // Writing the terminal phase drops the request secret from disk.
        const blocked = {
            version: 1,
            phase: 'blocked',
            proposedName: state.proposedName,
            errorCode: code,
            updatedAt: this.#now(),
        };
        await writeStateAtomic(this.#paths.statePath, blocked, this.#ancestorOptions);
        return statusFromState(blocked);
    }
    async reconcile() {
        await ensurePrivateDirectory(dirname(this.#paths.statePath));
        const lock = await acquireRefreshFileLock({
            name: 'ceremony',
            path: this.#paths.statePath,
            ttlMs: ENROLLMENT_LOCK_TTL_MS,
            renew: true,
        });
        if (!lock)
            return { state: 'busy' };
        try {
            const existingToken = await readBoundedJson(this.#paths.tokenPath);
            const token = existingToken === undefined ? undefined : decodeTokenFile(existingToken);
            const stateValue = await readBoundedJson(this.#paths.statePath);
            let state = stateValue === undefined ? undefined : decodeEnrollmentState(stateValue);
            if (state && state.proposedName !== this.#proposedName)
                throw wrongConsumer();
            if (token) {
                if (!state || state.phase === 'pending') {
                    const approved = {
                        version: 1,
                        phase: 'approved',
                        proposedName: state?.proposedName ?? this.#proposedName,
                        tokenGeneration: token.token_generation,
                        updatedAt: this.#now(),
                    };
                    await writeStateAtomic(this.#paths.statePath, approved, this.#ancestorOptions);
                    state = approved;
                }
                return {
                    state: 'approved',
                    proposedName: state.proposedName,
                    ...(state.phase === 'approved' &&
                        state.approvedName !== undefined && {
                        approvedName: state.approvedName,
                    }),
                    tokenGeneration: token.token_generation,
                };
            }
            if (state?.phase === 'approved') {
                const blocked = {
                    version: 1,
                    phase: 'blocked',
                    proposedName: state.proposedName,
                    errorCode: 'missing_token',
                    updatedAt: this.#now(),
                };
                await writeStateAtomic(this.#paths.statePath, blocked, this.#ancestorOptions);
                return statusFromState(blocked);
            }
            if (state && state.phase !== 'pending')
                return statusFromState(state);
            if (!state) {
                const now = this.#now();
                state = {
                    version: 1,
                    phase: 'pending',
                    proposedName: this.#proposedName,
                    requestSecret: this.#mintSecret(),
                    createdAt: now,
                    updatedAt: now,
                };
                if (!TOKEN_RE.test(state.requestSecret))
                    throw new ClaustrumConsumerError('invalid-state', 'invalid minted Claustrum enrollment secret');
                // The secret is on disk before the proposal leaves the process: the
                // vault answers a repeated proposal with the same secret with the same
                // request id, so a crash between propose and saving the id costs nothing.
                await writeStateAtomic(this.#paths.statePath, state, this.#ancestorOptions);
            }
            if (!state.requestId) {
                try {
                    const requestSecretHash = createHash('sha256')
                        .update(Buffer.from(state.requestSecret, 'hex'))
                        .digest('hex');
                    const proposed = await this.#client.enrollPropose({
                        name: state.proposedName,
                        requestSecretHash,
                    });
                    state = {
                        ...state,
                        requestId: proposed.requestId,
                        updatedAt: this.#now(),
                    };
                    await writeStateAtomic(this.#paths.statePath, state, this.#ancestorOptions);
                }
                catch (error) {
                    const refusal = classifyEnrollmentError(error);
                    if (!refusal)
                        throw error;
                    if (refusal.disposition === 'retry') {
                        return {
                            state: 'pending',
                            proposedName: state.proposedName,
                            retryCode: refusal.code,
                        };
                    }
                    return this.#block(state, refusal.code);
                }
            }
            const requestId = state.requestId;
            if (!requestId)
                return statusFromState(state);
            try {
                const outcome = await this.#client.enrollPoll({
                    requestId,
                    requestSecret: state.requestSecret,
                });
                if (outcome.status === 'pending')
                    return statusFromState(state);
                if (outcome.status === 'denied') {
                    const denied = {
                        version: 1,
                        phase: 'denied',
                        proposedName: state.proposedName,
                        updatedAt: this.#now(),
                    };
                    await writeStateAtomic(this.#paths.statePath, denied, this.#ancestorOptions);
                    return statusFromState(denied);
                }
                // The vault returns the token exactly once: it reaches disk before the
                // pending metadata (and its secret) is replaced.
                await ensurePrivateDirectory(dirname(this.#paths.tokenPath));
                await refuseWritableAncestor(dirname(this.#paths.tokenPath), this.#ancestorOptions);
                await this.#writeTokenFile(this.#paths.tokenPath, {
                    token: outcome.token,
                    token_generation: outcome.tokenGeneration,
                });
                const approved = {
                    version: 1,
                    phase: 'approved',
                    proposedName: state.proposedName,
                    approvedName: outcome.name,
                    tokenGeneration: outcome.tokenGeneration,
                    updatedAt: this.#now(),
                };
                await writeStateAtomic(this.#paths.statePath, approved, this.#ancestorOptions);
                return statusFromState(approved);
            }
            catch (error) {
                const refusal = classifyEnrollmentError(error);
                if (!refusal)
                    throw error;
                if (refusal.disposition === 'retry') {
                    return {
                        state: 'pending',
                        proposedName: state.proposedName,
                        requestId,
                        retryCode: refusal.code,
                    };
                }
                return this.#block(state, refusal.code);
            }
        }
        finally {
            await lock.release();
        }
    }
}
/** Reset local terminal metadata without connecting to the credential daemon. */
export async function resetClaustrumEnrollmentState(paths, proposedName) {
    await ensurePrivateDirectory(dirname(paths.statePath));
    const lock = await acquireRefreshFileLock({
        name: 'ceremony',
        path: paths.statePath,
        ttlMs: ENROLLMENT_LOCK_TTL_MS,
        renew: true,
    });
    if (!lock)
        return 'busy';
    try {
        if ((await readBoundedJson(paths.tokenPath)) !== undefined)
            return 'refused-approved';
        const value = await readBoundedJson(paths.statePath);
        if (value === undefined)
            return 'idle';
        const state = decodeEnrollmentState(value);
        if (state.proposedName !== proposedName)
            throw wrongConsumer();
        if (state.phase === 'pending')
            return 'refused-pending';
        await lock.assertOwned();
        await unlink(paths.statePath);
        return 'reset';
    }
    finally {
        await lock.release();
    }
}
