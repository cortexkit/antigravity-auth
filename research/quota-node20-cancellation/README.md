# Quota manager fetch cancellation on the Node 20.0.0 floor

`createQuotaManager` combined its disposal controller with the per-fetch
deadline through `AbortSignal.any`. Node 20.0.0 has `AbortSignal.timeout`
but not `AbortSignal.any` (added in Node 20.3.0), so on that runtime every
quota refresh failed before the fetch callback ran and was recorded as an
account failure with backoff.

The fix hands the callback the manager's own controller signal and forwards
the `AbortSignal.timeout` deadline onto that controller with the deadline's
`TimeoutError` reason. The forwarding listener is removed once the callback
settles. Because the controller can now abort for either reason, only the
manager's `disposed` flag means shutdown: a deadline abort records normal
exponential backoff, shutdown records none, and a callback that resolves
after shutdown still yields an error result.

The deadline is created inside the refresh's existing try/catch, so a
`fetchTimeoutMs` the runtime rejects (for example `-1`) still becomes the
refresh's error result with backoff, as it did before. A refresh that fails
like that never reaches an `await`, so its `finally` block runs before
`refreshAccount` would record the promise as in flight. The manager now only
records it as in flight while its controller is still registered; the base
source recorded the already-settled promise, after which every later refresh
of that account, forced or not, returned the old error without trying again.

## Runtime receipts

All runs below used the Linux build runner (`ck-motor`), bun 1.4.2,
`bun test --isolate src/quota-manager.test.ts` from `packages/core`. Each was
started as a background AFT task. Its raw output is copied from the AFT
recorder into `receipts/<run>/`: `stdout.txt` and `stderr.txt` are byte copies
of the recorder's `io/stdout` and `io/stderr`, `command.sh` is the exact
command, and `record.json` holds the recorder's task ID, status, timestamps,
duration, hard-kill timeout and exit code. Bun writes the per-test lines to
stderr; the commands print each gate's exit code (`test exit N`) to stdout.

`receipts/superseded-positive-before-inflight-guard/` is the first positive
run after the deadline moved back inside the `try`. Its invalid-deadline test
failed at the forced retry (48 pass / 1 fail). That failure led to the
in-flight guard.

No trusted Node 20.0.0 runtime is available: the Mac has Node 20.19.2 (which
has `AbortSignal.any`), 24.x and 26.10.0; the Linux runner has Node 24.21.0.
The tests remove `AbortSignal.any` from the running global for one test at a
time and restore the original property descriptors in `finally`. That is a
synthetic witness of the missing API, not a Node 20.0.0 run.

### Positive run (final source)

Task `bash-30b8f79de736723e` (`receipts/positive`): Biome 2.5.3 `check --error-on-warnings` on both
files, exit 0; `bun run typecheck` (`tsc --noEmit`, TypeScript 6.0.3), exit 0;
tests 49 pass, 0 fail, 184 expect() calls.

### Controls

Each control was applied after staging the live files (empty `git diff
--stat`), showed a one-line `git diff --stat` change in
`packages/core/src/quota-manager.ts` (C0 replaced the file with the base
version), and was restored with `git checkout -- <path> && touch <path>` back
to an empty `git diff --stat`. Every run, including the positive one, has
recorder status `completed` with wrapper exit code 0 after 5 to 9 seconds,
far below its 30-minute hard-kill timeout, so none was killed. The wrapper
exits 0 because each command ends with `echo "test exit $?"`. The test
runner's own exit code is that stdout line: 0 for the positive run and 1 for
each control and the superseded run.

| ID | Control | Task | Result |
| --- | --- | --- | --- |
| C0 | base `d2d0e5e6` source with the new tests | `bash-dcd39298b62722fc` (`receipts/C0-base-source`) | 44 pass / 5 fail: all five new tests. The success test gets `"error"` instead of `"ok"`; a direct probe on the base source, run earlier in the foreground with no recorder receipt, returned `AbortSignal.any is not a function`. The invalid-deadline test fails only at the forced retry (backoff `Expected: 1002000, Received: 1001000`), which shows the stale in-flight entry in the base source |
| C1 | `forwardDeadline` made a no-op | `bash-43cd6d7cec4b8925` (`receipts/C1-no-deadline-forwarding`) | 48 / 1: only `aborts the callback signal at the fetch deadline and records normal backoff` (`Expected: not Symbol(still pending)` after the 1 s bound) |
| C2 | catch guard `disposed \|\| controller.signal.aborted` (deadline treated as shutdown) | `bash-df9aa9dfb6b77822` (`receipts/C2-timeout-as-disposal`) | 48 / 1: only the deadline test (`Expected: 1001000, Received: 0`) |
| C3 | post-fetch `if (disposed)` guard disabled | `bash-edab5c5bcb05186f` (`receipts/C3-no-post-dispose-guard`) | 48 / 1: only `does not report success for a callback that resolves after dispose` (`Expected: "error", Received: "ok"`) |
| C4 | `entry.controller?.abort()` removed from `dispose()` | `bash-4940a8a8505adbb7` (`receipts/C4-no-dispose-abort`) | 47 / 2: `aborts the callback signal on dispose without recording backoff` (still pending after 1 s) and the existing `dispose > aborts in-flight fetches and rejects subsequent refreshes` |
| C5 | `deadline?.removeEventListener` removed from `finally` | `bash-d71e13137b2f725f` (`receipts/C5-no-listener-removal`) | 46 / 3: the three listener-counting tests (`Expected: 0, Received: 1`) |
| C6 | deadline creation moved before the `try` | `bash-e0ff670abb79edb7` (`receipts/C6-deadline-outside-try`) | 48 / 1: only `returns an error result with backoff when the fetch deadline cannot be created` (refresh rejected with `TypeError: Value -1 is outside the range [0, 9007199254740991]`) |
| C7 | in-flight guard replaced with `if (true)` | `bash-8fa82349ab42f955` (`receipts/C7-no-inflight-guard`) | 48 / 1: only the invalid-deadline test (`Expected: 1002000, Received: 1001000`) |

Tests that observe a pending promise race it against a bounded timer, release
the callback's barrier, and only then assert, so a failing control cannot
leave a fetch callback or `dispose()` waiting forever.
