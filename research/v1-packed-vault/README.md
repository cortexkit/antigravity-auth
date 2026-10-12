# Official OpenCode 1.17.13: packed vault and raw-TLS experiment

## Result

A logged command runs the installed-package test `packages/e2e-tests/src/v1-packed-vault.e2e.test.ts` on the official Linux-x64 OpenCode **1.17.13** executable, then runs both TypeScript programs and the source check. That restored run, **`bash-7717476eb6763ff7`**, reports **5 tests, 0 failures, 50 assertions**. All checks pass in the same network-isolated, two-CPU Linux job.

| Check | Tool / result |
| --- | --- |
| Native installed-package tests | Bun 1.4.2; 5 pass / 0 fail / 50 assertions |
| Root `tsconfig.scripts.json` | TypeScript 6.0.3; exit 0 |
| Scoped `tsconfig.json` here | TypeScript 6.0.3; exit 0; no aliases/shims or relaxed options |
| Five-file source check | Biome 2.5.3; five files, no changes/errors |
| Shared GA helper/parser regression tests | `opencode-ga-harness.test.ts` checks archive installation, process ownership, namespace validation and resolver/parser behavior; `bash-105c01fc99d3aa8c`, 26 pass / 124 assertions; no GA host executed |

This is research evidence for one controlled installed-package request path, **not a claim of public release readiness**.

## What runs

The test builds and packs the real core and OpenCode packages in isolated Linux, then installs their verified ordinary tar members into a fresh consumer directory outside the checkout. It reuses `installNativeGaPacks` rather than the GA factory wrapper. The pinned Claustrum/SubC, jsonc-parser, xdg-basedir and zod dependencies are copied from the frozen standalone consumer fixture; the prepared SDK/plugin packages are checked at 1.17.13. The GA 2.0.22 executable is not copied or run. The installed core dependency resolves to the actual core pack, not a workspace link; core is also bundled into the OpenCode server build.

Official OpenCode receives normal plugin configuration containing a file URL to the **installed package directory**. The manifest's `./server` export agrees with installed package resolution, matches the packed bytes and is read by the native process. No native trace opens checkout product source. There is no direct dist-entry configuration, factory wrapper, injected transport, fake OAuth refresh, URL rewriting or response cache.

A separate setup child pre-approves synthetic enrollment using the existing custody/enrollment fixture. That setup is permitted fixture preparation, **not packing evidence**. It does not inject a host plugin factory. During serving, the installed production Claustrum/SubC client obtains a fresh synthetic token and project over its normal connection-file/socket protocol.

After enrollment, the native `models google` probe must exit successfully and list `google/antigravity-gemini-3.8-flash`. Both enrollment and this catalog probe leave native `auth.json` genuinely absent. The real native auth command then activates the approved vault and writes an OAuth-shaped marker with empty access, zero expiry and refresh `claustrum-tombstone:v1:google`: a noncredential indication that Google requests use vault custody. Non-attach native `run` sends one physical POST to `/v1internal:streamGenerateContent?alt=sse` through the unchanged production raw AGY TLS sender on port 443. An owned CA and matching certificate are trusted only by this child; TLS verification is never disabled.

The decoded wire must carry the vault's bearer/project, `gemini-3.8-flash-high`, agent request identity and the primary prompt nonce. Native stdout must contain exact `GA_OK_<nonce>` text and a `step_finish` JSON event with reason `stop`, showing that the host completed the streamed model step. The initial request and each serving control have independent nonces.

## V1 enrollment authority and dormant Google slots

The initial test **incorrectly expected a foreign custody tombstone to block vault sends**. V1 deliberately chooses serving authority from approved vault enrollment and ignores the contents of the stored Google slot. The slot's presence is a native prerequisite for calling the auth loader; it is not the source of vault credentials.

The authentication owner reviewed V1 authority and confirmed that contract in decision **`pm_e4cd990267e41e23`** (OAIAUTH): a foreign tombstone and an ordinary dormant Google login must both serve from the approved vault, leave `auth.json` byte-identical and never put stored-slot credentials on the physical wire. No production host-slot guard was added.

