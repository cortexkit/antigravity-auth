# Official V1 packed vault / production raw-TLS floor

## Measured outcome (bounded experiment, not release readiness)

Final restored task **`bash-296fd7d9c5af0f17`** passes on official Linux-x64 **OpenCode 1.17.13**: **5 tests, 0 failures, 50 assertions**, Bun 1.4.2. In the same isolated job, TypeScript 6.0.3 passes the normal root `tsconfig.scripts.json` and the scoped, no-override `tsconfig.json` here; Biome 2.5.3 checks five source files without changes/errors. The shared GA primitive/parser regression task `bash-105c01fc99d3aa8c` passes **26 tests / 124 assertions**; it does not run a GA host.

The final positive is an installed-package experiment, not the earlier source-injected activation experiment:

- Builds and packs the real core and OpenCode packages in isolated Linux, using the shared `installNativeGaPacks` primitive. Materializes their verified ordinary tar members into a fresh `/tmp/packed-v1-vault-*/consumer/node_modules` tree outside the checkout. No runtime registry, lifecycle scripts, workspace product links, or consumer factory wrapper.
- Copies the pinned standalone consumer dependency closure (Claustrum/SubC, jsonc-parser, xdg-basedir, zod) and the prepared 1.17.13 SDK/plugin packages. Does **not** execute or copy the GA 2.0.22 executable into the consumer. Checks the standalone frozen fixture pins, installed tree and core resolution. OpenCode bundles core into its server build; the separately installed core dependency still resolves canonically to the real core pack, not a checkout link.
- Configures normal OpenCode `plugin` with a file URL to the **installed package directory**. No direct dist-entry config, source import, transport override, fake OAuth refresh, URL rewrite, cache, or `createAntigravityPlugin` wrapper. The installed `./server` manifest export agrees with package resolution, matches the pack's bytes, and is actually read by the native process. No checkout product source opens are observed in the native host trace.
- Pre-approves only synthetic enrollment in a separate setup child, using the existing custody/enrollment fixture. This permitted source-based **fixture setup is not packing evidence** and never injects a host plugin factory. Serving connects through the installed Claustrum/SubC client's real connection-file/socket protocol to an owned synthetic vault.
- Native `auth.json` is genuinely absent immediately before `auth login --provider google --method "Activate approved Antigravity vault"`. Native login persists exactly the Google custody tombstone with empty access and zero expiry. Native catalog includes `google/antigravity-gemini-3.8-flash`.
- Native non-attach `run` sends exactly one initial physical **POST `/v1internal:streamGenerateContent?alt=sse`** through the unchanged production raw AGY TLS sender to loopback **443**, with the pinned Host name and a matching owned-CA certificate. TLS verification is not disabled. The decrypted wire contains the synthetic vault bearer/project, resolved `gemini-3.8-flash-high`, agent request identity and the genuine primary prompt nonce; native terminal output contains exact `GA_OK_<nonce>` text and completed STOP step.
- Both dormant-slot controls also serve exactly one vault request each with their own fresh primary nonce and terminal completion. The full physical headers/body contain no dormant access/refresh value; `auth.json` remains byte-identical before/after each request. The expired ordinary Google login therefore does not trigger local OAuth refresh.
- The absent-slot control is an actual native `ProviderAuthError`, exit 1, zero sends, no credential-get calls, and auth remains absent. Package/catalog initialization may still read the plugin module: this is the native **auth-loader prerequisite**, not an assertion that the package file is never opened.
- Every non-PTY child has stdin EOF, isolated HOME/XDG/database/config/temp paths, finite deadlines, captured native stdout/stderr/exit and fresh PID/PPID/birth/SID/group identity. Every final child is exited/reaped, with no timeout or signal failure. The network boundary measures ten controls, only `lo`, no capabilities, NoNewPrivs/seccomp, and namespace-local unprivileged-port floor zero. `.motor/hosts` supplies the committed AGY loopback aliases; no developer hosts/proxies/system trust settings were changed.
- No local account file/store exists before/after, and the complete native file traces contain no syscall naming the private account prefix. No Google OAuth/project/quota DNS/request attempt is observed; any nonstreaming AGY endpoint is rejected by the real peer and fails the TLS-event assertion. Native startup metadata DNS probes (models.dev, antigravity metadata/updater) fail naturally inside the isolated namespace and are retained rather than injected or rewritten.

## Adjudicated V1 slot contract

OAIAUTH ruling **`pm_e4cd990267e41e23`**, relayed by the parent, supersedes the brief's proposed “wrong placeholder cannot send” expectation:

