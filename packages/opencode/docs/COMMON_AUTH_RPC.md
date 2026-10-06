# Common-auth RPC boundary

OpenCode embeds the published common-auth 0.9.4 public RPC modules byte-for-byte.
The server and `RpcRequestError` use one canonical `rpc/index.js` instance;
the TUI uses only `rpc/client.js` (client, discovery and their public types).
The private discovery adapter does **not** export a writer. No fetch, proxy,
private transport engine, or producer patch is used.

## Application policy

The application factory remains `{ dir, apply, drain }`. The adapter maps `drain`
only to the public `drainAsync` overload, awaiting even synchronous producers.
Raw pending parameters must be a non-array record containing a nonnegative safe
integer `lastReceivedId`; `sessionId` may be absent or a string, including `''`.
Apply requires one of the six Antigravity commands and string `arguments` with
the same optional session policy. Malformed or empty requests are rejected with
the canonical `RpcRequestError(400)` before application callbacks run.

Notification responses are independently checked at the client boundary. All six
commands, IDs, text, knobs and optional session strings survive unchanged. Unknown
commands or malformed records produce `[]`, never an unvalidated dialog request.
Malformed apply replies use `{ text: 'apply failed', knobs: {} }`.

## Deliberate discovery tightening

The old no-PID discovery selected the newest live server. Both adapters now pass
`exactPid: true`: an absent or unmatched expected PID fails closed, with no socket
and no fallback to another live process. This is a deliberate safety tightening,
not compatibility with newest-live selection. Discovery has no `secureDir`
option and does not create or repair directories. It retains malformed files;
valid stale-process files can still be removed by public discovery.

Only the server writer uses `secureDir: true`, creating and repairing mode 0700
directories. Public exclusive (`wx`) staging uses mode 0600 and cleans up only a
stage it created. No cross-project sweep is enabled. Shutdown uses the public
tracked-connection stop, coalesces one Promise, closes partial and in-flight peers,
and removes its port file only if the current port and token still match.

## Timing and wire differences

Receipt timeout is 2000 ms, apply deadline is 120000 ms, and socket idle timeout
is disabled with `timeoutMs: 0`. Receipt, idle, application and client budgets are
distinct. Client defaults remain 2000 ms; dialog callers can supply 120000 ms.
The public client uses direct `node:net` loopback sockets, ignoring upper/lower
HTTP/HTTPS/ALL proxy environment variables. Its total connect/request/full-response
deadline starts **after discovery**; scheduling or discovery can add elapsed time.
It caps headers at 16 KiB and bodies at 8 MiB and destroys sockets on completion,
malformed/non-2xx responses or deadline expiry.

The accepted request cap is decimal 1,000,000 bytes rather than 1 MiB. Generic
lowercase public error text, charset/header differences, unknown-method
authentication/parsing order, and malformed-file retention are accepted wire
differences. Empty bytes parse as `{}` publicly but application validation rejects
them before effects. No parity toggle restores the old transport.

An apply deadline answers live sockets with 504 `{ error: 'handler deadline exceeded' }`.
Timeout, client closure and stop do not cancel entered apply or drain callbacks;
late results are discarded. The deadline timer is unreferenced so unresolved work
does not keep a stopped host alive. Natural process exit, live 504 and delayed
effects are separate properties, not interchangeable socket-close observations.

The RPC acceptance fixture runs reached 6500 ms apply/drain and shorter nonzero
idle controls on Node 20.0.0/24.16.0 and Bun 1.3.14/1.4.2. The Bun 1.3.14
observation spans its four-second native idle sweep; a subsecond test alone would
not establish disabled idle behavior. These runtime checks do not certify other
platforms or substitute for real-host integration checks.
