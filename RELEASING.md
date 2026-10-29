# Maintainer releases

## Before you push

On a clean tracked tree with Bun 1.4.2 and the frozen root/private TUI compiler
dependencies installed, run `bun run prepush`. The local fast phase checks locks,
embeddings, format/lint and static test guards, then `ck motor run --vcpus 16`
submits one Linux job for frozen installs, builds, typecheck, TUI smoke and both
root test suites. `ck` must be configured for MOTOR; the job needs network access
for installs. Each step prints its exit code and elapsed phase timings; only a
complete pass prints `PREPUSH_OK <full commit>`. `bun run prepush --fast` runs just
the local checks and does not certify the full gate.

The OpenCode 2 Docker smoke, exact four-runtime RPC matrix and Windows jobs are
covered by GitHub CI only. The gate does not install the four RPC runtimes or
publish packages. The command inventory lives in `.github/workflows/ci.yml`,
`windows-migration.yml` and `release.yml`.

## Release preparation

Use Bun 1.4.2 and a clean checkout. Release preparation and tagging are separate:

1. Run `./scripts/release.sh --prepare <version>`. This syncs the three published
   package versions, their exact core pins and `bun.lock`, commits `release:
   v<version>`, then stops. It does not run the native gate, tag or push.
2. On that exact commit, run the named gate through AFT's qualified offline MOTOR
   Linux job (private PID namespace and root-managed cgroup):

   ```text
   functions.bash({command: "bun run test:native-inert", runon: "linux,16c", timeout: 900000, wait: true})
   ```

   Request `linux,16c`: MOTOR never moves a job over 8 vCPUs to another host, so
   the gate stays on the build server.

   Save the completed task's **io/stdout**, not the UI's compressed summary, to a
   local file. In the same checkout run:

   ```sh
   bun scripts/record-native-inert-gate.ts <saved-io/stdout>
   ```

   The writer validates the one result line, all nine stage exits, commit/tree,
   counts and the 41 names against that commit's tracked inventory. Only a full
   pass atomically writes ignored `.cortexkit/release-gates/native-inert.json`,
   including the stdout SHA-256. A failed or interrupted attempt writes no pass;
   attempting to record it removes any prior record. The result (schema 2) also
   proves where it ran: the gate records its own placement (arch, user, PID
   namespace, PID 1 and cgroup), and the writer and the release check refuse a
   pass outside an unprivileged MOTOR job with a private PID namespace. A
   schema-1 record has no placement and is refused; rerun the gate and record it.
3. Run `./scripts/release.sh <version>` to require successful `CI` and
   `Windows account migration and vault` workflow runs on the exact commit
   (verified with `gh`), then verify and tag/push. It makes no version changes
   and no longer builds or tests locally. HEAD must be the version-only
   preparation commit for that version: parsed manifests and lock may differ
   from its parent only in version/core-pin fields. The passing gate record must
   name **HEAD exactly**, even if another commit has the same tree. Any new
   commit requires another gate run and record; never edit the record manually.

The `<version>` and `<saved-io/stdout>` strings above are placeholders, not Git
refs. Run portable gate tests with `bun test --isolate test/native-inert-*.test.ts
test/release-prepare.test.ts`. Updating motor case names requires a reviewed
update to `packages/e2e-tests/docker/native-inert-inventory.json`; its portable
test statically expands registrations without executing native cases.