| Control | Native result | Physical requests | Additional assertions |
| --- | --- | --- | --- |
| Absent `auth.json` | `ProviderAuthError`, exit 1 | 0 | Auth remains absent; no credential-get calls |
| Foreign tombstone in Google slot | Exit 0, completed nonce-bearing output | 1 vault request | Tombstone absent from all recorded headers/body; auth bytes unchanged |
| Expired ordinary Google login | Exit 0, completed nonce-bearing output | 1 vault request | Dormant access/refresh absent from all recorded headers/body; auth bytes unchanged; no local OAuth refresh |

Package/catalog initialization may still open the plugin module in the absent-slot case. The refusal concerns the native **auth-loader prerequisite**, not a claim that the package file is never read. Complete native file traces contain no syscall naming the private account-file/store prefix, and those local artifacts remain absent. No Google OAuth/project/quota DNS/request attempt is observed. The loopback TLS peer rejects nonstreaming AGY endpoints, and any such error fails the test. Startup metadata DNS probes fail naturally in the network-isolated job and remain in the evidence.

The original wrong-tombstone test remains a **failed test**, not a retroactive pass: **`bash-4fd59b2cb736ce3b`**, 3 pass / 1 fail / 29 assertions, expected zero sends but observed one. Its case name was `wrong-placeholder`; the corrected case is `foreign-tombstone`. The original source is `original-zero-send-expectation.ts.txt`, SHA256 `9c838bba7e4e46326c23e80f6d2470673501bab9aef3f376ad50d1e409e3354e`, matching its measured source hash. Original receipts were not changed or relabeled as passes, so the failed expectation and subsequent contract correction remain inspectable.

The intended production path is visible in unchanged source:

| Source | Relevant behavior |
| --- | --- |
| `packages/opencode/src/plugin/auth-loader.ts:459-485` | Local host-slot check; nonlocal startup returns `finishLoad` before it |
| `auth-loader.ts:610-635` | Returned fetch chooses the vault runtime when authority is vault |
| `packages/opencode/src/plugin/index.ts:744-793`, especially 751-753 | Vault request admission checks enrollment authority, not stored-slot contents |
| `packages/opencode/src/plugin/fetch-interceptor.ts:438-484` | Vault interceptor does not read host auth; syncs the vault pool and invokes the executor |
| `packages/opencode/src/plugin/vault-custody.ts:306-354` | Custody requires custody mode and approved enrollment |
| Embedded `claustrum/host-slot.js:27-46,60-66` | Provider-matched tombstone classification for local/status reporting |
| Core embedded `claustrum/consumer.js:171-200,220-251` | Authorization concerns the vault route/credential, not host-slot ownership |

## Proving that the installed default server arm is needed

Reading a file does not prove that its factory ran. The initial installed-package run opened both installed `dist/server.js` and installed `dist/index.js`, so the first assertion incorrectly rejected the root-file open. That failure remains preserved as **`bash-4ce6196c4ed526d3`** and `original-root-open-assertion.ts.txt`, SHA256 `3e9b8d7dbe95f860fa950c38786fa0ac99924fd96d769214131b231ccee78b86`. This report does **not** attribute why the root entry was opened. `packages/opencode/src/server.ts:20-44`, the package manifest and `packages/opencode/docs/opencode2-ga-2.0.22-contract.md:95` (the documented V1 loader contract) distinguish the hybrid default's `server` function from root exports.

The causal control changes only the owned installed bundle's unique `server: AntigravityCLIOAuthPlugin` property to a function throwing **`NON-VACUITY BREAK: installed hybrid.server called`**. Its purpose is to show that the native catalog depends on that installed default server arm, rather than a source/factory fallback.

The installed-server-arm control, **`bash-8ae6099bff85bace`**, fails exactly **`Packed plugin did not register its catalog`**. Native `models google` exits naturally with code 1 and `Provider not found: google`; no auth-login child is launched, no TLS request occurs, no child times out or receives a signal, and every child is reaped. Only the named native test fails; the four assertion tests pass (1 fail / 4 pass / 15 assertions). The existing deadlines were not changed.

| Installed server bytes | SHA256 |
| --- | --- |
| Before mutation and after exact restoration | `8a7749ab3ac499bb9b91553fb76664fe4fc82830f682741904e209ca29dafd33` |
| Mutated server arm | `7ffcb305ed61bcc7f07d80e8e5460dc14ad484638ffdb771bec5b1f011fb3546` |

