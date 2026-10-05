import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { createServer, } from 'node:http';
import { join } from 'node:path';
import { isSessionId, } from './notifications.js';
import { sweepRpcState, writePortFile } from './port-file.js';
/**
 * Thrown by an `apply`, `drain`, or `parsePending` handler to refuse a request with a 4xx
 * status. Its message is sent on the wire as `{error: message}`, so it must
 * be written for the client and never quote a credential. Any other error an
 * apply/drain handler throws answers 500 with a fixed code; other parser
 * errors answer 400 invalid params. Async drain failures always answer 500.
 */
export class RpcRequestError extends Error {
    status;
    constructor(status, message) {
        if (!Number.isInteger(status) || status < 400 || status > 499)
            throw new RangeError(`RpcRequestError status must be 4xx, got ${status}`);
        super(message);
        this.name = 'RpcRequestError';
        this.status = status;
    }
}
const MAX_BODY_BYTES = 1_000_000;
/** The request body exceeded the cap; answered 413. */
class BodyTooLargeError extends Error {
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const tooLarge = () => {
            // Keep reading and discarding the rest, so the client finishes sending
            // and can read the 413 instead of seeing a reset connection.
            req.removeAllListeners('data');
            req.on('data', () => { });
            req.resume();
            reject(new BodyTooLargeError('body too large'));
        };
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            tooLarge();
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
class ApplyDeadlineError extends Error {
}
/** Settle with `work`, or reject at `ms` while `work` keeps running. */
async function withDeadline(work, ms) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ApplyDeadlineError('apply deadline exceeded')), ms);
        // The deadline only bounds a reply. While a request is open its socket
        // keeps the process alive anyway; after stop() closes it, a handler that
        // never settles must not hold the process open until the deadline.
        timer.unref?.();
    });
    // A handler that fails after its deadline has nobody left to answer.
    work.catch(() => { });
    try {
        return await Promise.race([work, deadline]);
    }
    finally {
        clearTimeout(timer);
    }
}
function tokenOk(header, token) {
    if (!header?.startsWith('Bearer '))
        return false;
    const got = Buffer.from(header.slice(7));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
}
export async function startRpcServer(options) {
    if ((typeof options.drain === 'function') ===
        (typeof options.drainAsync === 'function'))
        throw new TypeError('exactly one of drain or drainAsync must be provided');
    const log = options.log ?? { warn() { }, debug() { } };
    const token = randomBytes(32).toString('hex');
    // The receipt timeout limits request delivery, not handler execution.
    // The socket inactivity timeout must also allow slow handlers to finish.
    const handlerTimeoutMs = options.timeoutMs ?? 90_000;
    const receiptTimeoutMs = options.receiptTimeoutMs ?? 2_000;
    let warnedMissingNotificationSession = false;
    const connections = new Set();
    const server = createServer((req, res) => {
        req.setTimeout(handlerTimeoutMs, () => {
            req.socket.destroy();
        });
        void dispatch(req, res);
    });
    server.on('connection', (socket) => {
        connections.add(socket);
        socket.once('close', () => connections.delete(socket));
    });
    server.requestTimeout = receiptTimeoutMs;
    server.headersTimeout = receiptTimeoutMs;
    async function dispatch(req, res) {
        const json = (status, value, headers = {}) => {
            // Guard against writing to a socket that is already gone (the
            // inactivity timeout destroys it).
            if (res.headersSent || res.writableEnded || res.destroyed)
                return;
            res.writeHead(status, { 'content-type': 'application/json', ...headers });
            res.end(JSON.stringify(value));
        };
        try {
            // Route on the pathname alone, so a query string does not turn a known
            // method into a 404.
            const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
            if (req.method === 'GET' && path === '/health')
                return json(200, { ok: true });
            if (req.method !== 'POST' || !path.startsWith('/rpc/'))
                return json(404, { error: 'not found' });
            if (!tokenOk(req.headers.authorization, token))
                return json(401, { error: 'unauthorized' });
            const method = path.slice('/rpc/'.length);
            let body;
            try {
                body = await readBody(req);
            }
            catch (error) {
                if (!(error instanceof BodyTooLargeError))
                    throw error;
                // Close the connection after answering: the rest of the oversized
                // body is not worth keeping the socket for.
                return json(413, { error: 'body too large' }, { connection: 'close' });
            }
            let params;
            try {
                params = JSON.parse(body || '{}');
            }
            catch {
                return json(400, { error: 'invalid json' });
            }
            if (method === 'pending-notifications') {
                let pending;
                try {
                    if (options.parsePending) {
                        pending = options.parsePending(params);
                    }
                    else {
                        if (!params || typeof params !== 'object' || Array.isArray(params))
                            throw new Error('invalid params');
                        const raw = params;
                        if (options.requireSession === true && !isSessionId(raw.sessionId))
                            return json(400, { error: 'session required' });
                        if (('lastReceivedId' in raw &&
                            (typeof raw.lastReceivedId !== 'number' ||
                                !Number.isSafeInteger(raw.lastReceivedId) ||
                                raw.lastReceivedId < 0)) ||
                            ('sessionId' in raw && typeof raw.sessionId !== 'string'))
                            throw new Error('invalid params');
                        pending = {
                            lastReceivedId: Number(raw.lastReceivedId ?? 0),
                            sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
                        };
                    }
                }
                catch (error) {
                    if (error instanceof RpcRequestError)
                        throw error;
                    return json(400, { error: 'invalid params' });
                }
                const { lastReceivedId, sessionId } = pending;
                if (options.requireSession === true && !isSessionId(sessionId))
                    return json(400, { error: 'session required' });
                if (sessionId === undefined && !warnedMissingNotificationSession) {
                    warnedMissingNotificationSession = true;
                    log.warn('rpc notification drain missing session id', {
                        pid: process.pid,
                    });
                }
                let messages;
                if (options.drainAsync) {
                    try {
                        messages = await options.drainAsync(lastReceivedId, sessionId);
                    }
                    catch (error) {
                        log.warn('rpc notification drain failed', {
                            pid: process.pid,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return json(500, { error: 'drain failed' });
                    }
                }
                else {
                    messages = options.drain?.(lastReceivedId, sessionId);
                }
                return json(200, { messages });
            }
            if (method === 'apply') {
                const work = Promise.resolve(options.apply(params));
                const result = options.applyDeadlineMs === undefined
                    ? await work
                    : await withDeadline(work, options.applyDeadlineMs);
                return json(200, result);
            }
            return json(404, { error: 'unknown method' });
        }
        catch (error) {
            if (error instanceof RpcRequestError) {
                log.debug('rpc request refused', {
                    pid: process.pid,
                    status: error.status,
                });
                return json(error.status, { error: error.message });
            }
            if (error instanceof ApplyDeadlineError) {
                log.warn('rpc apply deadline exceeded', {
                    pid: process.pid,
                    deadlineMs: options.applyDeadlineMs,
                });
                return json(504, { error: 'handler deadline exceeded' });
            }
            // A handler's exception can quote a request or a credential, so its
            // text goes to the plugin's log channel only; the wire gets a fixed code.
            log.warn('rpc request failed', {
                pid: process.pid,
                error: error instanceof Error ? error.message : String(error),
            });
            json(500, { error: 'internal error' });
        }
    }
    const port = await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object')
                resolve(addr.port);
            else
                reject(new Error('no port'));
        });
    });
    server.unref();
    if (options.sweepRoot) {
        try {
            await sweepRpcState(options.sweepRoot, options.dir, options.isManagedDir, log);
        }
        catch (error) {
            log.warn('rpc state sweep failed', {
                pid: process.pid,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    try {
        await writePortFile(options.dir, { port, token, pid: process.pid }, { secureDir: options.secureDir });
        log.debug('rpc server pid', {
            pid: process.pid,
            rpcPort: port,
        });
    }
    catch (error) {
        await new Promise((resolve) => server.close(() => resolve()));
        throw error;
    }
    return {
        port,
        token,
        async stop() {
            await new Promise((resolve) => {
                server.close(() => resolve());
                // Stop accepting connections before ending requests that may never finish.
                server.closeAllConnections?.();
                // Bun exposes closeAllConnections but leaves partial requests open.
                for (const socket of connections)
                    socket.destroy();
            });
            const portFile = join(options.dir, `port-${process.pid}.json`);
            const current = await readFile(portFile, 'utf8')
                .then((raw) => JSON.parse(raw))
                .catch(() => undefined);
            if (current?.port === port && current.token === token)
                await unlink(portFile).catch(() => { });
        },
    };
}
