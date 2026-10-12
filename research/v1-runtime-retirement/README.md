# OpenCode 1 runtime replacement and loader disposal

Witnesses for two findings of the vault-exclusivity final audit (report at
`d0d1301c:research/vault-exclusivity-final-audit/REPORT.md`, F1 and F4), taken
on base `d2d0e5e6` with only the witness tests added. Product code was not
changed when these logs were captured.

## Witnesses

| Test | File | Composition |
| --- | --- | --- |
| a reload keeps a stream admitted by the replaced runtime alive | `packages/opencode/src/plugin/shared/request-services.test.ts` | real `createAuthLoader` + real `createPluginLifecycle` + real `createRequestExecutor` per runtime over an owned `CoreAccountManager` (`makePool`); the transport returns an SSE body that sends one event and holds |
| two concurrent first local requests after vault custody reload the local runtime once | same | same, with `readAuthority` switched vault → local; a second account load, if one happens, waits until the first request is streaming |
| final shutdown aborts a stream still held by a replaced runtime and waits for it | same | same; positive control for the intended fix (final shutdown must still abort and drain retired work) |
| builds and sends no vault runtime when the loader is disposed during the request authority read | `packages/opencode/src/plugin/auth-loader.test.ts` | real loader + real lifecycle; the request's `readAuthority` is held, the lifecycle is disposed, then the read resolves `vault` |

No fixture disposes, aborts or errors a stream: the only abort source in the
F1 compositions is `createRequestExecutor().dispose()`.

## Raw outcomes on the base (`f1-red.log`, `f4-red.log`)

- F1 reload: the held stream's pending read rejects with
  `The Antigravity request executor is disposed`, thrown from
  `request-services.ts:2817` (`shutdown.abort`) via `auth-loader.ts:374`
  (`await previousRuntime?.dispose()`) under `reload`.
- F1 concurrent first local requests: `loads: 2, runtimes: 2`; the first
  request's stream rejects with the same executor-disposed error once the
  second request's reload installs a second runtime. The duplicate reload is
  real.
- F1 final-shutdown control: fails at the first step (the stream is already
  aborted by `reload`), as expected before a fix.
- F4: after `lifecycle.dispose()` resolved, the request built a vault runtime
  and sent on it (`events: ["lifecycle disposed", "vault runtime built",
  "vault send"]`, outcome `vault-after-dispose`); `dispose` of that runtime
  never ran.

## Fix (design A: tracked retirement)

- `createRequestExecutor().retire()` stops admitting requests without
  aborting the admitted ones; it resolves after every admitted request and
  retained body has finished, then releases retry and warmup state.
  `dispose()` still aborts everything, including a retirement in progress.
- `createFetchInterceptor().retire()` refuses later Generative Language
  requests (it never passes them upstream), waits for requests that entered
  `fetch` before retirement to reach the executor, then retires the executor.
- `PluginLifecycle.replaceAccountRuntime(manager, queue, requests)` stops
  the old refresh queue's timers at once and waits for a refresh it already
  has under way. It retires the old request runtime and keeps the old
  manager open, in a record final disposal can see, until both that refresh
  and that retirement have finished; only then is the manager disposed
  (which flushes its pending saves). Final disposal aborts the live and
  every retired request runtime, waits for them and for every record, then
  disposes the live queue and manager, all before producers, the sidebar
  drain and consumers (custody, store repository).
- `createFetchInterceptor().dispose()` also waits for requests still reading
  their admission or the host sign-in; those requests stop at the next
  check after that read, so nothing is read or sent after disposal reports
  done.
- The auth loader routes new requests to the new runtime before handing it
  to the lifecycle, no longer disposes a replaced runtime itself, joins
  concurrent first local requests onto one reload, and re-checks `closed`
  after the authority read and after the vault runtime is constructed. The
  OpenCode 1 activation-marker guard (`readLocalHostAuth`) is unchanged in
  both the initial load and reload.

## Witness adaptations after the fix