The installed diff/hashes are in `receipts-r2/bash-8ae6099bff85bace.json`; native output and traces are exposed under `receipts-r2/decoded/bash-8ae6099bff85bace/`. `mutation-evidence-r2.json` records the staged-live / applied-diff / restored-empty-diff sequence. After restoring the server bytes, **`bash-7717476eb6763ff7`** passes the catalog, fresh activation, raw-TLS request and dormant-slot tests with identical product tarballs and installed server/core entry hashes.

Earlier controls **`bash-87af5051d8dcb2c8`** and **`bash-0bc9518bebaa2fc0`** logged the exact native failed-plugin marker but failed only after login's 30-second deadline. Those timeout-dependent receipts remain unchanged; they are historical controls, not the revised direct-assertion proof. The first catalog-before-login attempt, `bash-601108a356dde190`, verified that `models google` exited naturally with `Provider not found: google`; the generic command-exit check caught exit 1. The next attempt asserts both native exit 0 and presence of the Antigravity catalog entry under the single failure message `Packed plugin did not register its catalog`.

Removing each validator makes its corresponding assertion test fail: requiring the vault bearer in Authorization (`bash-a4ac75fb770e697a`), rejecting dormant access/refresh values anywhere in recorded physical headers/body (`bash-881d5496af0642f7`), and rejecting observed Google OAuth/project/quota DNS/request attempts (`bash-00f0e7cb9719e0cd`). Each has 3 assertion tests pass / 1 fail / 1 native test filtered out. All validators were restored before the final serving run. Details and exact failed/passed names are in `mutation-evidence.json` and the original runner stderr files.

## Original command/output records and exit metadata

Each task has byte-preserved original runner files:

- `control/command.sh`: the exact submitted command;
- `control/metadata.json`: task ID, original path, outer exit, remote job ID/outcome and actual input-tree hash;
- `io/stdout` and `io/stderr`: actual runner output, including gzip/base64-encoded JSON with native command arguments, process ownership, output/exit records, decoded wire and credential calls, plus the test results.

For the first 15 tasks, use **`receipts/original-aft/<task-id>/`** and **`receipts/recorder-bindings.json`**. For the three revised tasks, use **`receipts-r2/original-aft/<task-id>/`** and **`receipts-r2/recorder-bindings.json`**. The two `recorder-bindings.json` files give original absolute recorder paths, copied-file SHA256s, decoded receipt hashes, test names, native exits and remote/outer exits. Copies were checked against the original bytes. Environment snapshots, retry payloads and private TLS keys are excluded.

`receipts/<task-id>.json` and `receipts-r2/<task-id>.json` are exact decoded native receipts, not manually rewritten transcripts. Materialized native channel bytes, full syscall traces, wire records and credential calls are under each collection's `decoded/` directory. In the first collection, those readable views are retained for `bash-296fd7d9c5af0f17` and `bash-0bc9518bebaa2fc0`; the original encoded/decoded records preserve every earlier attempt. `capture-receipts.py` records the first collection; `capture-receipts-r2.py` copies/decodes later tasks from the experiment's recording-session directory without writing the frozen first collection. `README-r1.md` preserves the previously reviewed report.

| Task | Observation | Command / remote / outer exit |
| --- | --- | --- |
| `bash-3f60ed8d2f1c8971` | Initial tsc lacked fresh guest core declarations | 2 / 2 / 2 |
| `bash-fd8700493cb5dd86` | Core build and both tsc programs passed; initial formatting/import check failed | 1 / 1 / 1 |
| `bash-8e51e6e7a14c55de` | SDK preparation tried a nonexistent root SDK path | 1 / 1 / 1 |
| `bash-4ce6196c4ed526d3` | Initial request succeeded; incorrect root-file-open assertion failed | 1 / 1 / 1 |
| `bash-4fd59b2cb736ce3b` | Incorrect foreign-tombstone zero-send expectation failed | 1 / 1 / 1 |
| `bash-b84880fe8cdd49bf` | Own string/Uint8Array hash type errors; corrected without casts | 2 / 2 / 2 |
| `bash-87af5051d8dcb2c8` | Historical timeout-dependent installed-arm control | 1 / 1 / 1 |
| `bash-820b81044935d564` | Both tsc programs passed; remaining import/format errors corrected | 1 / 1 / 1 |
| `bash-105c01fc99d3aa8c` | Strict types, five-file Biome and shared regression tests passed | 0 / 0 / 0 |
| `bash-be7672be14f712d6` | First corrected V1 dormancy test passed | 0 / 0 / 0 |
| `bash-0bc9518bebaa2fc0` | Historical timeout-dependent installed-arm control | 1 / 1 / 1 |
| `bash-a4ac75fb770e697a` | Removing bearer validator failed its assertion test | 1 / 1 / 1 |
| `bash-881d5496af0642f7` | Removing dormant-credential validator failed its assertion test | 1 / 1 / 1 |
| `bash-00f0e7cb9719e0cd` | Removing Google-call validator failed its assertion test | 1 / 1 / 1 |
| `bash-296fd7d9c5af0f17` | Earlier restored positive, strict types and Biome passed | 0 / 0 / 0 |
| `bash-601108a356dde190` | Catalog-before-login control verified natural native exit; command-exit check failed | 1 / 1 / 1 |
| `bash-8ae6099bff85bace` | Revised installed-arm control failed exact native catalog assertion | 1 / 1 / 1 |
| `bash-7717476eb6763ff7` | Revised restored positive, root/scoped types and Biome passed | 0 / 0 / 0 |

