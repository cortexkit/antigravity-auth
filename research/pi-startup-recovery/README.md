# Pi startup recovery after a failed credential-slot synchronization

Base: `d2d0e5e6`. Provenance: the report-only source audit at Git object
`d0d1301c`, `research/vault-exclusivity-final-audit/REPORT.md` (its F2 and O3
sections describe the two defects below; this file explains them on its own).

## Reproduced behavior (before any product change)

At start, Pi's extension factory `registerCortexKitPiAntigravity` swaps Pi's
native `google` login in `auth.json` to match the chosen local or vault mode
(the "slot synchronization"). Only after that does it register the
`/antigravity` command. The synchronization throws when the mode cannot be
decided or the swap is unsafe. The throw rejects the factory, so Pi loads
nothing from the extension: no provider and no `/antigravity` menu. The menu
holds the in-product remedies (request vault access again, serve from the local
login, forget the enrollment). The rejection repeats on every start, so the
user cannot reach them.

The witnesses were written and run red against the unchanged
`packages/pi/src/index.ts`. The original red output is kept verbatim in:

- `red-index-test-at-d2d0e5e.log`: the production
  `registerCortexKitPiAntigravity` with a mock Pi API and owned `/tmp` fixtures.
- `red-startup-order-test-at-d2d0e5e.log`: the real Pi 0.87.1
  `createAgentSession` extension loader loading a fixture extension that calls
  the production `registerCortexKitPiAntigravity`.

Both use the genuine common-auth 0.14.1 Pi slot helper (`loadCommonAuthPiSlot`)
and the genuine vault library (`loadCommonAuthClaustrum`). No vault connection
is opened (the `connect` and `connectEnrollment` seams throw) and nothing reaches
the network (`fetch` refuses, `PI_OFFLINE=1`). No real Pi profile, Google slot or
vault was read or written by these witnesses.

| State | Fixture | Startup error |
|---|---|---|
| Unreadable enrollment | torn `pi-enrollment-state.json` | "Vault enrollment or source settings cannot be read." |
| Unreadable mode | torn `pi-mode.json` (mock API run only) | same message |
| Custody, enrollment absent | mode `custody`, no enrollment files | "Vault enrollment must be approved before activating vault credentials." |
| Native slot conflict | genuine `enterVault()` stash, then a different native `google` entry, local mode | "The native Google login changed. It was not overwritten; ..." |

Second defect: startup, every `session_start`, and every Vault-section mode
change (`useVault`, `useLocal` and `disconnect`, through `onModeChanged`) start a
synchronization, and nothing ordered them. The slot helper's file lock orders
only the slot write, not the mode reads around it or the provider registration.
An older run that read the mode before a change could therefore register its
provider after a newer run.

## Proof levels

- Native-host runtime proof, real Pi loader:
  - At base, a rejected factory is recorded in `extensionsResult.errors`,
    contributes no command, and leaves Pi's built-in Google catalog active
    (22 non-Antigravity `google` models). Red log, and control 1 below.
  - A provider registered before the factory rejects is discarded by Pi
    (control 1: `registerProvider:google` was called, built-ins remained).
  - After the change, for all three loader lockouts, Pi's `session_start`
    dispatch runs the extension's synchronization again. It fails, Pi catches
    the error and reports it to the session's `onError` listener as
    `{ event: 'session_start', error: <the synchronization reason> }`,
    `bindExtensions` resolves, and `session.extensionRunner.getCommand('antigravity')`
    is still defined (`startup-order.test.ts`, asserted).
  - Request refusal text, asserted. With a native OAuth `google` entry, Pi
    itself refuses with "Provider is not configured: google" before the
    extension stream runs: the refusing provider has no OAuth and the stored
    credential is OAuth. With no native entry, Pi reaches the extension's
    refusing stream, which fails with the synchronization reason.
- Source-derived only, not run: how a user reaches these end states in
  production. Examples: the vault refusing an enrollment request, which core
  maps to unreadable authority; a Forget interrupted between deleting enrollment
  and writing the mode file; a native `/login` while in vault mode. The fixtures
  write the end states directly.

## Change

`packages/pi/src/index.ts`:

