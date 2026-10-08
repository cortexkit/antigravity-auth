# Bun 1.3.14 shutdown trace — observation, not acceptance

## Frozen inputs and execution limit

This diagnostic selected only `rpc.shutdown_ownership`, the named four-peer server-shutdown test callback
requiring server-driven closure of four peers, including an unfinished-header
peer. It diagnosed adoption implementation
`e0426393cfda2e03674ec25cfd1b53256ee9944b`. The shutdown contract callback enters
apply and async drain, stops the server, then awaits natural peer closure. It was copied
byte-for-byte, with SHA256
`066844e2aedda316921bbcd77bfeb650cd5d13dac9803b8d84b9299ceab45721`.
Its comment-free AST also matched. The original runner and 500/1000 ms guards
were retained, including the original 15000 ms outer case guard. No arbitrary
sleep, assertion change, callback cancellation, deadline change or semantic fix
was introduced.

Before and after the sole loopback diagnostic, `shutdown-diagnostic.mjs` verified
the following copied inputs for the shutdown callback observed by `shutdown-observer.mjs`:

- all 41 hydrated payloads / 722526 bytes against the handoff receipt;
- all 17 frozen component source files against the independent snapshot and
  committed `e042` blobs;
- all 26 canonical files (24 public JS/declarations, manifest and notice) against
  their committed bytes;
- the genuine Bun 1.3.14 executable SHA256
  `e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233`;
- canonical public `rpc-server.js` SHA256
  `a31758c7d74ded7b781e9b88170fc50c2b3fbd7016413adc92fc6ed039237934`.

One Bun13 child exited naturally with status 1, no signal or execution error,
and only the original `tracked peers still open` error. No other runtime,
matrix, live host or external network was exercised. The exclusive
`sole-invocation.receipt` prevents a second run of this prepared directory.
Approval covered this one bounded diagnostic. The commands record its execution,
not permission for another run.

## Observers and ordering

External synchronous observers delegated the original HTTP server emit/close
methods, socket emit/write/destroy methods and original timer callbacks. They
added no timer or network operation. The two existing deferred resolvers were
wrapped synchronously to record actual apply/drain entry before delegating their
original resolution. No additional promise hop was introduced.

Client labels follow the unchanged loop that connects each socket and writes its
request before continuing. Server
facades are paired to clients by loopback endpoint ports. Bun's facade is its
Node-compatible socket wrapper; reading a request/socket getter solely for logging
could instantiate it before native handling does. Observers watch actual runtime access instead.

The callback's `finally` destroys the fixture's client sockets. Its unchanged
source line identifies that cleanup, separating earlier natural EOF/close from
cleanup-driven close events. JSON traces are `.receipt` data so
source format/write gates do not rewrite them. Bearer text in wire records is
redacted; frame byte counts and original frame hashes are retained.

## Measured lifecycle and wire result

Times below are observed elapsed milliseconds from observer initialization, not
guaranteed deadlines. In paired table cells, the first time is the earlier named
event: server connection before request, or client EOF before close. A fixture
destroy time is the later test cleanup action, not evidence of natural closure.
The server listened at 26.848 ms. The four clients used local ports
51201 / 51202 / 51204 / 51205 and server port 51198.

| Peer | Sent wire | Server connection/request observed | Server tracked destroy | Client EOF / close | Fixture client destroy |
| --- | --- | --- | --- | --- | --- |
| Partial headers | 32 bytes: `POST /rpc/apply HTTP/1.1\r\nHost: `; no header terminator | Neither | None | 654.866 / 658.020, **after cleanup began** | 654.076 |
| Partial body | Complete HTTP/1.0 headers, Content-Length 46, only `{` body byte | 118.466 / 118.604 | 148.560 | 149.263 / 149.905, before cleanup | 654.358, already closed |
| Entered apply | Complete headers and 46-byte JSON body | 121.596 / 121.625 | 148.774 | 149.773 / 149.923, before cleanup | 654.393, already closed |
| Entered async drain | Complete headers and 20-byte JSON body | 140.160 / 140.208 | 148.808 | 149.839 / 149.928, before cleanup | 654.402, already closed |

Apply entered at 132.443 ms and async drain at 140.977 ms. The
`rpc.shutdown_ownership` test callback waits for both application callbacks to
enter so shutdown is tested against real in-flight work, rather than before a
request is handled. It then rewrites its fixture PID file to the other-token
record to test cleanup ownership and calls stop. The observed server calls were:

1. `close()` at 148.130 ms, returning at 148.284;
2. `closeAllConnections()` at 148.326, returning at 148.349;
3. three `destroy()` calls at public `rpc-server.js:279`, acting on the sockets
   tracked through the server's connection/request facades; the fourth peer had
   not entered that set;
4. server close callback at 149.137 ms.

The 1000 ms timer rejects waiting for `stop()` if completion has not won the
stop-completion race. It was scheduled at 148.861 ms.
The server close callback ran at 149.137 ms, and the stop-completion race was
already won before the distinct 500 ms peer-close guard was scheduled at 150.465 ms.
That guard fired at 653.159 ms, **502.694 ms after scheduling**. At that instant
only the partial-header client remained open, not destroyed, with neither EOF
nor close observed. The other three peers had already closed. This is a real
close-event failure, not a replacement sleep-based test.

