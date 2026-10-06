# Common-auth logging bridge

OpenCode consumes the canonical, byte-preserved common-auth 0.9.4 public logger
root at `src/common-auth-embedded/logger/index.js`. The provider and each TUI file
writer create **separate sink-only `createLoggerInstance` engines**. They never
configure the library's global/default engine, use its file mode, flush a buffer,
schedule a flush timer or install lifecycle handlers.

## Levels and destinations

- The provider explicitly supplies a dynamic level function, initially `debug`.
  Operator `error`, `warn`, `info` and `debug` levels apply immediately to existing
  channels; `trace` maps to `debug`. The library's default `info` is not equivalent.
- `debug_tui` forwards scrubbed provider records to `client.app.log`, independently
  of `debug` file tracing. `OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1` (or `true`, ignoring
  case) independently enables the provider console destination. Otherwise provider
  logging is silent. A failed destination must not prevent another destination.
- The TUI explicitly supplies `debug` and writes only to its retained file writer,
  regardless of either console environment variable or provider level changes.
  No TUI import loads provider logging, debug streams, accounts, storage or OAuth.
- Channels/services such as `antigravity.refresh-queue` and `antigravity.tui` must
  be static nonsecret module names. Common-auth does not redact channel names.

## Privacy and diagnostic retention

Both engines pass the dependency-free
`src/logging/provider-key-policy.ts` classifier as `extraSecretKeys`. The library
normalizes keys to lowercase and removes hyphens/underscores. Keys containing
`token`, `refresh`, `access`, `project`, `fingerprint`, `deviceid`, `sessionid`,
`sessiontoken`, `secret`, `password`, `apikey` or `clientsecret` are fully replaced
with `***REDACTED***`, even when the value is an object, array or number. This
intentionally includes fields such as `tokenCount`; use `count` for diagnostics.

Common-auth also scrubs Bearer, JWT-shaped, `sk-` and sufficiently long `ckh_`
values in messages and nested data. Error name/message/stack, code/status/cause
and enumerable custom fields are retained and scrubbed, including cross-realm
Errors. Cycles become `[Circular]`; Error causes beyond eight Errors become
`[Truncated]`. Redaction creates new data and does not mutate the caller's input.
Event/notification IDs, command names, counts, status and code remain useful.
Secret absence with erased Error details is not a valid privacy result.

Capture sinks adapt `{channel,level,message,data}` to
`{service,level,message,extra}`. Only checked record-shaped data is forwarded as
`extra`. Provider synchronous and asynchronous host logging failures are contained.

This bridge does **not** comprehensively redact the separate `debug.ts` request
trace/dump stream, AGY calls or direct core console output. Debug partial identifier
masks remain a different policy; do not treat this bridge as blanket log privacy.

## Retained TUI file contract

`ANTIGRAVITY_AUTH_TUI_LOG_FILE` overrides the destination; otherwise it is
`<XDG_STATE_HOME or ~/.local/state>/cortexkit/antigravity-auth/tui.log`.
`getLogPath()` returns the chosen path. There is no temporary-file fallback.
Every write is immediate, with prefix `[opencode-antigravity-auth/tui] ` followed
by JSON `{ts,level,message,extra?}` and a newline. `ts` is epoch milliseconds;
empty `extra` is omitted.

Before writing, a file at least **1,000,000 bytes** is tail-truncated using the last
200 newline-split entries (including the final empty entry when present). The
writer creates/repairs the parent to `0700` and repairs the file to `0600` after
every append and truncation (POSIX modes are best-effort on Windows). File,
serialization, permission and rotation failures silently drop diagnostics; none
write to stdout/stderr. The public logger's 500ms/50-line buffer, 5MiB rotation and
three backups are not used.

## Core ownership and terminal boundary

The unchanged core nullable global `setLogSink` remains last-registration-wins.
OpenCode initialization registers one bridge; reinitialization uses the latest
client. There is no context/slot/global-isolation redesign and no shutdown clearing
of another harness's registration. `ANTIGRAVITY_CORE_CONSOLE_LOG` independently
prints direct core records **even when a sink exists**; that opt-in is outside
bridge privacy. TUI load/render/poll/file failures must never produce plugin
terminal diagnostics, even with both console opt-ins set. Host UI rendering is
not logging.

## Verification

`bun test --isolate test/common-auth-094-adoption/log/` runs the named logger
contracts against source and an OpenTUI test-render/load/poll terminal witness.
After `npm run build`, `node test/common-auth-094-adoption/log/contract.mjs` runs
the same seven non-render logger contracts against the actual adapters in a
temporary esbuild Node bundle with canonical core module identity. The handwritten
library tsc output uses Bundler resolution; the test does not patch extensionless
imports or install a Node compatibility resolver. Running
`bun test/common-auth-094-adoption/log/contract.mjs` runs those contracts against
source without a test preload. Node tests do not claim TSX rendering support;
the OpenTUI test renderer does not replace official-host/platform acceptance.
