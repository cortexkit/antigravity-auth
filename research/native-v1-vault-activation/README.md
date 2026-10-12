# Official OpenCode 1 fresh-profile vault activation

## Measured result

The Linux-x64, loopback-only test **passes on official OpenCode 1.17.13**:

- Native `auth.json` is absent immediately before `auth login --provider google --method "Activate approved Antigravity vault"`.
- Genuine production composition supplies the auto method. The marker is not a Google login: its access token is empty and its refresh field identifies vault custody. The native host writes exactly `{google: {type: "oauth", access: "", refresh: "claustrum-tombstone:v1:google", expires: 0}}`.
- Native `run --dir <private project> --format json --model google/antigravity-gemini-3.8-flash` loads the production auth loader. The first and only physical Antigravity (AGY) request carries the served synthetic bearer and project. The production model resolver routes this catalog entry to `gemini-3.8-flash-high`.
- The real Claustrum client/embedded common-auth 0.14.1 consumer reads an attributed synthetic OAuth credential over its normal connection-file/socket protocol. All credential gets assert the same credential/account/project; its requested minimum TTL is 300000 ms. Non-attach host initialization can perform two gets, not two physical model requests.
- Native stdout contains completed `step_start`, fixture `text`, and `step_finish` JSON events, including STOP and meaningful usage (1 input, 7 output, 8 total). Exit status is zero.
- No account pool or repository file exists before or after the run. `strace -f -e trace=%file` observes no syscall naming the private account-file prefix, which also covers its `.store` subtree. No Google token refresh, local OAuth dependency call, or managed-project endpoint is admitted/observed.
- Every owned native/seed process group is exited and reaped. All profiles, environment paths, RPC/sidebar files and OPENCODE_DB are private. Runtime exposes only `lo`; there is no runtime egress, Docker, operator HOME, or live enrollment.

This proves only this controlled first-request experiment, not fleet, release, live-vault, packed-consumer, or other-platform readiness.

## Composition and isolation

The host loads a generated private file plugin which calls `createAntigravityPlugin('google', {dependencies})` from the unchanged production source. It observes, but does not replace, the returned loader. Auth methods and the response transformer remain production code. The supported AGY transport dependency routes the real transformed request to an owned 127.0.0.1 recorder. No synthetic auth loader or fake host is used.

Approved enrollment is prepared using the genuine custody/enrollment library with a synthetic setup-only enrollment connection. Serving uses the real Claustrum client against an owned loopback daemon with the client's own framing/proof implementation, not a mock client or consumer. No local account store is seeded. Tokens/keys printed in receipts are deliberately synthetic.

Startup version/changelog/models.dev probes are rejected before network I/O and recorded separately as metadata denials. All other non-loopback fetches are rejected and fail the test. The AGY recorder accepts only the streaming model endpoint; unexpected project/quota/login endpoint calls cannot satisfy the single-request assertion. Request payloads containing long host prompts/tool declarations are retained as SHA256/byte counts; outer model/project and physical bearer headers are recorded verbatim. Native child stdout/stderr and exact response SSE bytes are retained in JSON.

ck-motor's tracked-lockfile setup installs dependencies with `--ignore-scripts` before entering the job's network-disabled namespace. Native config directories link that prepared SDK and provide already-locked declarations, preventing runtime package acquisition. The real installed SDK version is checked against 1.17.13. The admitted fixture package.json and bun.lock are unchanged copies of the supplied official 1.17.13 Linux-x64 fixture files; there is intentionally no `opencode-ai` wrapper dependency.

## Official bytes and source association

- Publisher: `https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.17.13.tgz`.
- Publisher SRI: `sha512-6naffcRwMLUM0kYuwJ3tRWt1/NXPybt9u8ZqTvSZwATM54+GhQmoiz8Qb9GYFTiwSJmB1rq8VoEmwh1VPzBcFw==`.
- Independently acquired archive: 54631676 bytes, SHA256 `04a172f44c3449e1251f6f4b4dc9c391166a078c5aba04c9c1717411b4e84331`; publisher SHA1 also matched.
- Independently extracted ELF x86-64 executable: 167639168 bytes, SHA256 `ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d`. Every experiment hashes the binary installed by ck-motor's tracked-lockfile setup against this independently derived record and runs `--version` under the same private profile/job before driving it.
- The 1.17.13 fixture/source files came from antigravity-auth commit c9814552; the 1.18.30 comparison files came from openai-auth commit ea9e6f8. `receipts/input-integrity.json` verifies 21 attached byte-count/hash rows; the two arm64 rows are intentionally absent.
- Official tag v1.17.13 associates with upstream commit `10c894bdeef3618f5666fb506ef7f9491bb964d8`. The additional original upstream source in `host-source/run.ts.txt` was fetched from that exact commit at `https://raw.githubusercontent.com/anomalyco/opencode/10c894bdeef3618f5666fb506ef7f9491bb964d8/packages/opencode/src/cli/cmd/run.ts`; SHA256 `11ebfd7a301282459ab1ffd6e3eae28e47344c9782273c7966efa4a9850b3a83`. This is tag/source association, not binary-to-source build attestation.
- Product tree base: `d89c151945b95461a05f22d63aae71abf27852a2`. Native receipts carry SHA256s for the measured helper/test, unchanged production factory and common-auth source-output manifest.

