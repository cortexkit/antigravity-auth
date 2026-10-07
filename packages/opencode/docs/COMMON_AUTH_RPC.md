# Common-auth RPC boundary

OpenCode embeds the published common-auth 0.9.4 public RPC modules byte-for-byte.
The server and `RpcRequestError` resolve through the same canonical public module
instance via `rpc/index.js`. The TUI's client-only `rpc/client.js` entry does not
import the server or server-registry modules and exposes no writer. Its runtime
closure is client/port-file/rpc-client; the shared public port-file module is
reachable for discovery, while its declaration dependencies are broader.
The private `rpc/port-file.ts` discovery module exposes discovery and public
types, not `writePortFile`. The former private fetch transport was
removed; current RPC calls use the public direct-loopback client. No second
transport engine or producer patch is used.

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

The old no-PID discovery selected the newest live server. The private
`createRpcClient` factory and `discoverPortFile` wrapper both pass `exactPid: true`.
An absent or unmatched expected PID returns the discovery/client fallback without
a client socket or selection of another live process. This is a deliberate safety tightening,
not compatibility with newest-live selection. Discovery has no `secureDir`
option and does not create or repair directories. Malformed discovery files
remain untouched;
valid stale-process files can still be removed by public discovery.

Only the server writer uses `secureDir: true`, creating and repairing mode 0700
directories. Public exclusive (`wx`) staging uses mode 0600 and cleans up only a
stage it created. The server does not sweep or clean up other projects' files.
Within the supplied RPC directory, discovery may remove valid dead-PID files;
it does not remove malformed files. Shutdown uses the public
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

Routine units run every RPC contract on the current test runtime without personal
runtime paths. The separate mandatory `runtime-matrix.mjs` runner requires explicit
`--node20`, `--node24`, `--bun13` and `--bun14` executable paths and exact versions
20.0.0/24.16.0/1.3.14/1.4.2. Missing paths or versions fail rather than skip.
CI and release verification must provision those tools and invoke the matrix;
the runner does not download them. See the RPC acceptance README for commands.

The `rpc.timeout_zero` case measures reached 6500 ms apply/drain work against
shorter nonzero idle controls. On Bun1.3.14 this spans the four-second native idle
sweep; a subsecond test alone cannot establish disabled idle behavior.
`rpc.live_504` separately measures the apply deadline, and
`rpc.client_deadline_socket_close` measures the total client-response deadline
and teardown. These checks do not certify other platforms or replace real-host
integration. Receipt hashes record executed candidate bytes; independent expected
artifact hashes must come from a separate frozen source, not these self-records.
