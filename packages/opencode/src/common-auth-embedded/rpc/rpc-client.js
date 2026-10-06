import { connect } from 'node:net';
import { discoverPortFile, } from './port-file.js';
export const DEFAULT_RPC_TIMEOUT_MS = 2_000;
async function call(dir, expectedPid, discoverOptions, onSelected, method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    const entry = await discoverPortFile(dir, expectedPid, discoverOptions);
    onSelected?.(entry);
    if (!entry)
        return null;
    // A raw loopback socket never consults runtime HTTP proxy settings, which
    // otherwise can expose the bearer token to a configured proxy. timeoutMs is
    // a total deadline for connect, request and the full response, not idle time.
    return new Promise((resolve) => {
        let socket;
        let settled = false;
        const done = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket?.destroy();
            resolve(value);
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        try {
            const body = JSON.stringify(params);
            socket = connect({ host: '127.0.0.1', port: entry.port });
            socket.on('connect', () => {
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
                        if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300)
                            return done(null);
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
            socket.on('error', () => done(null));
            socket.on('close', () => done(null));
        }
        catch {
            done(null);
        }
    });
}
/**
 * A client for the server in `dir`, preferring `expectedPid`'s.
 *
 * `onSelected` reports the first selection: it is told which entry (or null)
 * discovery chose, until one call of it returns normally. It is a report, not
 * a gate: an observer that throws rejects that call before any request is
 * sent and is asked again on the next call, but nothing stops a later call
 * once an observer has returned. A caller that must never reach another
 * server passes `{ exactPid: true }`.
 */
export function createRpcClient(dir, expectedPid, onSelected, options = {}) {
    const discoverOptions = {
        exactPid: options.exactPid,
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