The large acquisition archive remains ignored, not committed. Engineering review authorized adding the unchanged fixture package.json/bun.lock to Git's index so ck-motor's tracked-lockfile setup could install the official executable before runtime.

## Attached topology limitation, not reclassified as a pass

The first attached experiment logged successful login with an initially missing auth.json, persistence of its non-credential custody marker, native loader execution, attributed bearer/project and one physical AGY request; its CLI exited zero but stdout/stderr were empty. The terminal-output assertion failed. `receipts/first-red-native.json` now matches the original native stream bytes; `first-red-transcription-corrections.json` preserves the previous transcription and its four omitted configuration-log lines. The complete original command, stdout/stderr and actual exit metadata are retained under `receipts/original-aft/bash-20f4682ca963d688/`. That original byte-preserved record is authoritative, including the help probes and full request observations.

The exact official CLI source explains a scoped limitation: it starts the subscribed output loop at `host-source/run.ts.txt:829-833`, but `finish()` returns immediately for `--attach` at lines 834-838 instead of awaiting `completed`. Text/step-finish emission is inside that loop at lines 744-749. This is not proof of a generic host failure and is not a product fix.

A separate diagnostic queried the real host's stored messages after CLI completion, without an added wait or retry inside the experiment. `receipts/attached-stored-result.json` records an assistant with fixture text, completed timestamp, STOP and 1/7/8 usage, plus the exact response-wrapped SSE bytes with terminal blank separator. The production transformer forwards that terminal frame before terminating (`packages/opencode/src/plugin/core/streaming/transformer.ts:611-626`). This isolates terminal capture from response decoding/vault dispatch.

Engineering review explicitly approved the smaller genuine **non-attach** native process topology, which awaits output-loop completion. The earlier attached result remains red. Deadlines were never extended, no terminal assertion was skipped, and no product source was changed.

## Measurement history and retained evidence

1. Missing local archive synchronization: archive transfer to the Linux job, not an experiment. Engineering review supplied ck-motor's tracked-lockfile setup. The unchanged direct-platform fixture then resolved and its ELF/version/CLI flags were measured under isolation.
2. Initial attached test: 0 pass / 1 fail / 7 assertions, empty terminal output. Native streams are in `first-red-native.json`.
3. Two attached diagnostic captures added exact response bytes/stored messages and then compact request-payload export. The latter stored assistant is retained in `attached-stored-result.json`; these helper runs were never treated as native test passes. Intermediate complete diagnostic gzip stdout was initially emitted only to tool results; it has now been recovered and retained from the original AFT recorder without another host execution.
4. First non-attach test: terminal text/step-finish assertions passed, but the test's assumed single credential-get count failed (0 pass / 1 fail / 14 assertions). All actual gets were identical and there was only one physical model request. The test now requires at least one get and validates every get's attributed parameters, rather than asserting an unjustified host initialization count.
5. Non-attach pass: 1 pass / 0 fail / 23 assertions. `non-attach-pass.json` preserves complete native child streams and request/response observations; its gzip transfer encoding is also retained. This snapshot precedes only import-order/comment cleanup.
6. Local file-fence control: a real nonexistent-account `statSync` attempt inside the loaded plugin caused only the named native test to fail at `localFileSyscalls`; terminal completion and cleanup still succeeded.
7. Google token-URL control: a real call through the installed guard to `https://oauth2.googleapis.com/token` caused only the named native test to fail at `forbidden-network`; model dispatch and cleanup still succeeded, and no account syscalls occurred.
8. Final source verification after restoring both controls and cleaning imports/comments: 1 pass / 0 fail / 23 assertions; TypeScript 6.0.3 scoped no-emit passed; Biome 2.5.3 checked 2 files with no fixes/errors; Bun 1.4.2 core build copied 128 embedded files. `final-verification.json` binds the final source hashes to raw completed native CLI output.

