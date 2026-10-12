import { open } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { discoverPortFile, portFileIdentity, } from './port-file.js';
export const DEFAULT_RPC_TIMEOUT_MS = 2_000;
const selections = new Map();
const discoveries = new Map();
// The identity a cached selection is checked against must belong to the bytes
// that named this server. Statting the path after discovery is not enough: the
// file can be replaced in between, which would pin the old server to the new
// file's identity. So read and fstat one open descriptor, and bind only when
// those bytes still name the discovered entry.
async function boundIdentity(dir, entry) {
    const path = join(resolve(dir), `port-${entry.pid}.json`);
    let handle;
    try {
        handle = await open(path, 'r');
        const info = await handle.stat();
        const current = JSON.parse(await handle.readFile('utf8'));
        if (current.pid !== entry.pid ||
            current.port !== entry.port ||
            current.token !== entry.token)
            return null;
        return `${path}:${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function select(key, dir, expectedPid, options) {
    const cached = selections.get(key);
    if (cached && (await portFileIdentity(dir, cached.entry)) === cached.identity)
        return cached;
    selections.delete(key);
    const pending = discoveries.get(key);
    if (pending)
        return pending;
    const discovery = (async () => {
        const entry = await (options.discover ?? discoverPortFile)(dir, expectedPid, options);
        if (!entry)
            return null;
        const identity = await boundIdentity(dir, entry);
        // The file changed under discovery: use what was discovered for this
        // call, as an uncached selection, so the next call discovers again.
        if (!identity)
            return { entry, identity: '' };
        const selected = { entry, identity };
        selections.set(key, selected);
        return selected;
    })();
    discoveries.set(key, discovery);
    try {
        return await discovery;
    }
    finally {
        if (discoveries.get(key) === discovery)
            discoveries.delete(key);
    }
}
async function request(entry, method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    // A raw loopback socket never consults runtime HTTP proxy settings, which
    // otherwise can expose the bearer token to a configured proxy. timeoutMs is
    // a total deadline for connect, request and the full response, not idle time.
    return new Promise((resolve) => {
        let socket;
        let settled = false;
        let connected = false;
        const done = (value, stale = false) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket?.destroy();
            resolve({ value, stale });
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        try {
            const body = JSON.stringify(params);
            socket = connect({ host: '127.0.0.1', port: entry.port });
            socket.on('connect', () => {
                connected = true;
                // HTTP/1.0 avoids chunked responses; explicitly request connection close
                // because older Bun servers can keep delayed HTTP/1.0 replies open.
                socket?.write(`POST /rpc/${method} HTTP/1.0\r\n` +
                    `Host: 127.0.0.1:${entry.port}\r\n` +
                    'Connection: close\r\n' +
                    'Content-Type: application/json\r\n' +
                    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                    `Authorization: Bearer ${entry.token}\r\n\r\n` +
                    body);
            });
            const chunks = [];
            let bytes = 0;
            let headerBytes;
            let contentLength;
            let prefix = Buffer.alloc(0);
            const finishBody = () => {
                if (headerBytes === undefined)
                    return done(null);
                try {
                    const payload = Buffer.concat(chunks).subarray(headerBytes);
                    done(JSON.parse(payload.toString('utf8')));
                }
                catch {
                    done(null);
                }
            };
            socket.on('data', (chunk) => {
                if (settled)
                    return;
                bytes += chunk.length;
                chunks.push(chunk);
                if (headerBytes === undefined) {
                    prefix = Buffer.concat([prefix, chunk]);
                    const separator = prefix.indexOf('\r\n\r\n');
                    if (separator >= 0)
                        headerBytes = separator + 4;
                    if ((headerBytes ?? prefix.length) > 16 * 1024)
                        return done(null);
                    if (headerBytes !== undefined) {
                        const headers = prefix
                            .subarray(0, separator)
                            .toString('latin1')
                            .split('\r\n');
                        const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(headers[0] ?? '');
                        if (!status)
                            return done(null);
                        const code = Number(status[1]);
                        if (code < 200 || code >= 300)
                            // Only statuses meaning "this is not the server you meant" may
                            // rediscover and resend. A 504 is this server's apply deadline:
                            // the handler can still be running, so resending it to another
                            // server could run the command twice. 5xx is never retried.
                            return done(null, [401, 403, 404, 410].includes(code));
                        for (const header of headers.slice(1)) {
                            const colon = header.indexOf(':');
                            const name = header.slice(0, colon).toLowerCase();
                            const value = header.slice(colon + 1).trim();
                            if (name === 'transfer-encoding')
                                return done(null);
                            if (name === 'content-length') {
                                if (contentLength !== undefined || !/^\d+$/.test(value))
                                    return done(null);
                                contentLength = Number(value);
                                if (!Number.isSafeInteger(contentLength) ||
                                    contentLength > 8 * 1024 * 1024)
                                    return done(null);
                            }
                        }
                        prefix = Buffer.alloc(0);
                    }
                }
                const bodyBytes = bytes - (headerBytes ?? bytes);
                if (bodyBytes > 8 * 1024 * 1024)
                    return done(null);
                if (contentLength !== undefined) {
                    if (bodyBytes > contentLength)
                        return done(null);
                    // Bun 1.3.14 can keep an async HTTP/1.0 reply open after sending
                    // its complete Content-Length body; don't wait for EOF in that case.
                    if (bodyBytes === contentLength)
                        finishBody();
                }
            });
            socket.on('end', () => {
                if (contentLength !== undefined &&
                    bytes - (headerBytes ?? 0) !== contentLength)
                    return done(null);
                finishBody();
            });
            socket.on('error', () => done(null, !connected));
            socket.on('close', () => done(null));
        }
        catch {
            done(null, !connected);
        }
    });
}
async function call(dir, expectedPid, options, onSelected, method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    const key = JSON.stringify([
        resolve(dir),
        expectedPid ?? null,
        options.exactPid === true,
    ]);
    const selected = await select(key, dir, expectedPid, options);
    onSelected(selected?.entry ?? null);
    if (!selected)
        return null;
    const deadline = Date.now() + timeoutMs;
    const out = await request(selected.entry, method, params, timeoutMs);
    if (!out.stale)
        return out.value;
    if (selections.get(key) === selected)
        selections.delete(key);
    // Retry only definite pre-dispatch/stale-server failures, never an ambiguous
    // response or timeout that could replay an already executed apply command.
    const replacement = await select(key, dir, expectedPid, options);
    if (!replacement || Date.now() >= deadline)
        return null;
    if (replacement.entry.port === selected.entry.port &&
        replacement.entry.pid === selected.entry.pid &&
        replacement.entry.token === selected.entry.token) {
        if (selections.get(key) === replacement)
            selections.delete(key);
        return null;
    }
    const retry = await request(replacement.entry, method, params, deadline - Date.now());
    if (retry.stale && selections.get(key) === replacement)
        selections.delete(key);
    return retry.value;
}
/**
 * A client for the server in `dir`, preferring `expectedPid`'s.
 *
 * `onSelected` reports the first selection: it is told which entry (or null)
 * discovery chose, until one call of it returns normally. It is a report, not
 * a gate: an observer that throws rejects that call before any request is
 * sent and is asked again on the next call, but nothing stops a later call
 * once an observer has returned. A caller that must never reach another
 * server passes `{ exactPid: true }`. Validated selections are shared by
 * directory, expected PID and exactPid until their file identity changes or a
 * connect/auth/stale-server failure triggers one rediscovery in the same call.
 */
export function createRpcClient(dir, expectedPid, onSelected, options = {}) {
    const discoverOptions = {
        exactPid: options.exactPid,
        discover: options.discover,
    };
    let reportedSelection = false;
    const reportSelected = (entry) => {
        if (reportedSelection)
            return;
        onSelected?.(entry);
        // Counted only after the observer returns, so a throwing one is not
        // silently skipped on later calls.
        reportedSelection = true;
    };
    return {
        async pending(lastReceivedId, sessionId, timeoutMs) {
            const out = await call(dir, expectedPid, discoverOptions, reportSelected, 'pending-notifications', { lastReceivedId, sessionId }, timeoutMs);
            return out?.messages ?? [];
        },
        async apply(request, timeoutMs) {
            const out = await call(dir, expectedPid, discoverOptions, reportSelected, 'apply', {
                ...request,
            }, timeoutMs);
            return out ?? { text: 'apply failed', knobs: {} };
        },
    };
}
