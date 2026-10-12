import { ClaustrumCredentialError, } from '@cortexkit/claustrum-client';
import { createLogger } from '../logger/index.js';
import { readClaustrumEnrollmentToken } from './enrollment.js';
import { ClaustrumConsumerError } from './errors.js';
import { CUSTODY_PLACEHOLDER_PREFIX } from './host-slot.js';
/** Only a new version of the same account may replace an in-flight 401. */
export function isScopedCredentialRotation(served, current) {
    return (current !== undefined &&
        current.credentialId === served.credentialId &&
        current.accountIdentity === served.accountIdentity &&
        current.recordVersion !== served.recordVersion);
}
function scopedRetryReason(served, current) {
    if (current === undefined)
        return 'reauthorize-failed';
    if (current.credentialId !== served.credentialId)
        return 'credential-changed';
    if (current.accountIdentity !== served.accountIdentity)
        return 'account-changed';
    if (current.recordVersion === served.recordVersion)
        return 'version-unchanged';
    return 'rotated';
}
const defaultLogger = createLogger('claustrum');
/**
 * Decide whether a request that got a 401 should retry with the freshly
 * re-authorized receipt, and log the decision. The vault can refresh a
 * credential between the send and the 401; the log line lets that refresh be
 * matched against the consumer's retry. `site` names the kind of request.
 */
export function decideScopedRetryAfter401(site, served, current, logger = defaultLogger) {
    const retry = isScopedCredentialRotation(served, current);
    logger.debug('scoped 401 re-authorized', {
        site,
        credentialId: served.credentialId,
        servedVersion: served.recordVersion,
        currentVersion: current?.recordVersion ?? null,
        retry,
        reason: scopedRetryReason(served, current),
    });
    return retry;
}
/**
 * How long a served OAuth token must stay valid after the vault hands it out,
 * so it cannot expire while a long request is still using it.
 */
export const SERVING_MARGIN_MS = 300_000;
function invalidMaterial() {
    return new ClaustrumConsumerError('invalid-material', 'Claustrum returned invalid credential material');
}
function accessTokenFromMaterial(material) {
    let access = material.trim();
    if (access.startsWith('{')) {
        let parsed;
        try {
            parsed = JSON.parse(access);
        }
        catch {
            throw invalidMaterial();
        }
        if (!parsed || typeof parsed !== 'object')
            throw invalidMaterial();
        const record = parsed;
        const value = record.access_token ?? record.access;
        access = typeof value === 'string' ? value : '';
    }
    // A header-safe token only: control characters could split the request,
    // and the custody placeholder must never be sent as a credential.
    if (!/^[\x21-\x7e]+$/.test(access) ||
        access.startsWith(CUSTODY_PLACEHOLDER_PREFIX)) {
        throw invalidMaterial();
    }
    return access;
}
function credentialTypeOf(row, family) {
    if (!row.operations.includes('read'))
        return undefined;
    if (!row.categories.includes(family.category))
        return undefined;
    if (row.credentialType === 'oauth')
        return row.refreshAdapter === family.refreshAdapter ? 'oauth' : undefined;
    if (row.credentialType === 'api_key' && family.apiKeys)
        return row.refreshAdapter === undefined ? 'api_key' : undefined;
    return undefined;
}
/**
 * Reads this consumer's vault credentials (list, fetch, 401 report), with the
 * enrollment token as authorization. Used by every host of a plugin. There is
 * deliberately no credential cache and no single-flight of credential reads:
 * each physical send is authorized by the vault, so a revoked enrollment or a
 * changed record takes effect on the next send. The enrollment token is
 * re-read per operation so an operator's reissue on disk is picked up.
 */
