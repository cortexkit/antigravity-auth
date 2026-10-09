# S-RPC acceptance

## Portable RPC unit suite and the mandatory exact-runtime matrix

The plain repository `npm run test` includes the complete 17-contract suite on
the current Bun executable (`process.execPath`). It uses no personal runtime
locations, HOME lookups or `RPC_*` overrides, including when the preload isolates
HOME. The narrow unit command is
`bun test --isolate test/common-auth-094-adoption/rpc/`.

The complete unit suite does **not** replace the separately mandatory matrix. CI and release
verification must invoke `test:rpc:matrix`, whose runner is
`bun test/common-auth-094-adoption/rpc/runtime-matrix.mjs`, with all four flags:

```sh
bun test/common-auth-094-adoption/rpc/runtime-matrix.mjs \
  --node20 /absolute/path/to/node-20.0.0 \
  --node24 /absolute/path/to/node-24.16.0 \
  --bun13 /absolute/path/to/bun-1.3.14 \
  --bun14 /absolute/path/to/bun-1.4.2
```

The flags supply executable paths, not aliases or version ranges. Relative paths
resolve inside the repository. Missing, duplicate, unknown or valueless flags,
missing executables and wrong exact versions fail before any RPC fixture runs.
All four executables are checked first by running `--version` and requiring the
exact version; none may be skipped. The runner does not
download runtimes or add runtime dependencies. Automation provisions them with
the Node/Bun setup actions and supplies their paths explicitly; save Bun1.3.14
in an owned temporary directory before a later Bun1.4.2 setup replaces its path.
Other platforms must provide their own official executables. These checks do not
certify real-host rendering or unmeasured platforms.

`fixture.mjs` transpiles the actual three handwritten adapters with the installed
TypeScript, without substitutions, and copies each public module unchanged into
one temporary directory's `common-auth-embedded/` tree. Imports of the server,
Error and client entry points therefore share their normal ESM module identities
within that directory. Typechecking remains the repository `npm run typecheck` gate, not
this transpilation. Two explicit test variants change **only** the adapter's idle
setting to 1500 ms and its apply deadline to 150 ms. The production zero variant
retains the full 2000/120000/0 settings. Apply/drain callbacks take 6500 ms, beyond
the Bun1.3.14 four-second native sweep. Reached observations record both zero and
nonzero elapsed time. Live 504, callback effects and natural child exit after stop
are independently observed rather than inferred from peer closure.

The cases speak the shared `/antigravity` menu protocol. The adapter server
receives `parseApplyRequest` through its options, as the plugin passes it, and
the harness takes that function from the copied public
`common-auth-embedded/commands/index.js`; the suite therefore needs the commands
entry in the embedded tree. Starting the adapter without a parser function is
refused with a `TypeError` before it listens or writes a port file;
`rpc.auth_validation` checks that first. Apply bodies are `CommandApplyRequest` values and
answers are `CommandApplyResult` values. Bodies the library parser refuses,
including the retired `{command, arguments}` request, answer 400 before the
apply callback runs. Notifications carry `{id, payload, sessionId?}`; the
client checks only that envelope and refuses the whole batch if any message has
another key (such as the retired `type`), a non-positive or unsafe `id`, a
non-string `sessionId` or a payload that is not an object. Validating the menu
or notify payload itself is the renderer's job. A failed client `apply`
resolves `undefined`.

Each unit or matrix runtime runs the complete ordered 17-case inventory. Fresh
child stdout is parsed through the same strict validator: exact ordered names,
boolean `ok`, nonempty observations/errors and matching exit 0/1. Truthy strings
such as `ok: 'yes'`, missing rows and contradictory exits are not acceptance.
The strict child-result tests cover genuine boolean success data and
malformed-success refusal without fake executables. Receipt directories under
`.owned/receipt-*` preserve executable hashes/versions, adapter input/output hashes,
argv, cwd, stderr, exit and nonempty named observations. These hashes are recorded
observations of candidate inputs, not independent expected pins. Compare them
against separately frozen expected hashes; deriving expectations from these same
receipts would not establish provenance. Fixtures use `.owned/runtime-*/rpc/`,
`.owned/runtime-*/common-auth-embedded/` and `.owned/runtime-*/state/<case>/`.
Those module/state trees are removed after execution. Receipts remain separately
under `.owned/receipt-*/result.receipt`. The `.receipt` files contain JSON data;
their extension keeps repository source format/write gates from rewriting evidence.
No default RPC/store/config/HOME path is used.

Mutation proofs use **only owned disposable copies**. Stage intentional source
changes before running `node test/common-auth-094-adoption/rpc/mutation-proof.mjs`
with exact Node24. Supply the other three executables as a colon-delimited
`RPC_MUTATION_EXTRA` to repeat the broken-zero control on all four runtimes.
The script stages each owned mutant target, confirms an empty unstaged diff,
marks `NON-VACUITY BREAK`, records a nonempty diffstat, runs the complete inventory,
then restores saved bytes, verifies the original SHA256 and empty unstaged diff,
and removes only the disposable index entry. No checkout, touch or stash is used.
Each control must fail only its named case; all sixteen others must pass.
Controls scoped to a particular scenario avoid changing unrelated test conditions;
effect suppression and foreign Error identity are explicit callback/witness controls.
Receipts are saved in `.owned/mutation-receipts.receipt`; no mutant is committed.

The strict child-result validator has a separate data-only defense proof. After staging
intentional changes, run
`bun test/common-auth-094-adoption/rpc/result-mutation-proof.mjs`. It copies the
validator and refusal tests into an owned temporary directory, changes only the
validator's boolean check into truthy coercion, and requires exactly
`rpc.results.strict_boolean_refusal` to fail while the other eight tests pass.
The original bytes and hash are restored with an empty unstaged diff before
the disposable directory is removed. Its receipt is
`.owned/result-mutation-receipt.receipt`; no runtime or transport is simulated.

The no-PID newest-live and malformed-removal baseline assertions were intentionally
replaced, not dropped: no PID now fails closed; malformed bytes remain unchanged,
while valid stale PID files are still removed. The decimal body-cap assertion was
tightened from 1 MiB to 1,000,000 bytes. These accepted differences are described in
`packages/opencode/docs/COMMON_AUTH_RPC.md`.
