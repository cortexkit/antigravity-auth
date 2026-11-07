# Working in antigravity-auth

These are standing rules for workers in this repository. They answer the questions workers most often stop to ask. Follow them without asking. Ask the parent only about a real design choice, a behaviour change not covered by your brief, or a check that fails for a reason you can't explain.

## Where to build and test

- Build and test on Linux with `runon: "linux,8c"`. Add `,net` only when a step installs packages or runs a released npm package. The project needs **Bun 1.4.2** exactly. A local Mac preparation step that fails with "Bun 1.4.4" is expected: ignore it and use the Linux job. Linux jobs default to Bun 1.4.4 and ship a pinned `/usr/local/bin/bun-1.4.2`, so start every Linux command with `if [ -x /usr/local/bin/bun-1.4.2 ]; then mkdir -p "$TMPDIR/b" && ln -sf /usr/local/bin/bun-1.4.2 "$TMPDIR/b/bun" && export PATH="$TMPDIR/b:$PATH"; fi; bun --version` and check that it prints 1.4.2. The runner's own pre-job install under 1.4.4 is fine: it leaves our lockfiles unchanged.
- Build core before anything that imports it: `bun run --cwd packages/core build`. Never run that build in parallel with another check, because it deletes `packages/core/dist` while it runs.
- Submit one combined Linux job rather than many small ones. If the runner refuses a job before it starts (capacity or drain), resubmit the same job. Stop after three refusals in a row and report.
- A Linux job **cannot change files git tracks**: writing, deleting, renaming, `touch` or `chmod` on one fails with "Operation not permitted". `dist/`, `$TMPDIR`, runner-prepared `node_modules` and new untracked files still work. Make tracked edits in your worktree and commit them before the job.
- A file a remote job creates is **not** copied back unless you name it. To bring generated files back, follow "Regenerated files".

## Before you deliver

AFT is the agent tool interface; its `functions.bash` tool submits shell commands to MOTOR using `runon`.

1. **Fast checks:** on the committed, clean tracked tree with Bun 1.4.2, run `bun run prepush --fast` locally.
2. **Tests for what you changed, and only those:** in one Linux job, build core, typecheck the packages you touched, and run the test files that cover your change. For a bug fix, show once that a new test fails without the fix, and say how you showed it. Because tracked files are read-only in the job, show it in a second checkout of the base under `$TMPDIR` (`git clone --shared --no-hardlinks . $TMPDIR/base && git -C $TMPDIR/base checkout <base>`, with your new test copied in; `git worktree add` fails there because the job's `.git` is read-only too), not by restoring a base file in place. A filtered run that takes more than about 15 minutes means the filter is too broad: narrow it.
3. **Never run a whole suite or the full gate.** Don't run the root `bun run test` or `bun run test:e2e`, a whole package's tests, or `scripts/prepush.sh --full-here`. The parent runs the full suite once on GitHub CI for each batch of merged deliveries.
4. **A failure that looks unrelated:** rerun that one test by name on your base commit on the same runner, never the suite, and report both results. "Same at base" is a claim to prove, not to assume.
5. **Don't wait in long watch loops.** Submit the job with `wait: true` and a timeout that fits a filtered run.
6. Run a comment review on your diff with sidekick, and fix what it flags.

The parent's GitHub CI covers what workers no longer run: both root suites, the OpenCode 2 Docker smoke, the four-runtime status-server matrix and Windows.

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

When a Linux job must regenerate tracked files (for example the embedding scripts writing `src/common-auth-embedded/` and `source-output.json`), name each output path in the `runon` job's `return_paths` (up to 64 files, 10 MiB in total). Those paths stay writable in the job and replace your worktree's copies when it finishes. Also print one `CHANGED <path> bytes=<n> sha256=<hex>` line per file, so the parent can check what came back. Then review the returned files with `git diff` before you commit.

## Commits

Author and commit as `ualtinok <94532+ualtinok@users.noreply.github.com>` with the normal hooks. Don't push. Commit locally and stop for review.
