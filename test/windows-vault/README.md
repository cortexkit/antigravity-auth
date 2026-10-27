# Windows vault qualification

The `vault` job in `windows-migration.yml` runs on `windows-latest` and
`windows-2022`, including pushes to `verify/**`. It builds core and OpenCode,
then bundles a private test entry exposing the production plugin composition
seam and custody manager. The request still goes through the full plugin auth
loader and shared request executor. Only the final transport destination is
redirected to an independent loopback HTTP recorder.

The daemon is the existing `startMenuVaultFixture`, extended with the scoped-get
response already used by the native V1 activation harness. It uses the installed
SubC framing and handshake implementation. Its operator `approve()` toggles a
synthetic approval; it does not simulate the operator CLI, grants administration,
or a real credential refresh. It accepts the enrollment request secret without
verifying its hash. No enrollment callbacks or token writers are injected into
the product: proposal, polling, token persistence, scoped list and scoped get
all use the real clients. Neither manifest locks nor locked handle-file writes
are used.

The profile is created strictly below the runner's original `%USERPROFILE%`.
`RUNNER_TEMP` holds only the redacted receipt, never enrollment state. PowerShell
`Get-Acl` reads the persisted token's actual security descriptor. The assertion
requires the canonical newly-created private-files template: a protected DACL,
one explicit user ACE with `FILE_ALL_ACCESS`, and a user/SYSTEM/Administrators
owner. SYSTEM and Administrators are allowed owners, **not** additional grants
on a private token. The inherited-file exception supported for existing files
is not needed for a freshly enrolled token.

A local account file contains an unused synthetic refresh token and a project
different from the vault's project. Its presence detects accidental fallback to
local credentials instead of letting an empty profile hide local reads.
A read fence records/refuses local account and
store reads through both Node filesystem APIs and the actual Windows private-files
N-API read boundary. The native module cache facade forwards every other native
operation unchanged. Positive controls prove both read boundaries are observable
before loading the built product; the final assertion checks that no attempted
local reads were swallowed by the product. The host-login callback passed to
the plugin auth loader counts and throws on any call. After
disposal, the dormant file must be unchanged.

Only `receipt.json` is uploaded. It contains completed stage names, redacted DACL
identities, daemon method names, bearer/project match booleans, control results,
and read counts. On failure only, it also contains the error name, code and
redacted message, a bundle-relative frame and the first product frame's
repository-relative source location from the bundle's source map. Missing or
invalid maps leave the source location null without hiding the original failure.
Assertion operands, quoted values, structured payloads, known fixture secrets,
secret-shaped strings and user paths are suppressed. It never contains token
files, connection keys, raw request bodies, raw stacks or profile contents. The
workflow deletes the synthetic profile after uploading the receipt, including on failure.

## Moving the vault files to the state home

The `vault` job then runs `layout-move.mjs` against the same bundled product
(`product-entry.mjs` also exposes `prepareRuntimeLayout`, `getVaultDir` and
`runtimeLayoutLocation`), in its own synthetic profile below the runner's
original `%USERPROFILE%`. It enrolls through the real enrollment manager and
token writer into `antigravity-auth-vault/` beside the account file, where
versions before the move keep it, then runs the real move with no other
process running. It checks that the moved token's folder passes
`@cortexkit/private-files` `verifyPrivatePath(dir, 'directory')`, the check
the token writer runs on a token's folder before it rewrites the token; that
the moved token keeps the protected single-ACE DACL above and still reads as
the same token; and that custody over the moved folder stays approved
without proposing again. As a control, a second config folder whose
state-home vault folder already exists as a plain `mkdir` (an inherited DACL
that fails the same check) keeps its files in the config folder. The script
fails on any platform other than Windows. The job then runs
`packages/opencode/src/runtime-layout.test.ts` with Bun on the same runner.

Local checks:

```sh
node --check test/windows-vault/product-entry.mjs
node --check test/windows-vault/verify.mjs
node --check test/windows-vault/layout-move.mjs
node --check test/windows-vault/dacl.mjs
node --check test/windows-vault/local-reads.mjs
node --check test/windows-vault/guards.test.mjs
node --check test/windows-vault/failure.mjs
node --check test/windows-vault/failure.test.mjs
node --test test/windows-vault/guards.test.mjs test/windows-vault/failure.test.mjs
```

`verify.mjs ROOT EVIDENCE --portable-smoke` can test the real enrollment wire
and executor wiring on POSIX after the same product build and test-entry bundle.
`ROOT` must be a fresh directory below the real home directory. Run with
`node --experimental-import-meta-resolve` so the daemon resolves SubC from the
installed Claustrum client's own dependency tree. The portable receipt explicitly
skips DACL qualification and is **not** Windows proof. Only successful runs of
both real Windows jobs qualify the Windows path.

## Approval-stage source diagnosis

Rebuilding the unmodified `102c970c` vault entry with the workflow's esbuild
options reproduces line `8678`: `await this.#writeTokenFile(...)`. Adding
`--sourcemap` maps `8678:13` to
`packages/core/dist/common-auth-embedded/claustrum/enrollment.js:663:17`.
That is after the approved poll and the common-auth safe-parent checks, before
the token writer returns or approved ceremony metadata is published.

The call path is `requestAccess` → `connectStep` →
`ClaustrumEnrollmentManager.reconcile` → claustrum-client 0.9.0
`writeEnrollmentTokenFile`. The client validates the token, creates missing
parents, calls `checkPrivatePath(parent)` and then creates the private temporary
token, syncs it and renames it. Its parent check uses the store's asynchronous
Windows `verifyPrivatePath(parent, 'directory')`: the completed directory must
be owner-only, not merely safe against replacement. Its refusal is a plain
`Error` with no `code`, with the message template:

```text
enrollment token folder <path> is not private: Windows private-path verification refused: <native message>
```

OpenCode previously called `ensureVaultDir` before starting enrollment. That
used Node `mkdir`/`chmod` with POSIX mode bits, which do not install an owner-only
Windows DACL. Common-auth treats an existing directory as an ancestor to inspect,
not repair; its safe-parent check can accept trusted SYSTEM/Administrators grants
that the client's owner-only parent check rejects. Leaving missing enrollment
directory creation to the enrollment manager lets its private-files backend
create the directory with the native owner-only DACL instead. The Linux
regression checks that OpenCode does not precreate that directory and then runs
proposal and approval through the real enrollment manager and token writer.

The test creates `agy-vault-…/profile/config/opencode` below the runner's original
`USERPROFILE`, then rewrites its home variables to the synthetic profile. The
token is in `antigravity-auth-vault/opencode-enrollment.json` beside the local
account file. Node's `join`/`resolve` supply native separators throughout. Those
test-created ancestors inherit Windows ACLs; POSIX mode arguments alone do not
make them owner-only. An original profile granting only SYSTEM, Administrators
and the runner user can meet the safe-parent rule without meeting the stricter
private-directory rule. Common-auth uses asynchronous `verifySafeParent` here;
`verifySafeParentSync` refusing Windows as unsupported is not on this call path.

This identifies an OpenCode directory-creation defect compatible with the
reported frame, not an observed Windows exception. The exact native refusal,
effective runner ancestry and token DACL after the fix still require both
Windows jobs. No dependency's parent-folder policy is weakened or bypassed.