Failed tests keep their nonzero command, remote and outer exit statuses; none is presented as a successful command. Final native children version/enrollment/catalog/login/first-request/foreign-tombstone/dormant-login exit 0; absence of the native Google auth slot triggers the host's `ProviderAuthError` and exit 1, as required. All eight are reaped, without timeout or signal failure. Revised installed-arm control children version/enrollment exit 0 and catalog exits 1 naturally; all are reaped, without timeout/signal. The historical timeout controls instead have login SIGTERM and timeout true. Native channel evidence is inside the runner stdout receipt; the separate runner stderr names the failed test/assertion.

### Actual remote input tree versus caller hint

The native receipt's `sourceTree`/`GA_SOURCE_TREE` field is a caller-supplied staged-index hint. The runner also captures worktree evidence, so that hint is **not** its actual job input-tree hash. Actual identities come from `metadata.remote.terminal`; per-file source hashes bind the tested code to the delivered source. `receipts/final-summary.json` and `receipts-r2/final-summary.json` keep these fields separate.

| Measurement | Actual job | Actual input tree | Caller hint |
| --- | --- | --- | --- |
| Earlier passing serving run `bash-296fd7d9c5af0f17` | `01a12c04-0328-763e-98a3-892830e6ecc9` | `23354c04e8025dda8d599484dfdfea7426d4d7f9` | `56fc6c3b4e389179b1f1e796ab96862b9b8e19af` |
| Revised direct control `bash-8ae6099bff85bace` | `01a12c1a-71ef-705b-b2bc-64354ea46d76` | `262d5fff94accc2a5fb601400234c8f6045ea9c5` | `d3e8884ee8728ea9797d82053910181b11b5fe00` |
| Revised passing serving run `bash-7717476eb6763ff7` | `01a12c1b-b30e-7506-b962-60e1d08b56e3` | `1d08ff3baf5a8da399091574b50db0579237b871` | `d3e8884ee8728ea9797d82053910181b11b5fe00` |

### Final artifact hashes

`receipts-r2/final-summary.json` lists full installed paths, final per-file source hashes, slot byte-identity hashes and native exits. The earlier `receipts/final-summary.json` is unchanged. Hashes below are SHA256; pack/installed hashes are identical before mutation, after restoring the server file and in the final passing serving run.

| Artifact | Hash |
| --- | --- |
| Official archive, 54,631,676 bytes | `04a172f44c3449e1251f6f4b4dc9c391166a078c5aba04c9c1717411b4e84331` |
| Extracted ELF, actual version 1.17.13 | `ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d` |
| Core tarball | `ad870ca68860f0b09221775437c7429d3286015c400c9449dbbcdc720474036e` |
| OpenCode tarball | `faa7a5e0ef78468b18a4fb4e6df0db223e07eb21abc272b2383435b0e1fb004c` |
| Installed manifest-selected server | `8a7749ab3ac499bb9b91553fb76664fe4fc82830f682741904e209ca29dafd33` |
| Installed core entry | `2ebc1980a244e363d5ea41e55f72932dc5693161384f7d3c8711bb6e351b801f` |
| Revised initial decoded primary body | `f574738066b442632b4ea2ff7642fc99efdc73d2a79579b3ddd510c42b7fca3b` |
| Revised foreign-tombstone decoded body | `e9f19b68564dcdccd9493cd7757bad6b4333e74ebd1f7c3004808bb682ffe143` |
| Revised dormant-login decoded body | `f6da6af749c5b91fcb89dcdf163cfe100e0c41e89a2f6309a3269d6947f781cb` |
| Earlier initial decoded primary body | `e682e5e0a0a94d74838945901c9bba935c824b28a232372365e16f7011650f99` |
| Earlier foreign-tombstone decoded body | `77b8cb16fe7f0e3f00e6c4104a14dac1f66a638d87ef689233b537d30db87017` |
| Earlier dormant-login decoded body | `f95125f9502eda569facc6a303afafcb7bb5d6694ba856eda4eb96b88662a62d` |