> Retain V1 enrollment-only serving with no host-slot read/validation. The host slot is V1's pre-loader prerequisite; the ownership rule belongs to GA's request connection. A foreign tombstone and an ordinary dormant Google login must both serve from the approved vault, must never put slot credentials on the physical wire, and must leave auth.json byte-identical. Absent auth.json remains native refusal/zero sends. No production host-slot guard is permitted.

The original zero-send expectation remains unchanged in **`original-zero-send-expectation.ts.txt`**, SHA256 `9c838bba7e4e46326c23e80f6d2470673501bab9aef3f376ad50d1e409e3354e`, matching the original measured test hash. Its actual failing task **`bash-4fd59b2cb736ce3b`** remains red: 3 pass / 1 fail / 29 assertions, missing slot zero sends/exit 1, foreign tombstone one send/exit 0. The original test calls this latter case `wrong-placeholder` and its original runner stderr establishes the failed zero-send claim; the adjudicated live test calls the case `foreign-tombstone`, with current results in `receipts/final-summary.json`. Neither receipt nor test claim was silently rewritten as a pass; the live test was corrected by explicit owner adjudication and adds the stronger full-wire and byte-identity dormancy assertions. No product source was changed.

The source trace that initially prompted an owner question is preserved for audit, not proposed as a fix:

1. `packages/opencode/src/plugin/auth-loader.ts:459-485`: host-slot/mode checking belongs to `readLocalHostAuth`; nonlocal startup returns `finishLoad` before it.
2. `auth-loader.ts:610-635`: the returned fetch reads authority and delegates vault traffic to the vault runtime.
3. `packages/opencode/src/plugin/index.ts:744-793` (especially 751-753): vault request admission checks enrollment authority, not the host-slot marker.
4. `packages/opencode/src/plugin/fetch-interceptor.ts:438-484`: the vault interceptor deliberately does not read host auth, syncs its vault pool and invokes the real executor.
5. `packages/opencode/src/plugin/vault-custody.ts:306-354`: custody activation requires custody mode and approved enrollment.
6. Embedded `claustrum/host-slot.js:27-46,60-66` distinguishes provider-matched tombstones for local/status reporting; the mismatched prefix falls to `empty`. Core embedded `claustrum/consumer.js:171-200,220-251` authorizes vault route/credential, not host-slot ownership.

The ruling confirms this separation is intended V1 behavior. A proposed provider-slot guard would have changed the contract and was not implemented.

## Loading-route correction and causal proof

The first genuine installed/native success task **`bash-4ce6196c4ed526d3`** failed only the initial blanket “dist/index.js must never be opened” loading assertion (2 pass / 1 fail / 12 assertions). Both installed `dist/server.js` and installed `dist/index.js` were opened; no checkout product source was opened. The original helper is preserved in **`original-root-open-assertion.ts.txt`**, SHA256 `3e9b8d7dbe95f860fa950c38786fa0ac99924fd96d769214131b231ccee78b86`, matching that receipt's source hash.

The parent approved replacing that unsupported file-open inference with a causal installed-arm control. The package's `src/server.ts:20-44`, manifest, and documented V1 loader contract distinguish hybrid default `server` from the root exports, but **this packet does not attribute why the root file was opened**. A read is not evidence of either factory's execution.

Final causal task **`bash-0bc9518bebaa2fc0`** changes only the owned installed bundle's exact unique `server: AntigravityCLIOAuthPlugin` property to a throwing function, with marker **`NON-VACUITY BREAK: installed hybrid.server called`**. There is no fallback source wrapper or transport injection. Native login stderr logs `failed to load plugin` with that exact marker. Read the decoded native channels at `receipts/decoded/bash-0bc9518bebaa2fc0/login.stderr` and `login.stdout`; they are carried inside the original recorder stdout's gzip/base64 receipt. The original **test-runner** stderr instead names the finite-deadline assertion failure. The official host then prompts for an API key instead of the vault method; stdin is EOF, and the existing 30-second deadline terminates/reaps it. Native signal/timeout/reap fields are in the receipt's `processes` and `recorder-bindings.json`, distinct from the 240-second outer runner cap. No TLS request occurs. Exactly the named native test fails; all four assertion tests pass (1 fail / 4 pass / 15 assertions). This is a bounded native activation failure, not an unbounded suite hang.