The distinct 500 ms timer rejects waiting for the four peer-close events when
one is missing. Here the partial-header client had not closed, so that waiting
race rejected; this says nothing about cancellation of entered callbacks.
The shutdown test's `finally` began cleanup at
654.065 ms. The partial-header client was explicitly destroyed at 654.076 ms;
its subsequent EOF/close cannot establish server-driven closure. The original
1000 ms stop-guard timer later fired at 1157.447 ms after its race was already won;
that later callback was not a stop failure. The process exited at 1157.666 ms.

## Measured mechanism and source authority

The public common-auth 0.9.4 RPC implementation, copied verbatim into Antigravity
at build time rather than implemented in its adapter, is at
`packages/opencode/src/common-auth-embedded/rpc/rpc-server.js`, pinned by SHA256
`a31758c7d74ded7b781e9b88170fc50c2b3fbd7016413adc92fc6ed039237934`, registers sockets through
`server.on('connection', ...)` at lines 103–106, then its stop sequence at
273–280 calls `server.close(...)`, `server.closeAllConnections?.()`, and finally
destroys those tracked sockets. The trace observed exactly three connection
events/facades, with no server connection/request facade for the incomplete-header
peer. Consequently the
manual destroy loop had no handle for that peer.

Calling `close()` first clears the runtime server
handle before the later `closeAllConnections()` can request force-stop. This does
not establish that standalone force-stop cannot close a pre-header connection. Function text
captured from the exact binary, before wrapping these methods, observed:

```text
Server.close:
  let server = this[serverSymbol];
  ...
  this[serverSymbol] = @undefined;
  ...
  this.listening = !1, server.closeIdleConnections(), server.stop();

Server.closeAllConnections:
  let server = this[serverSymbol];
  if (!server)
    return;
  ...
  server.stop(!0);
```

The observed method-text hashes are
`fcfea8e8573bbb40c231640cd04cd31e69ead459400318706772affbda80a86d`
for close and
`834af91b8b763c434f0e2e579bdf22972072768bb561d78655fa724e1461d1ec`
for closeAllConnections. With common-auth 0.9.4's close-first stop sequence, the
first method clears the reference the second method needs. The later forced-close
method therefore takes its no-server return path rather than reaching
`server.stop(true)`. The trace and observed method text explain the concrete gap:
ordinary close completes, the force-close call has lost its handle, and manual
fallback covers only already-observed HTTP connection facades.

These observations support conclusions about the measured public server stop
sequence on this runtime. They do not authorize patching that sequence here,
reordering calls, changing the guard, or asserting that standalone native force-close
cannot work. The missing event/handle is not attributed to machine load.

The Bun-version-tagged native source supplied for this diagnostic corroborates
how incomplete HTTP requests are parsed:
`packages/bun-uws/src/HttpContext.h:185–199` initializes native socket state on
open; `242–281` receives/parses bytes; the request-consumption callback at
`281–322` marks a pending HTTP request and routes it. Its SHA256 is
`651416caf9aca7c00a25bd09ece2eeb25bf7c8903cedc6266468caab4fa15640`.
The supplied set **does not contain** the JS node:http connection/request event
bridge or Server.close/closeAllConnections implementation. Function text is an
observation of the pinned executable, not replacement native implementation
source. Bun intrinsics such as `@undefined`, hidden helper implementations and
native operations remain outside this source proof. A separate exact JS source
freeze can establish that layer before any semantic proposal. The original
source-authority records mention Bun 1.4.2, but that version's source was not used
for this trace.
The observer temporarily wraps an event-emission method to record events. The
broad raw source collection includes that installed wrapper's body, which is not
an original Bun implementation and is not used as runtime-implementation evidence. The focused extract
contains the original methods used for the reasoning above.

## Evidence and provenance

Raw evidence files from the isolated diagnostic fixture, not live-host recordings, are under
`test/common-auth-094-adoption/rpc/.owned/shutdown-trace-jlGTy1/`:

- `preparation.receipt`, `observer-config.receipt`, `sole-invocation.receipt`;
- the exact selected `shutdown-case.mjs`, observer and entry copies;
- `stdout.receipt`, empty `stderr.receipt`, `execution.receipt`;
- `shutdown-trace.receipt` (138732 bytes), `analysis.receipt`;
- `relevant-builtin-source.receipt` containing original observed method text.

The embedded public server and all seventeen RPC adoption contract bodies remain
tied to the exact implementation commit named above, abbreviated `e042` below. The
component provenance is not a declaration mismatch: cumulative
`0ceb78fb6bd6d7684df45ffd4fb51851b58dd54a..e042` has 17 paths, while the last
delivery's declaration correctly covered its 12-path `8be8506..e042` revision.
The five inherited-only paths are:

- `packages/opencode/src/rpc/port-file.ts`;
- `packages/opencode/src/rpc/rpc-client.ts`;
- `packages/opencode/src/rpc/rpc-server.test.ts`;
- `packages/opencode/src/rpc/rpc-server.ts`;
- `test/common-auth-094-adoption/rpc/.gitignore`.

Their absence from that revision declaration is not a reason to edit adapters.
Package, CI and release integration, plus source-comment corrections outside
this preserved diagnostic, belong to the main integration. This delivery adds
diagnostic preparation/observation/reporting only;
it does not establish successful shutdown or four-runtime RPC acceptance. Acceptance
still requires all four peers to close naturally after server stop, and every
one of the seventeen RPC contracts to pass on all four exact runtimes. This
diagnostic preserves a failing measurement, not acceptance; a separate stop-order
candidate must not be added to these diagnostic results.