export class ClaustrumScopedCustody {
    #client;
    #readToken;
    #now;
    #family;
    #parseIdentity;
    #requireAssertion;
    #logger;
    #provenance = new WeakMap();
    #reports = new WeakMap();
    #closed = false;
    constructor(options) {
        const tokenPath = options.tokenPath;
        if (options.readToken) {
            this.#readToken = options.readToken;
        }
        else if (tokenPath) {
            this.#readToken = () => readClaustrumEnrollmentToken(tokenPath);
        }
        else {
            throw new ClaustrumConsumerError('not-enrolled', 'Claustrum enrollment token path is required');
        }
        this.#client = options.client;
        this.#family = options.family;
        this.#parseIdentity = options.parseIdentity;
        this.#requireAssertion = options.requireAssertion ?? false;
        this.#now = options.now ?? Date.now;
        this.#logger = options.logger ?? defaultLogger;
    }
    #check(signal) {
        if (this.#closed)
            throw new ClaustrumConsumerError('closed', 'Claustrum scoped custody is closed');
        signal?.throwIfAborted();
    }
    async #token(signal) {
        this.#check(signal);
        const value = await this.#readToken();
        this.#check(signal);
        if (!/^[0-9a-f]{64}$/.test(value.token) ||
            !Number.isSafeInteger(value.token_generation) ||
            value.token_generation < 1) {
            throw new ClaustrumConsumerError('invalid-token', 'Invalid Claustrum enrollment token');
        }
        return value.token;
    }
    async #call(operation, signal) {
        this.#check(signal);
        let result;
        let removeAbortListener;
        try {
            const pending = operation();
            result = signal
                ? await Promise.race([
                    pending,
                    new Promise((_resolve, reject) => {
                        const abort = () => reject(signal.reason);
                        signal.addEventListener('abort', abort, { once: true });
                        removeAbortListener = () => signal.removeEventListener('abort', abort);
                        if (signal.aborted)
                            abort();
                    }),
                ])
                : await pending;
        }
        catch (error) {
            this.#check(signal);
            // Keep the vault's own refusals (ClaustrumCredentialError, carrying
            // code, class and action); replace any other error, whose text may echo
            // request params that include the enrollment token.
            if (error instanceof ClaustrumCredentialError)
                throw error;
            throw new ClaustrumConsumerError('unavailable', 'Claustrum scoped operation unavailable');
        }
        finally {
            removeAbortListener?.();
        }
        this.#check(signal);
        return result;
    }
    /**
     * List this consumer's credentials. A record that cannot be used is skipped
     * and warned about rather than failing the whole list, so one bad record
     * never hides every other account. Records outside the family are not
     * skipped records: they simply are not this consumer's.
     */
    async discover(signal) {
        const token = await this.#token(signal);
        const inventory = await this.#call(() => this.#client.listScoped(token), signal);
        const skipped = [];
        const candidates = [];
        const counts = new Map();
        for (const row of inventory.rows) {
            const type = credentialTypeOf(row, this.#family);
            if (!type)
                continue;
            candidates.push({ row, type });
            counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
        }
        const credentials = [];
        for (const { row, type } of candidates) {
            let reason;
            if (!row.id.trim())
                reason = 'empty credential id';
            else if ((counts.get(row.id) ?? 0) > 1)
                reason = 'duplicate credential id';
            else if (row.accountId !== undefined && !row.accountId.trim())
                reason = 'blank account identity';
            else if (!row.state.trim())
                reason = 'empty state';
            if (reason) {
                skipped.push({ ...(row.id.trim() && { credentialId: row.id }), reason });
                continue;
            }
            credentials.push(Object.freeze({
                credentialId: row.id,
                credentialType: type,
                ...(row.accountId !== undefined && {
                    accountIdentity: row.accountId,
                }),
                state: row.state,
                ...(row.email !== undefined && { email: row.email }),
                ...(row.orgName !== undefined && { orgName: row.orgName }),
            }));
        }
        for (const record of skipped)
            this.#logger.warn('skipped malformed vault record', record);
        return {
            view: inventory.view,
            credentials: Object.freeze(credentials),
            skipped: Object.freeze(skipped),
        };
    }
    /**
     * Fetch the credential for one physical send and wrap it in a fresh receipt.
     * The vault's served identity (or, without one, the plugin's parse of the
     * token) must equal the roster's when both are present. Without
     * `requireAssertion`, absence on either side proves nothing and does not
     * refuse; the receipt records what the vault asserted separately from what
     * the roster expected. With it, a reply that does not itself name the
     * credential id and the expected account is refused.
     */
    async authorize(identity, signal) {
        if (!identity.credentialId)
            throw new ClaustrumConsumerError('route-unavailable', 'Claustrum dispatch requires a credential id');
        // Capture the caller's fields before yielding so a later mutation cannot move the fence.
        const { credentialId, credentialType, accountIdentity } = identity;
        if (this.#requireAssertion && accountIdentity === undefined)
            throw new ClaustrumConsumerError('identity-unasserted', 'Claustrum dispatch requires a known account identity');
        const token = await this.#token(signal);
        const served = await this.#call(() => this.#client.getScoped({
            credentialId,
            enrollmentToken: token,
            ...(credentialType === 'oauth' && { minTtlMs: SERVING_MARGIN_MS }),
        }), signal);
        if (served.credentialId !== undefined &&
            served.credentialId !== credentialId) {
            throw new ClaustrumConsumerError('identity-changed', 'Claustrum served credential identity changed');
        }
        const expiresAtMs = served.expiresAtMs;
        if (!Number.isSafeInteger(served.recordVersion) ||
            served.recordVersion < 0 ||
            (expiresAtMs === null && credentialType === 'oauth') ||
            (expiresAtMs !== null &&
                (!Number.isFinite(expiresAtMs) ||
                    expiresAtMs - this.#now() < SERVING_MARGIN_MS))) {
            throw new ClaustrumConsumerError('insufficient-validity', 'Claustrum served credential has insufficient validity');
        }
        const accessToken = accessTokenFromMaterial(served.material);
        const assertedIdentity = served.accountId?.trim()
            ? served.accountId
            : undefined;
        if (this.#requireAssertion &&
            (served.credentialId === undefined || assertedIdentity === undefined))
            throw new ClaustrumConsumerError('identity-unasserted', 'Claustrum served credential did not assert its identity');
        const parsedIdentity = assertedIdentity === undefined
            ? this.#parseIdentity?.(accessToken)
            : undefined;
        const servedIdentity = assertedIdentity ?? parsedIdentity;
        if (accountIdentity !== undefined &&
            servedIdentity !== undefined &&
            servedIdentity !== accountIdentity) {
            throw new ClaustrumConsumerError('identity-changed', 'Claustrum served credential identity changed');
        }
        const resolvedIdentity = servedIdentity ?? accountIdentity;
        const source = assertedIdentity !== undefined
            ? 'asserted'
            : parsedIdentity !== undefined
                ? 'parsed'
                : accountIdentity !== undefined
                    ? 'expected'
                    : 'none';
        const attempt = Object.freeze(Object.defineProperty({
            credentialId,
            credentialType,
            ...(resolvedIdentity !== undefined && {
                accountIdentity: resolvedIdentity,
            }),
            accountIdentitySource: source,
            ...(accountIdentity !== undefined && {
                expectedAccountIdentity: accountIdentity,
            }),
            ...(served.credentialId !== undefined && {
                assertedCredentialId: served.credentialId,
            }),
            ...(assertedIdentity !== undefined && {
                assertedAccountIdentity: assertedIdentity,
            }),
            ...(served.projectId !== undefined && {
                projectId: served.projectId,
            }),
            recordVersion: served.recordVersion,
            expiresAtMs,
        }, 'accessToken', { value: accessToken, enumerable: false }));
        this.#provenance.set(attempt, token);
        return attempt;
    }
    /**
     * Report that a send this consumer actually made was rejected. Only a 401
     * is reported (the vault refuses 429, 402 and 5xx reports), addressed by
     * credential id with the exact record version that send was served, and
     * signed with the enrollment token that authorized it. A receipt this
     * custody did not issue is refused rather than reported.
     */
    async reportFailure(attempt, status, reporterSource) {
        if (status !== 401)
            return;
        this.#check();
        const token = this.#provenance.get(attempt);
        if (!token)
            throw new ClaustrumConsumerError('no-receipt', 'Claustrum failure report requires an original dispatch receipt');
        const pending = this.#reports.get(attempt);
        if (pending)
            return pending;
        const report = this.#call(() => this.#client.reportAuthFailureScoped({
            credentialId: attempt.credentialId,
            enrollmentToken: token,
            providerStatus: 401,
            recordVersion: attempt.recordVersion,
            reporterSource,
        }));
        this.#reports.set(attempt, report);
        try {
            await report;
            this.#logger.debug('scoped 401 reported', {
                credentialId: attempt.credentialId,
                recordVersion: attempt.recordVersion,
                reporterSource,
            });
        }
        catch (error) {
            this.#reports.delete(attempt);
            throw error;
        }
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#client.close();
    }
}