- Original/restored installed server SHA256: `8a7749ab3ac499bb9b91553fb76664fe4fc82830f682741904e209ca29dafd33`.
- Mutated installed server SHA256: `7ffcb305ed61bcc7f07d80e8e5460dc14ad484638ffdb771bec5b1f011fb3546`.
- The exact installed diff and restored SHA are in that decoded receipt's `serverArmControl`.
- The live helper was saved in Git's index before each mutation; working diff was empty, then non-empty, then restored from the index and touched, then empty again. `mutation-evidence.json` records the diff pairs and exact red names.
- Restored task **`bash-296fd7d9c5af0f17`** then recovers all five passing tests, with the **same** installed server/core entry and pack hashes. The final test source hashes are checked against the delivered source bytes.

Three smaller validator neutralizations also redden only their named test: bearer fence (`bash-a4ac75fb770e697a`), dormant whole-wire credential fence (`bash-881d5496af0642f7`), and Google side-call fence (`bash-00f0e7cb9719e0cd`). Each runs the four assertion tests without a host, has 3 pass / 1 fail / 1 filtered out, and is restored before the final positive.

## Original receipts, hashes and exits

**Authoritative original recorder copies:** `receipts/original-aft/<task-id>/control/{command.sh,metadata.json}` and `io/{stdout,stderr}`. They are byte-for-byte copies of this worker's own AFT records. `receipts/recorder-bindings.json` gives the original absolute recorder path, each copied-file SHA256, outer exit, actual remote terminal/job/input-tree record, test result names and native exits. Environment snapshots/retry payloads/private TLS keys are not copied.

**Decoded evidence:** `receipts/<task-id>.json` is the exact gzip/base64-decoded JSON, with its hash in the bindings. `receipts/decoded/bash-296fd7d9c5af0f17/` and `receipts/decoded/bash-0bc9518bebaa2fc0/` expose the final positive and causal control's native channel bytes, complete syscall traces, primary wire, credential calls and individual slot-control data for bounded inspection. Those are derived views; the raw original recorder output remains authoritative. `capture-receipts.py <own-AFT-session-recorder-directory>` copies only the allowed command/metadata/output records and checks copied bytes against the originals; it can regenerate derived views for the earlier attempts too.

| Task | Meaning | Inner / remote / outer exit |
| --- | --- | --- |
| `bash-3f60ed8d2f1c8971` | Initial tsc before remote core declarations were built | 2 / 2 / 2 |
| `bash-fd8700493cb5dd86` | Core build + both tsc passed; initial formatting/import check failed | 1 / 1 / 1 |
| `bash-8e51e6e7a14c55de` | SDK preparation tried nonexistent root SDK path | 1 / 1 / 1 |
| `bash-4ce6196c4ed526d3` | Genuine initial request succeeded; unsupported blanket root-open assertion red | 1 / 1 / 1 |
| `bash-4fd59b2cb736ce3b` | Original wrong-tombstone zero-send contract red, now adjudicated | 1 / 1 / 1 |
| `bash-b84880fe8cdd49bf` | Own string-to-Uint8Array hash type errors (corrected, no cast) | 2 / 2 / 2 |
| `bash-87af5051d8dcb2c8` | Earlier installed-arm control, preserved rather than substituted for final proof | 1 / 1 / 1 |
| `bash-820b81044935d564` | Both tsc passed; remaining import/format errors (corrected) | 1 / 1 / 1 |
| `bash-105c01fc99d3aa8c` | Strict root/scoped types + five-file Biome + 26 shared regression tests pass | 0 / 0 / 0 |
| `bash-be7672be14f712d6` | Adjudicated native test pass before final mutations | 0 / 0 / 0 |
| `bash-0bc9518bebaa2fc0` | Final installed hybrid.server control; bounded native login red | 1 / 1 / 1 |
| `bash-a4ac75fb770e697a` | Bearer validator control | 1 / 1 / 1 |
| `bash-881d5496af0642f7` | Dormant credential validator control | 1 / 1 / 1 |
| `bash-00f0e7cb9719e0cd` | Google call validator control | 1 / 1 / 1 |
| `bash-296fd7d9c5af0f17` | Restored final native + root/scoped types + five-file Biome pass | 0 / 0 / 0 |

These are direct runner commands/chains, not success wrappers around failed inner tests. Final native children: version, enrollment setup, login, catalog, first request, foreign tombstone and dormant login exit **0**; absent-slot native refusal exits **1** by design. All eight are reaped with no timeout. The installed-arm control's login exits by **SIGTERM**, with deadline flag true and reaped true; its suite/remote/outer exits are **1**, not a pass.

