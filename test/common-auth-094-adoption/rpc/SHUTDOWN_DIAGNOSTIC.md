# Bun 1.3.14 shutdown trace — observation, not acceptance

## Frozen inputs and execution limit

This diagnostic selected only `rpc.shutdown_ownership` from immutable candidate
`e0426393cfda2e03674ec25cfd1b53256ee9944b`. The original callback was copied
byte-for-byte, with SHA256
`066844e2aedda316921bbcd77bfeb650cd5d13dac9803b8d84b9299ceab45721`.
Its comment-free AST also matched. The original runner and 500/1000 ms guards
were retained, including the original 15000 ms outer case guard. No arbitrary
sleep, assertion change, callback cancellation, deadline change or semantic fix
was introduced.

Before and after the sole loopback diagnostic, the preparer checked:

- all 41 hydrated payloads / 722526 bytes against the handoff receipt;
- all 17 frozen component source files against the independent snapshot and
  committed `e042` blobs;
- all 26 canonical files (24 public JS/declarations, manifest and notice) against
  their committed bytes;
- the genuine Bun 1.3.14 executable SHA256
  `e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233`;
- canonical public `rpc-server.js` SHA256
  `a31758c7d74ded7b781e9b88170fc50c2b3fbd7016413adc92fc6ed039237934`.

Exactly one Bun13 child executed. It exited naturally with status 1, no signal,
no execution error, and only the original `tracked peers still open` case error.
No other runtime, matrix, live host or external network was exercised. The
exclusive `sole-invocation.receipt` prevents running the prepared directory again.
The authorization is consumed; these commands are not a request for another run.

## Observers and ordering

External synchronous observers delegated the original HTTP server emit/close
methods, socket emit/write/destroy methods and original timer callbacks. They
added no timer or network operation. The two existing deferred resolvers were
wrapped synchronously to record actual apply/drain entry before delegating their
original resolution. No additional promise hop was introduced.

Client labels follow the unchanged sequential connect/admit/write loop. Server
facades are paired to clients by loopback endpoint ports. Request socket getters
were observed only when runtime code itself accessed them; an observer-side eager
getter read could have manufactured Bun's lazy facade too soon.

The original `finally` cleanup was identified from its unchanged source line.
EOF and close events before that cleanup are distinguished from those observed
after the fixture's own client-side destroy. JSON traces are `.receipt` data so
source format/write gates do not rewrite them. Bearer text in wire records is
redacted; frame byte counts and original frame hashes are retained.

## Measured lifecycle and wire result

Times below are milliseconds from observer initialization, not wall-clock promises.
The server listened at 26.848 ms. The four clients used local ports
51201 / 51202 / 51204 / 51205 and server port 51198.

| Peer | Sent wire | Server connection/request observed | Server tracked destroy | Client EOF / close | Fixture client destroy |
| --- | --- | --- | --- | --- | --- |
| Partial headers | 32 bytes: `POST /rpc/apply HTTP/1.1\r\nHost: `; no header terminator | Neither | None | 654.866 / 658.020, **after cleanup began** | 654.076 |
| Partial body | Complete HTTP/1.0 headers, Content-Length 46, only `{` body byte | 118.466 / 118.604 | 148.560 | 149.263 / 149.905, before cleanup | 654.358, already closed |
| Entered apply | Complete headers and 46-byte JSON body | 121.596 / 121.625 | 148.774 | 149.773 / 149.923, before cleanup | 654.393, already closed |
| Entered async drain | Complete headers and 20-byte JSON body | 140.160 / 140.208 | 148.808 | 149.839 / 149.928, before cleanup | 654.402, already closed |

Apply entered at 132.443 ms and async drain at 140.977 ms. The unchanged callback
awaited both entries before rewriting its owned PID file to the other-token
record and calling stop. The observed server calls were:

1. `close()` at 148.130 ms, returning at 148.284;
2. `closeAllConnections()` at 148.326, returning at 148.349;
3. three tracked server socket `destroy()` calls at public `rpc-server.js:279`;
4. server close callback at 149.137 ms.

The original 1000 ms stop guard was scheduled at 148.861 ms. Stop completed
within it: the original 500 ms peer-close guard was then scheduled at 150.465 ms.
That guard fired at 653.159 ms, **502.694 ms after scheduling**. At that instant
only the partial-header client remained open, not destroyed, with neither EOF
nor close observed. The other three peers had already closed. This is a real
close-event failure, not a replacement sleep-based test.

The original guard rejected, and the original `finally` began cleanup at
654.065 ms. The partial-header client was explicitly destroyed at 654.076 ms;
its subsequent EOF/close cannot establish server-driven closure. The original
1000 ms timer later fired at 1157.447 ms, and the process exited at 1157.666 ms.

## Measured mechanism and source authority

The canonical public server source registers sockets through
`server.on('connection', ...)` at lines 103–106, then its stop sequence at
273–280 calls `server.close(...)`, `server.closeAllConnections?.()`, and finally
destroys those tracked sockets. The trace observed exactly three connection
events/facades, never one for the incomplete-header peer. Consequently the
manual destroy loop had no handle for that peer.

There is also an important **close-order interaction**, not evidence that native
force-close itself is incapable of closing a pre-header socket. Function text
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
for closeAllConnections. With the public library's close-first ordering, the
first method clears the reference the second method needs. The later forced-close
method therefore takes its no-server return path rather than reaching
`server.stop(true)`. The trace and observed method text explain the concrete gap:
ordinary close completes, the force-close call has lost its handle, and manual
fallback covers only already-observed HTTP connection facades.

This is suitable source/wire evidence for OAIAUTH about the **measured public stop
sequence on this runtime**. It is not permission to patch that sequence here,
reorder calls, change the guard, or assert that a standalone native force-close
cannot work. It does not blame machine load for the missing event/handle.

The supplied exact-tag native source corroborates the parsing boundary:
`packages/bun-uws/src/HttpContext.h:185–199` initializes native socket state on
open; `242–281` receives/parses bytes; the request-consumption callback at
`281–322` marks a pending HTTP request and routes it. Its SHA256 is
`651416caf9aca7c00a25bd09ece2eeb25bf7c8903cedc6266468caab4fa15640`.
The supplied set **does not contain** the JS node:http connection/request event
bridge or Server.close/closeAllConnections implementation. Function text is an
observation of the pinned executable, not replacement native implementation
source. Bun intrinsics such as `@undefined`, hidden helper implementations and
native operations remain outside this source proof. A separate exact JS source
freeze can establish that layer before any semantic proposal. Historical 1.4.2
mentions in the original authority records are not source inputs for this trace.
The broad raw source collection also includes an installed observer emit wrapper;
that entry is not used as runtime-implementation evidence. The focused extract
contains the original methods used for the reasoning above.

## Evidence and provenance

Owned raw evidence is under
`test/common-auth-094-adoption/rpc/.owned/shutdown-trace-jlGTy1/`:

- `preparation.receipt`, `observer-config.receipt`, `sole-invocation.receipt`;
- the exact selected `shutdown-case.mjs`, observer and entry copies;
- `stdout.receipt`, empty `stderr.receipt`, `execution.receipt`;
- `shutdown-trace.receipt` (138732 bytes), `analysis.receipt`;
- `relevant-builtin-source.receipt` containing original observed method text.

Production and all seventeen contract bodies remain pinned to `e042`. The
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
The parent's package/CI/release wiring and stable-tree comment corrections remain
reserved. This delivery adds diagnostic preparation/observation/reporting only;
it does not close the shutdown or runtime-matrix acceptance gate.
