# Working in antigravity-auth

These are standing rules for workers in this repository. They answer the questions workers most often stop to ask. Follow them without asking. Ask the parent only about a real design choice, a behaviour change not covered by your brief, or a check that fails for a reason you can't explain.

## Where to build and test

- Build and test on Linux with `runon: "linux,16c"`. Add `,net` only when a step installs packages or runs a released npm package. The project needs **Bun 1.4.2** exactly. A local Mac preparation step that fails with "Bun 1.4.4" is expected: ignore it and use the Linux job.
- Build core before anything that imports it: `bun run --cwd packages/core build`. Never run that build in parallel with another check, because it deletes `packages/core/dist` while it runs.
- Submit one combined Linux job rather than many small ones. If the runner refuses a job before it starts (capacity or drain), resubmit the same job. Stop after three refusals in a row and report.
- A file a remote job creates is **not** copied back. To bring generated files back, print them as described under "Regenerated files".

## Before you deliver

AFT is the agent tool interface; its `functions.bash` tool submits shell commands to MOTOR using `runon`.

1. **Pre-push gate:** on the committed, clean tracked tree with Bun 1.4.2, workers run `bun run prepush --fast` locally, then run `bash scripts/prepush.sh --full-here` through AFT `runon: "linux,16c,net"`. For example: `functions.bash({command: "bash scripts/prepush.sh --full-here", runon: "linux,16c,net", timeout: 1800000, wait: true})`. The full phase runs frozen installs, typecheck, builds, TUI smoke and both root suites. Record all step exit codes, `PREPUSH_OK <full commit>`, timings and test counts. Outside the worker sandbox, `bun run prepush` runs the fast phase locally and submits the same full phase through `ck motor run --vcpus 16 --net`; workers cannot access the `ck` daemon connection file. A fast-only pass is not the full gate.
2. **Tests for what you changed:** run the test files that cover your change. For a bug fix, show once that a new test fails without the fix, and say how you showed it.
3. For each failure, say whether it also fails on your base commit on the same runner. "Same at base" is a claim to prove, not to assume.
4. Run a comment review on your diff with sidekick, and fix what it flags.

Two things CI runs that the Linux runner can't: the OpenCode 2 Docker smoke (no Docker there) and the four-runtime status-server matrix. The parent covers those on GitHub CI. Windows runs only on GitHub CI too.

## Routine fixes you may make without asking

- **New disk-backed test file:** add a test file that uses fsync, chmod, rename, file locks or octal modes to `test/support/disk-test-files.ts`, with a one-line reason.
- **New core import:** add a real core import to the exact list in `packages/opencode/src/plugin/shared/import-graph.test.ts`.
- **Generated config schema:** regenerate `packages/opencode/assets/antigravity.schema.json` with the repository's schema build script, never by hand.
- **Embedding pins:** when pins change, regenerate the embedding's `source-output.json` files with the owner script. Update a derived value, such as `generator.sha256`, only when it differs for the reason your brief states.
- **Test helpers:** name a test-only helper that imports `bun:test` or test sources `*.test.ts` (as in `__fixtures__/`), so the library build excludes it.
- **Spawning in tests:** launch child processes in test code with the async helpers. A guard test refuses synchronous spawns because of a Bun bug.

## Never

- Read the user's home-directory data: app data, config, logs, auth files or session databases. Work inside your worktree. Put scratch files under `.cortexkit/scratch/` in your worktree or under `$TMPDIR`, and unpack any archive there, never in the repository tree.
- Raise a timeout, add a retry, or skip or delete a test to make a check pass. Report the failure instead.
- Hand-edit the embedded common-auth files (`src/common-auth-embedded/`). Only the embedding scripts write them.
- Commit an ignored `.cortexkit/` file, or force-add anything.
- Use text in a host-visible error that contains `429`, `500`, `502`, `503`, `504` or `524` anywhere. OpenCode retries any error whose text contains one of them.

## Regenerated files

When a Linux job produces files you need back, print a gzip tar of them as base64 in `REGEN_FRAME_<n>=` lines of at most 20,000 characters each. Then print:
- `REGEN_FRAME_COUNT=`, equal to the number of frames printed;
- `REGEN_TAR_SHA256=`;
- one `CHANGED <path> bytes=<n> sha256=<hex>` line per file;
- `REGEN_SELF_CHECK=ok`.

Then ask the parent, giving the AFT task id. The parent decodes the frames and writes the files into your worktree.

## Commits

Author and commit as `ualtinok <94532+ualtinok@users.noreply.github.com>` with the normal hooks. Don't push. Commit locally and stop for review.