Final actual remote job: **`01a12c04-0328-763e-98a3-892830e6ecc9`** (see original metadata for the authoritative value). Actual remote input-tree hash: **`23354c04e8025dda8d599484dfdfea7426d4d7f9`**. The receipt's `sourceTree`/`GA_SOURCE_TREE` value `56fc6c3b4e389179b1f1e796ab96862b9b8e19af` is only the caller's staged-index hint; AFT snapshots additional worktree evidence, so it is **not** the actual job input tree. Use `metadata.remote.terminal.tree_hash` and the measured per-file hashes. `receipts/final-summary.json` explicitly separates the two.

Final SHA256s (full paths and source hashes in `receipts/final-summary.json`):

| Artifact | SHA256 |
| --- | --- |
| Admitted official archive (54,631,676 bytes) | `04a172f44c3449e1251f6f4b4dc9c391166a078c5aba04c9c1717411b4e84331` |
| Actual extracted ELF / version 1.17.13 | `ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d` |
| Real core tarball | `ad870ca68860f0b09221775437c7429d3286015c400c9449dbbcdc720474036e` |
| Real OpenCode tarball | `faa7a5e0ef78468b18a4fb4e6df0db223e07eb21abc272b2383435b0e1fb004c` |
| Installed manifest-selected server | `8a7749ab3ac499bb9b91553fb76664fe4fc82830f682741904e209ca29dafd33` |
| Canonical installed core entry | `2ebc1980a244e363d5ea41e55f72932dc5693161384f7d3c8711bb6e351b801f` |
| Initial decoded primary request body | `e682e5e0a0a94d74838945901c9bba935c824b28a232372365e16f7011650f99` |
| Foreign-tombstone decoded request body | `77b8cb16fe7f0e3f00e6c4104a14dac1f66a638d87ef689233b537d30db87017` |
| Dormant-login decoded request body | `f95125f9502eda569facc6a303afafcb7bb5d6694ba856eda4eb96b88662a62d` |

Actual archive SRI is checked against the independently admitted `sha512-6naffcRwMLUM0kYuwJ3tRWt1/NXPybt9u8ZqTvSZwATM54+GhQmoiz8Qb9GYFTiwSJmB1rq8VoEmwh1VPzBcFw==`, not accepted on the basis of a self-generated digest. The parent supplied the owned ignored archive and authorized staging **only that input** for MOTOR transfer. It is now unstaged and will not enter the component commit. No host was fetched.

## Reproduction and remaining gaps

All executable build/type/test/host gates run through `runon: linux,2c`, foreground with finite caps and no outbound network. The stable native command is:

```sh
bun test --isolate ./packages/e2e-tests/src/v1-packed-vault.e2e.test.ts
```

The test performs its own measured boundary check, official archive verification/version probe, owned offline consumer preparation, real build/pack/install and native drive. MOTOR must have the exact admitted archive in the owned path (stage only by explicit input-owner authorization), installed frozen fixtures, committed `.motor/hosts`, and namespace-local port floor zero. Do not run the host on the operator machine.

After the test's isolated build, authoritative type/lint commands are:

```sh
bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json
bun node_modules/typescript/bin/tsc -p research/v1-packed-vault/tsconfig.json
./node_modules/.bin/biome check packages/e2e-tests/src/v1-packed-vault-harness.ts packages/e2e-tests/src/v1-packed-vault.e2e.test.ts packages/e2e-tests/src/opencode-ga-host-inputs.ts packages/e2e-tests/src/opencode-ga-harness.ts packages/e2e-tests/src/v1-vault-activation-harness.ts --error-on-warnings
```

The scoped config simply extends the strict normal root program; it has no .bun path aliases, declaration shims or weakened compiler options. Local activity was limited to Git, file editing/formatting and original-record copying/decoding; no local build/type/test/native host gate was run. Package manifests/lockfiles/workflows/product code and all earlier native activation research/receipts remain unchanged. The parent owns command/CI wiring.

Gaps: this is one admitted Linux-x64 V1 floor and synthetic enrollment/credential experiment, not live Claustrum enrollment, fleet behavior, other platforms/host versions, engine-range enforcement for npm-name registration, or public release readiness. The allowed package-directory route bypasses the host's npm-name acquisition/engine gate. The root index-file open is not causally attributed. The TLS fixture returns synthetic terminal content without usage data. Build outputs/packs/CA files are guest-owned and regenerable; only hashes, original command/exit/output and decoded wire/syscall evidence are retained here. The inspector reports PARTIAL because the TypeScript language server crashes during mise initialization; authoritative Linux tsc passes. Final source/comment/original-receipt review and commit approval remain with the parent.