- The `createFetch` of the F1 regression tests in
  `shared/request-services.test.ts` ("OpenCode 1 runtime replacement with
  admitted streams") exposes `retire: () => executor.retire()`, which
  the loader now requires of a local runtime.
- `runtimeLoader` gives every loaded manager one shared in-memory store with
  a save log, and records when each load's manager is disposed.
- End-of-stream assertion: after the held stream's last event the engine
  appends a usage-summary event, so the original
  `readRest(...).trim() === ''` could never hold once the stream survived.
  The witness now reads the rest of the stream until the reader reports
  `done`, and requires that remainder to contain no `error`, the upstream
  body to be uncancelled (`held.cancelled() === false`), and the replaced
  manager to be disposed only after that (`manager 1 disposed`).
- Strengthened: the reload witness asserts the replaced manager stays open
  while the stream is held; the final-shutdown witness asserts the upstream
  body was cancelled and the order `stream settled`, `manager 1 disposed`,
  `manager 2 disposed`.

## Added tests

- request-services: a request admitted mid token refresh survives a reload,
  saves its successor refresh token through the replaced manager and sends
  with the successor access token; executor retirement keeps an admitted send
  and body and refuses new requests; disposal after retirement aborts it.
- fetch-interceptor: retirement refuses later requests without passing them
  upstream and finishes a request already waiting on admission.
- lifecycle: retirement ordering, final-shutdown ordering over live and
  retired runtimes, and refusal of an offered runtime once disposal began.
- auth-loader: a vault runtime whose construction finishes after the loader's
  disposal began sends nothing and is disposed; two contract tests that
  required the replaced runtime to be disposed by `reload()` now require it to
  be retired instead.

## Receipts

- `focused-positive.log`: the four touched test files, all passing.
- `typecheck.log`: `bun run typecheck` in `packages/opencode`.
- `package-suite.log`: `packages/opencode` unit suite summary;
  `package-suite-run1.raw.log` and `package-suite-run2.raw.log` are the
  complete stdout and stderr of the two full runs it summarises.
- Provenance: every `.log` here was written by shell redirection of the
  test command's own stdout and stderr (`2>&1`), with the command's exit
  status appended by the same shell as the last `exit=` line; none is a
  transcription.
- `controls/*.log`: each negative control's diff, run and restore. A
  control deliberately breaks one piece of the fix, and the tests that
  defend it must go red; the file names say what was broken. C1-C5 each
  redden exactly their named test. C6-C8 break retirement or final shutdown
  as a whole: C6 makes retirement abort admitted requests, C7 disposes a
  replaced manager before its runtime drains, and C8 makes final shutdown
  skip aborting retired runtimes. Each of these reddens every test that
  depends on that property (C8's two tests hang until the 5 s deadline).
  C1-C8 were run on the first version of the fix, before the ownership
  changes below; C7b and C8b repeat C7 and C8 on the current lifecycle code.
- `ownership-gap-red.log`: the two witnesses below, red on the first version
  of the fix.

## Ownership gaps found in review, and their fix

- A replaced manager was disposed as soon as its request runtime retired,
  while its refresh queue could still be finishing a proactive refresh and
  saving through it. Witness (request-services, real
  `createLocationProactiveRefreshQueue` and real executors): "a replaced
  manager stays open until its refresh queue has finished an admitted
  proactive refresh". Before the fix it recorded `manager 1 disposed` while
  the refresh was held, and the refresh then saved through the disposed
  manager. The lifecycle now keeps one record per replaced runtime that
  waits for the queue drain and the request retirement before disposing the
  manager, and final disposal sees that record throughout (lifecycle test:
  "keeps a replaced manager open until its queue finishes a refresh under
  way, and final disposal still owns it meanwhile").
- The local interceptor's `dispose()` reported done while a request was
  still reading its admission; that request then read the host sign-in and
  reached the disposed executor. Witness (fetch-interceptor): "final
  disposal waits for a request still reading its admission, which then
  sends nothing and reads no sign-in". Before the fix the events were
  `disposal finished`, `admission read returned`, `host sign-in read`.
- Controls on the fix: C9 (the queue drain not awaited) reddens both queue
  tests; C10 (disposal not waiting for entering requests) and C11 (no check
  after the admission read) each redden the admission witness only.
- Final shutdown stopped the live refresh queue only after the live and
  retired request runtimes had drained, so its timer could start a new
  refresh while an admitted stream or host read was still draining.
  Witness (lifecycle): "stops the live refresh queue as shutdown begins,
  while its request runtime is still draining, and disposes the manager
  after both" (`shutdown-queue-red.log`: before the fix the queue was not
  stopped while the request abort was held). Final shutdown now starts the
  request aborts and the live queue's disposal together, then waits for
  both before disposing the live manager. C12 (queue stopped only after the
  aborts drain) reddens this witness and the shutdown-ordering test; C13
  (live manager not waiting for its queue) reddens this witness only.