The engineering owner supplied the official npm archive and the publisher's SRI recorded in `research/native-v1-vault-activation/README.md:27-38` (publisher URL: `https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.17.13.tgz`). The gate checks actual bytes against that separately supplied size, SHA256, ELF hash and SRI `sha512-6naffcRwMLUM0kYuwJ3tRWt1/NXPybt9u8ZqTvSZwATM54+GhQmoiz8Qb9GYFTiwSJmB1rq8VoEmwh1VPzBcFw==`; a hash generated by the gate itself is not accepted as official provenance. The supplied ignored archive was staged only to transfer those bytes into the guest. It is now unstaged and is not part of the component commit. No host download occurred.

## Reproduction prerequisites and scope

Run executable build/type/test/host checks in a **network-isolated Linux-x64 job with two CPUs**, not on the operator machine. The job must receive that exact supplied 1.17.13 archive (size/hash/SRI above) at `.cortexkit/parent-inputs/v1-packed-floor-r1/opencode-linux-x64-1.17.13.tgz` and the installed frozen dependencies. Transfer an ignored input only with explicit input-owner authorization; do not commit the archive. Required guest setup:

- `.motor/hosts` supplies Antigravity's two pinned API hostnames, `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`, as loopback aliases;
- `/proc/sys/net/ipv4/ip_unprivileged_port_start` is `0`, permitting owned port 443 without capabilities;
- only `lo` is exposed, capabilities are empty, NoNewPrivs and syscall filtering are enabled;
- OpenSSL, strace and the pinned Bun/TypeScript/Biome tools are available.

The test measures ten network/isolation controls rather than trusting an environment flag. All non-PTY children have stdin EOF, isolated HOME/XDG/database/config/temp directories, finite deadlines and recorded fresh PID/PPID/birth/SID/group identities. Cleanup is bounded. Developer hosts, proxies, system trust, live credentials and primary/fleet outputs are untouched.

```sh
bun test --isolate ./packages/e2e-tests/src/v1-packed-vault.e2e.test.ts
bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json
bun node_modules/typescript/bin/tsc -p research/v1-packed-vault/tsconfig.json
./node_modules/.bin/biome check packages/e2e-tests/src/v1-packed-vault-harness.ts packages/e2e-tests/src/v1-packed-vault.e2e.test.ts packages/e2e-tests/src/opencode-ga-host-inputs.ts packages/e2e-tests/src/opencode-ga-harness.ts packages/e2e-tests/src/v1-vault-activation-harness.ts --error-on-warnings
```

The native test prepares/builds/packs its own owned consumer before driving the host; run the subsequent type checks in that same guest so core declarations exist. Local activity was only Git, file editing/formatting and copying/decoding recorder data—no local executable build/type/test/native host gate. Package manifests, lockfiles, workflows, product source and `research/native-v1-vault-activation/` (the earlier source-injected activation experiment and its receipts) are unchanged; command/CI wiring is separate.

Remaining gaps: one Linux-x64 V1 floor and synthetic enrollment/credentials, not live enrollment, fleet behavior, other host/platform versions or public release readiness. The allowed package-directory route does not prove npm-name acquisition/engine-range enforcement. The root index-file open is not causally attributed. The synthetic TLS response has terminal content but no usage data. Guest build outputs, packs and CA files are regenerable; only hashes and original/decoded command, exit, wire and syscall evidence are retained. AFT source-diagnostics inspection could not obtain TypeScript diagnostics because its language server crashes during mise initialization; authoritative Linux TypeScript programs pass. Final source/comment/original-receipt acceptance remains pending.
