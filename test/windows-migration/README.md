# Windows account migration and relocation proofs

The `windows-migration.yml` workflow runs on both `windows-latest` and
`windows-2022`. These checks use isolated synthetic profiles, not a developer's
accounts. They refuse to run on another platform.

## Legacy migration

`verify.mjs` reproduces the released 3.0.0 Windows fsync failure, then runs the
candidate CLI over its leftovers. It checks successful migration under the user
profile, refusal under an unsafe parent, and an unchanged pointer on replay.
`sync-hook.mjs` records the file-open flags and sync outcomes. The migration job
uploads the receipts and the released package's registry identity.

## Account-store relocation

`relocate.mjs` runs beside the vault runtime-layout move in the vault job. Build
core, the OpenCode product, the `windows-vault-product.mjs` entry bundle and the
`windows-migration-cli.mjs` CLI bundle as that job does, then run:

```powershell
node --experimental-import-meta-resolve test/windows-migration/relocate.mjs ROOT EVIDENCE packages/opencode/dist/windows-migration-cli.mjs
```

`ROOT` must be a fresh directory below the real `%USERPROFILE%`. `EVIDENCE` is a
separate directory for the receipt and CLI stdout/stderr. The script:

1. Initializes a config-anchor store with two synthetic accounts, including a
   rotated credential, identity, access token and cached quota.
2. Runs the bundled `store relocate --offline --yes`, checks the state-home
   generation and the config-anchor forwarding pointer, and reads the same
   account rows through both anchors.
3. Calls the library's `verifyPrivatePath` on the moved generation folder and
   its config/state files, resolving the library exactly as the vault-token
   layout proof does. Mode bits alone are not a Windows privacy check.
4. Checks that `store relocate --back --help` warns about replacing the old
   pre-move backup, and adds an account after the move so that restoring only the
   old backup cannot pass the reverse proof.
5. Runs `store relocate --back --offline --yes`, checks the original schema-1
   pointer and original generation directory are restored, and reads all three
   current accounts through both anchors.

`result.json` records the completed stages, failed stage on error, Node version,
CLI hash, generation identifiers, account count and equality/privacy outcomes.
The successful receipt omits account rows and credentials; assertion failures
may include synthetic fixture data. Each CLI attempt has separate stdout/stderr
and an exit-status record. The workflow uploads these artifacts
even on failure and removes the synthetic profile afterward. Native Windows
privacy is proven by the two Windows runners, not by a Linux syntax check.
