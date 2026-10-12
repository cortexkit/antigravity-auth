# Remaining Node 20 cancellation APIs

Scope: replace `AbortSignal.any` only in the core header-timeout helper and Pi
stream runner. No support-floor change or global compatibility shim.

## Work plan

- Completed: reproduce the missing API with caller-signal tests and raw receipts.
- Completed: implement shared explicit forwarding and body/finally lifetime cleanup.
- Completed: verify timeout, cancellation, metadata, errors, and listener ownership;
  capture mutation controls and positive gates.
- Pending: obtain engineering-owner source/comment/receipt review before Git's
  normal pre-commit hook.

`run-gate.sh` captures the invoked argv, separate raw stdout/stderr, and the
actual process exit status. Receipts are outside regenerable build directories.

## Source behavior and implementation

The original core helper stopped its deadline listener at headers but used
`AbortSignal.any` to retain caller cancellation. Pi used the same unavailable API
for its opening/parsing signal. `C0-missing-any` is the baseline
missing-`AbortSignal.any` test. It supplies caller signals in both packages and
both named tests fail before the production changes.

The shared public `forwardAbort` helper forwards the original reason to a local
controller and returns an idempotent detach function. Core detaches the header
deadline at headers, and the caller at body EOF/error/cancel. A zero-read-ahead
body wrapper preserves bytes and read/cancel errors, releases the source reader,
and carries status, statusText, headers, url, type, and redirected onto the
returned Response and its clones. Observing `reader.closed` also cleans up idle
errors and empty EOF without consuming a final buffered chunk. Null bodies and
fetch rejection detach immediately. An explicit init signal (including null)
overrides the input Request signal; otherwise a real Request's signal is used.

Pi retains forwarding through opening, chunk parsing, and its existing body and
iterator cleanup, then detaches in `finally` on every exit. The default 15-second
header deadline and Pi trailing-usage deadline are unchanged.

## Verification and receipts

- `C0-missing-any`: 2 expected failures, exit 1, caller signals supplied in both
  packages with `AbortSignal.any` set to undefined.
- `C1` through `C5`, and `C7`: six isolated production mutations. Each has one
  named failure and one independent passing control, exit 1; `mutation-during.txt`
  records a nonempty diff and `mutation-after.txt` an empty diff after restoring
  the staged live implementation and touching the mutated file. No mutation
  remains in source. The controls cover premature caller detach, late header
  deadlines, shared listener removal, body completion removal, Pi final removal,
  and Request-signal inheritance.
- `C6-idle-cleanup-baseline`: the new idle-body assertion failed before adding the
  source-reader closure observer, exit 1. This is an incremental negative test,
  not a staged production mutation.
- `P1-targeted-gates`: initial test listener instrumentation had implicit-any
  parameters; typecheck exit 2. The annotations were corrected.
- `P2-targeted-gates`: the first annotation correction allowed null listeners,
  which the AbortSignal overload rejects; typecheck exit 2. The null annotation
  was corrected. This remains a failed typecheck, not a runtime pass.
- `P3-targeted-gates`: the newly added HTTP-error unlock assertion failed,
  exit 1 (67 tests passed, one failed). The original failure is archived unchanged.
- `P4-targeted-gates`: private core build, core/Pi typechecks, and 70 tests passed
  before adding idle-body coverage.
- `P7-final-gates`: exit 127 while querying esbuild at the root; it is installed
  in Pi's package tool context. No checks ran after that failed version query.
- `P8-final-gates`: core build, core/Pi typechecks, Pi build, all 72 focused tests
  (289 assertions), and Biome check of seven fenced TypeScript files passed,
  exit 0. Versions: Bun 1.4.2, Node 24.21.0, TypeScript 6.0.3, esbuild 0.27.7,
  Biome 2.5.3. All build/typecheck/test gates ran on the Linux runner.
- `P9-reviewed-http-tests`: two new assertions incorrectly generalized stock
  retained locking from string-backed bodies to streamed bodies; exit 1 (49
  tests passed, two failed). This failure is archived unchanged. The corrected
  tests explicitly retain the string-backed stock assertion, and compare
  streamed consumption with an independent stock consumer rather than require
  either a locked or unlocked body on every representation.
- `P10-reviewed-http-tests`: private core dependency build, Pi typecheck, all 52
  Pi stream tests (199 assertions), and a one-file Biome check passed, exit 0.
  The added HTTP checks prove full consumption to EOF/error, preservation of
  the HTTP text or original body failure, zero pending source pulls, no reader
  acquisition beyond stock consumption for parsing, and detached caller listeners.
- `P11-import-safety`: eight standalone importer controls passed on Linux,
  Python 3.14.4, exit 0. Valid imports preserve every byte value and CRLF. Invalid
  absolute/traversal paths, symlink ancestors/targets/root, malformed maps,
  compression, file conflicts, excessive file counts, and encoded/expanded
  size overflows reject before any output-directory writes. The importer caps
  encoded input at 2 MiB and expanded JSON at 8 MiB, validates the whole map
  before writing, and uses no-follow directory/file descriptors for writes.
- `C8-import-traversal`: removing the parent-component fence reddened exactly
  `test_rejects_parent_traversal_before_any_writes`; the raw-byte positive passed.
- `C9-import-symlink-preflight`: removing preflight reddened the symlink-ancestor
  no-write subcase while the raw-byte positive passed. Each symlink subcase then
  received a distinct valid first target so earlier failed subcases cannot mask
  another attempted write.
- `C10-import-symlink-independent`: the same preflight omission reddened all
  three symlink no-write subcases (directory, file, dangling target), and only
  that named test failed; the raw-byte positive passed. These three staged/restored
  mutations have nonempty/empty diff pairs and retain their original failures.
- `P12-final-import-safety`: all eight controls passed after restoring the
  hardened importer and strengthening the independent symlink subcases,
  Python 3.14.4 on Linux, exit 0. No production matrix was rerun for script safety.

The runner discards its files rather than syncing receipt files back. Most
receipts were copied losslessly from its compressed payload using
`import-receipt.py`. The P8 stdout/stderr and exit status were copied directly
from the actual tool response after compressed-payload import attempts failed;
its command file records the actual invoked argv in shell-readable form. No
managed task receipt or execution result was invented. Original AFT recorders
were subsequently located. `bind-recorders.py` recovered the initial C0 setup
failure, the first C0 source reproduction, P2/P3, P9, and P10 without rerunning
those captures. `recorder-bindings.json` records the original task IDs and
stdout/stderr/metadata paths, remote job IDs, three independent exit records,
and SHA-256 comparisons. All retained stdout/stderr/exit bytes, including P8,
match the original embedded recorder payloads. P8's command file has equivalent
argv but different shell quoting from the original. P5/P6 iteration outputs are
not retained locally. P3's invalid HTTP unlock assertion is now replaced by
explicit stock-consumer and HTTP cleanup coverage rather than merely deleted.
No pre-existing test was weakened or deadline relaxed.

Live language-server inspection was unavailable (mise initialization failure);
the package `tsc --noEmit` gates are the authoritative type checks. Preparatory
comment review found no unclear comments; final source/comment/receipt review
belongs to the engineering owner before commit. Real Node 20.0.0 was not executed here:
compatibility is exercised with the missing-API controls, not a support-floor
change or a claim about a completed runtime matrix.

The engineering owner additionally reported six passing real Node 20.0.0
web-stream controls after transpiling exactly the two core helper sources with
TypeScript 6, under unchanged network/profile denial. Those are owned,
injected-fetch controls, not a native HTTP or Pi runtime matrix run by this worker.