9. Engineering review requested birth/SID/process-group validation, benign ESRCH handling, descendant cleanup after leader exit, a finite socket-listener close, and genuine subc-client public declarations. The helper now reuses the repository's existing `public-command-processes.test.ts` ownership inspection/signaling/cleanup functions and records each child's captured identity. The two new controls reject changed leader/member birth identities before dispatch, tolerate an injected exit-to-signal ESRCH, and actually terminate a surviving forked descendant after its leader has exited. These checks use the existing fresh-identity pattern, not an atomic kernel pidfd guarantee. The synthetic listener's close is bounded to 5000 ms after tracked sockets are destroyed. The handwritten protocol mirror/cast is replaced by `typeof import('@cortexkit/subc-client')`; the private TypeScript configuration maps that transitive name to the installed package's declared public `dist/index.d.ts` entry. After these source corrections, the exact scoped commands above passed again: 3 tests, 0 failures, 35 assertions. `review-corrections-verification.json` records the final source hashes, captured native process identities and raw completed CLI output. No host run was repeated merely for wording changes.

10. Engineering review identified that the root `tsconfig.scripts.json` includes this harness but did not inherit the temporary private type-resolution mapping. Its actual pre-join check failed with TS2307. The task branch then inherited the engineering-owned dependency commit `3642153f7f59421626725dac9bd4eedab9efbbe8` using a fast-forward merge, together with the archive policies in `2c10862a`. That commit declares the already locked `@cortexkit/subc-client@0.16.1` in the private end-to-end workspace. The private paths override was removed entirely. In one isolated Linux job, the core build, normal root TypeScript program, scoped no-override TypeScript program, two-file Biome check and all three native/ownership tests passed (3 pass, 0 fail, 35 assertions). The actual original AFT task is `bash-129b57d568a8ae0d`; `normal-root-join.json` is derived from its byte-preserved output. No primary/fleet install or dependency alias was introduced by the test component.

The original AFT recorder files are now durable in `receipts/original-aft/`: 12 command/metadata/stdout/stderr snapshots, each copied byte-for-byte with a SHA256 manifest. Source command, job input tree association, disabled network and outer exit are in metadata; actual inner test/native exits are in raw stdout/stderr. Mutation-control wrappers exit zero when their inner test correctly exits one; those statuses must not be conflated. The ownership-corrected native/changed-birth/ESRCH/descendant test task before the dependency join is `bash-5e0cabecd6112309`; the first attached failing task is `bash-20f4682ca963d688`. Environment snapshots were not copied. Original source records remain unchanged; only the earlier manual transcription was reconciled transparently.

`mutation-controls.json` names each failing test and records the mutation/restoration steps. The live implementation was first saved in Git's index and an empty working diff was confirmed. Each control then produced a non-empty diff and the expected test failure. The helper was restored from the index and touched, and the working diff was confirmed empty again. Neither mutation remains in the source.

## Reproduction

Include `oc-fixture/package.json` and `oc-fixture/bun.lock` in the Git snapshot consumed by ck-motor's tracked-lockfile setup. Do not execute this test on the operator machine. In the Linux-x64 namespace with only loopback and ck-motor's installed dependencies:

```sh
bun run --cwd packages/core build
bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json
bun node_modules/typescript/bin/tsc -p research/native-v1-vault-activation/tsconfig.json
./node_modules/.bin/biome check packages/e2e-tests/src/v1-vault-activation-harness.ts packages/e2e-tests/src/v1-vault-activation.e2e.test.ts --error-on-warnings
bun test --isolate ./packages/e2e-tests/src/v1-vault-activation.e2e.test.ts
```

The test emits a gzip/base64 JSON receipt, including raw native streams. Decode it outside regenerable build directories before retiring the job. `--run --attach` on the helper is an explicitly diagnostic topology, not the passing test.

The standalone AFT inspection was partial because its TypeScript language server failed to initialize through mise; both authoritative Linux tsc programs above passed after the normal dependency join. Full workspace tests were not repeated for this source-only fenced experiment; engineering review reported that the base already passed combined Linux build, TypeScript, component, end-to-end and hygiene checks; this does not substitute that statement for the exact scoped commands above. Final source/comment/receipt review and commit approval remain with engineering review.
