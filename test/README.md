# Unit test roots

Run the deterministic workspace suite from the repository root:

```sh
bun run test
```

The root script builds core and prepares the public-consumer fixtures before
running Bun with `--isolate`. `test/setup.ts` gives each file its own temporary
HOME, XDG directories, Pi credentials, and OpenCode sidebar/RPC state, then removes
that root after the file.
Without an explicit opt-in, root creation and the inherited temporary-directory
environment are unchanged: everything uses the normal disk-backed `tmpdir()`.
GitHub CI and the release gate keep this disk reference configuration.

## MOTOR's private tmpfs (explicit opt-in only)

For a MOTOR Linux job, use:

```sh
ANTIGRAVITY_TEST_TMPFS=1 bun run test
```

The preload requires Linux, reads `/proc/self/mountinfo` to confirm `/dev/shm` is
an exact writable `tmpfs` mount, and checks write/search access. Failed checks or
allocation errors fail the preload; they never silently fall back to disk.
Opt-in asserts the caller has provisioned a private job mount, as MOTOR does;
mountinfo alone cannot prove namespace privacy. Existing files do not disqualify
the mount, since other tests and child processes in the same job can use it.

Bun exposes the current file as `Bun.main` in each isolated preload (verified
with Bun 1.4.2). The single explicit policy in
[`support/disk-test-files.ts`](support/disk-test-files.ts) records each disk-only
file and its reason. Crash recovery, durable publication, locks, permissions,
and native-inert cleanup remain on disk. Other files get a `/dev/shm` root and
`TMPDIR` points inside that root, so their `os.tmpdir()` fixtures also move.
`ANTIGRAVITY_TEST_DISK_TMPDIR` carries the original disk directory to children;
disk-only files reset `TMPDIR` to it, never to a parent's tmpfs root. Bun restores
the inherited environment before the next isolated file. There is no change to
the root script, hooks, CI, or release gate, and nothing auto-detects MOTOR.

The conservative guard in `test-root.test.ts` scans test/spec files under
`packages`, `test`, and `scripts`, including untracked tests. It flags sync calls
(`fsync`, `fdatasync`, `syncFile`, `syncDirectory`, handle `.sync()`/`.datasync()`),
lock helpers/imports, atomic writes, rename calls, chmod, permission assertions,
octal modes, and migration/native-inert cleanup identifiers. False positives
stay on disk. This is an identifier/import fence, not a semantic analysis:
review new helpers that hide filesystem-sensitive behavior and add the whole
test file to the policy. The guard does not replace that review.

MOTOR's `/dev/shm` pages count against the job memory limit. Print
`findmnt /dev/shm` before verification and inspect cgroup memory usage when
available. A capacity-delayed job may land on a different sandbox with a smaller
memory budget; never assume that the mount's advertised size is free memory.