1. A failed slot synchronization registers a refusing `google` provider. It
   has the same id, the same models (asserted equal to the local provider's),
   the custody key marker as `apiKey`, and no OAuth. Its stream fails with the
   synchronization error before anything is sent. The error is still thrown to
   the caller.
2. Startup swallows that error, so the factory resolves and registers
   `/antigravity`. The successful path is unchanged: the slot is still swapped
   and the real provider registered before the factory returns.
3. `session_start` and mode changes refresh Pi's model registry after a failed
   synchronization as well (`finally`), and still surface the error.
4. Synchronizations run one at a time, each reading the mode when it starts,
   so the run that registers last is the one that read the newest mode.
5. `currentMode` calls `enrollmentAuthority(setup.paths,
   PI_ANTIGRAVITY_ENROLLMENT_NAME)` without injecting the status snapshot that
   `sourceStatus()` had just read. Core's public `enrollmentAuthority` now
   delegates to the genuine common-auth `enrollmentAuthority` and reads the
   enrollment files itself, so it no longer accepts a snapshot reader of that
   shape. A side effect is that authority is a fresh read at decision time.

Not changed: the common-auth slot helper's conflict refusal, the local and vault
providers, the vault stream's exact-marker check and per-send authority read,
and the menu. The Accounts section has no local-writing action.

## Overlap witness

`index.test.ts`, "finishes an older slot synchronization before a mode change
registers its provider". A `session_start` synchronization reads vault authority,
and its second enrollment read is held after the files are read. Forget then
writes local mode, and its synchronization restores the native login and
registers the local provider. Then the held run resumes.

- At base (red log): the held run registered the vault provider last.
- After change 5, the held run re-reads authority after the hold, sees the
  Forget, and fails closed. Its `session_start` rejects and it registers the
  refusing provider. The witness therefore waits with `Promise.allSettled` and
  requires only the Forget to succeed. Without ordering, that refusing
  registration still lands after the local one, and the witness stays red
  (control 4).

## Receipts (`receipts/`)

All runs were remote Linux (ck-motor, 4 vCPUs, bun 1.4.2, tsc 6.0.3). Each one
was a fresh job and printed the sha256 of the three source files it tested.
Biome 2.5.3 `check` on the three source files is clean (run locally; it is not a test).

Snapshots, by sha256 (Git blob):

| Name | index.ts | index.test.ts | startup-order.test.ts |
|---|---|---|---|
| S1 | bd04a01e… (9fb02c58) | 95478510… (8499fbde) | 27297ec6… (02c4ed24) |
| S2 final staged | bd04a01e… (9fb02c58) | 08fc3f29… (4de1e31c) | 27297ec6… (02c4ed24) |

S2 differs from S1 only by a comment above the last assertion of the overlap
witness (index.test.ts, near line 631). No code changed.

| Receipt | Snapshot |
|---|---|
| `positive-1-typecheck-and-pi-suite.log` (unfiltered, 108/108) | S1 |
| `positive-2-final-snapshot.log` (filtered as stated, 108/108) | S2 |
| `control-1-startup-rethrow.log` | S1 with index.ts mutated |
| `control-2-local-fallback.log` | S1 with index.ts mutated |
| `control-3-vault-fallback.log` | S1 with index.ts mutated |
| `control-4-no-ordering.log` | S1 with index.ts mutated |

Each control was applied with the source staged (`git diff --stat` empty), run,
then restored with `git checkout -- packages/pi/src/index.ts` (`git diff --stat`
empty again). Each receipt runs the named test alone with `bun test -t` (raw),
then the two test files (filtered to pass/fail lines).

| Control | Named test, alone | Inspected failing assertion | Red in the two files |
|---|---|---|---|
| 1 Startup rethrows | real Pi loader, native conflict | load error, no command, built-in catalog active | 9 |
| 2 Local provider as fallback | refusing provider, unreadable mode file | `config.oauth` defined; real Pi conflict case: "OAuth refresh failed for google: <fixture refuses network>", i.e. Pi tried to refresh the native login | 8 |
| 3 Vault provider as fallback | names the slot failure | "Vault enrollment is not active. No request was sent." instead of the reason (still fail-closed) | 5 |
| 4 No ordering | overlap witness | last registration has no `oauth` | 1 |

The first run of controls 1-3 (before change 5) is superseded by these receipts.

## Test-isolation hazard found (pre-existing, not changed)

Three tests at the top of `index.test.ts` call the default entry with no
seams: "exposes the live GPT-OSS route", "replaces the native Google catalog",
and "the production default entry". Pi's `getAgentDir()` reads
`PI_CODING_AGENT_DIR`, but `test/setup.ts` sets `PI_AGENT_DIR`, and Bun's
`os.homedir()` ignores a later `HOME` change. These tests therefore swap the
`google` entry in `<real home>/.pi/agent/auth.json`. The custody test leaves the
placeholder there, with its stash in a deleted temporary directory.

- Remote runner (observed): a second suite run in the same job fails with
  `Pi slot: missing-stash`.
- Operator's Mac: the same tests would write the operator's real Pi
  `auth.json`. No test was run on the Mac for this work.

The fix belongs to test setup, outside this change.
