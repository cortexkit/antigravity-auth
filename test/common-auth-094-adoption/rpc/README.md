# S-RPC acceptance

Run `bun test --isolate test/common-auth-094-adoption/rpc/rpc-adoption.test.ts`.
The required executables are Node **20.0.0**, Node **24.16.0**, Bun **1.3.14** and
Bun **1.4.2**, not runtime aliases or semver ranges. Set `RPC_NODE20`, `RPC_NODE24`,
`RPC_BUN13`, `RPC_BUN14` to provisioned executable paths on other machines. Missing
or wrong versions fail acquisition explicitly, never skip or count as acceptance.
Defaults use an owned Node20 download and the local mise Node24/Bun13 installs;
Bun14 defaults to the executing Bun. All subprocesses run inside this worktree.

For Darwin arm64, provision Node20 into the ignored, owned `.owned` directory:

```sh
mkdir -p test/common-auth-094-adoption/rpc/.owned
curl -fL https://nodejs.org/dist/v20.0.0/node-v20.0.0-darwin-arm64.tar.gz \
  -o test/common-auth-094-adoption/rpc/.owned/node20.tgz
tar -xzf test/common-auth-094-adoption/rpc/.owned/node20.tgz \
  -C test/common-auth-094-adoption/rpc/.owned \
  node-v20.0.0-darwin-arm64/bin/node
```

This acquisition is test tooling only, never a product/build dependency. Other
platforms must provision their own official executables and set the four paths.
This fixture does not certify host-render or other-platform support.

`fixture.mjs` transpiles the actual three handwritten adapters with the installed
TypeScript, without substitutions, and copies the canonical public graph into one
module domain. Typechecking remains the repository `npm run typecheck` gate, not
this transpilation. Two explicit test variants change **only** the adapter's idle
setting to 1500 ms and its apply deadline to 150 ms. The production zero variant
retains the full 2000/120000/0 settings. Apply/drain callbacks take 6500 ms, beyond
the Bun1.3.14 four-second native sweep. Reached observations record both zero and
nonzero elapsed time. Live 504, callback effects and natural child exit after stop
are independently observed rather than inferred from peer closure.

Each runtime runs the complete ordered 17-case inventory. Fresh child stdout is
parsed, exact names reconciled, and exit status checked. Receipt directories under
`.owned/receipt-*` preserve executable hashes/versions, adapter input/output hashes,
argv, cwd, stderr, exit and nonempty named observations. Fixture module/state trees
are removed after execution. No default RPC/store/config/HOME path is used.

Mutation proofs use **only owned disposable copies**. Stage intentional source
changes before running `node test/common-auth-094-adoption/rpc/mutation-proof.mjs`
with exact Node24. Supply the other three executables as a colon-delimited
`RPC_MUTATION_EXTRA` to repeat the broken-zero control on all four runtimes.
The script stages each owned mutant target, confirms an empty unstaged diff,
marks `NON-VACUITY BREAK`, records a nonempty diffstat, runs the complete inventory,
then restores saved bytes, verifies the original SHA256 and empty unstaged diff,
and removes only the disposable index entry. No checkout, touch or stash is used.
Each control must redden **only its named case**, with all sixteen others green.
Controls scoped to a particular scenario avoid changing unrelated test conditions;
effect suppression and foreign Error identity are explicit callback/witness controls.
Receipts are saved in `.owned/mutation-receipts.json`; no mutant is committed.

The no-PID newest-live and malformed-removal baseline assertions were intentionally
replaced, not dropped: no PID now fails closed; malformed bytes remain unchanged,
while valid stale PID files are still removed. The decimal body-cap assertion was
tightened from 1 MiB to 1,000,000 bytes. These accepted differences are described in
`packages/opencode/docs/COMMON_AUTH_RPC.md`.
