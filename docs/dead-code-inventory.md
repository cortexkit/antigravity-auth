# Common-auth migration: bounded dead-code inventory

Base reviewed: `ca92ad8f9945fe7e9fa3ba5b7d2bf13ee3a0360b` (3.0.2). This is one cleanup round, not an exhaustive unused-export audit. V1 means OpenCode 1.x; GA means OpenCode 2's generally available plugin API. `ARCHITECTURE.md` and `STRUCTURE.md` describe the supported repository, shared request executor, vault and menu paths.

## Reachability evidence

The deletion rows below concern **symbols**, not whole modules. The live portions of `command-data.ts` and `gemini-dump.ts` remain.

- **R1 — references and dispatch:** exact-symbol searches across source, tests and tooling find `createCommandDataService` only in its definition and the `command-data.test.ts` harness. Its options/view/storage/service interfaces and quota-result type belong to that harness/service. Callgraph reports `makeHarness` as its only caller; that agrees with the searches, rather than establishing deadness by itself. The V1 composition uses `projectCommandAccountRows` (`plugin/index.ts:853,872`) and core's shared account menu through `commands.ts:250–281`. `account-command-oauth.ts:24,39,47,89,198` uses the row type. The old service's set-current/toggle/remove/quota methods have no live dispatcher.
- **R2 — retired command:** exact searches for `GeminiDumpCommandAction`, `parseGeminiDumpCommandAction`, `executeGeminiDumpCommand`, `renderGeminiDumpCommand` and the module-level `buildGeminiDumpStatusSummary` find only the implementation and command-only tests (`gemini-dump.test.ts:38–60`). `GeminiDumpState.executeCommand` is likewise unused by production bindings. The registered menu's Diagnostics section uses the switch, not the retired argument parser (`command-apply.ts:67–95`). The tests in `plugin-entry.test.ts:338–372` and `commands.test.ts:92–101` assert that only `/antigravity` is registered and other commands remain the host's responsibility; those claims stay.
- **R3 — dynamic imports and string registries:** source imports of these modules select named live bindings, not namespace lookups by command/action ID. OpenCode's production dynamic imports under `src/` load Node readline/process capabilities; the hybrid TUI's computed entries are explicitly `tui-raw/tui.tsx`, `tui-compiled/tui.js`, `tui-ga-raw/host-ga.tsx` and `tui-ga-compiled/host-ga.js` (`src/tui/entry.mjs:17–31`). Core's lazy capability imports load fixed embedded common-auth modules, not either candidate service. Searches of the deleted symbols and the old command string in registries find no alternate dispatch. Common-auth owns account/menu action dispatch; `/gemini-dump` is not a registered runtime command. The surviving `gemini-dump` test constant does not register it.
- **R4 — publication:** core's root barrel exports migration, storage, models, vault and the shared command menu (`core/src/index.ts:13–23,40,52–55`); none of the deletion rows is a core export or core subpath. OpenCode's manifest exports only `.`, `./server`, `./tui`, with `bin.antigravity-auth` at `dist/cli.js` (`opencode/package.json:33–69,137–139`). Its `files` **does** ship `src/plugin/command-data.ts`: preserve that file and its live projection, rather than treating the allowlist as proof of a runtime caller. `server.js` forwards `dist/server.js`; `tui.js` forwards `src/tui/entry.mjs`. Neither forwarder exports these helpers. Pi's root export and `pi.extensions` use `dist/index.js` (`pi/package.json:13–24,34–43`). No manifest or export-map change is proposed. Undocumented OpenCode internal helpers are removed; no published core API is removed.
- **R5 — build and graph contracts:** `opencode/tsconfig.build.json:16–27` includes the source tree and excludes tests and generated render trees; broad inclusion is not evidence of execution. Searches of `packages/opencode/scripts/` and root `scripts/` find no candidate-module or deleted-symbol file list. `build-tui.ts` delegates to the producer build; its import-graph and pack tests remain intact. Keep both candidate modules and their paths, renderer entry points and credential-isolation checks. Typecheck, full build and packed TUI consumer smoke must verify the remaining module surfaces after deletion.

Line references in this inventory describe the base revision, before deletions.

## Candidate verdicts

| Candidate | Why it looks dead | Evidence | Verdict (delete / keep / fold) |
| --- | --- | --- | --- |
| `opencode/src/plugin/command-data.ts:createCommandDataService` (including its nested service-only closures) | Old data-first dialog read/refresh and pool mutation orchestration, replaced by the shared menu and attributed account operations. | R1, R3–R5; defined at base lines 480–906; only caller is test `makeHarness`. | **delete** |
| `command-data.ts:CommandDataAccountManagerView` | Structural view consumed only by the obsolete service and its harness. | R1, R3–R5; base lines 307–357. The live projection instead accepts `CommandDataAccountStorage`. | **delete** |
| `command-data.ts:CommandDataStorage` | Locked-storage adapter consumed only by the obsolete service. | R1, R3–R5; base lines 359–380. Actual pool-file and repository adapters remain. | **delete** |
| `command-data.ts:CommandDataServiceOptions` | Configuration solely for the obsolete factory. | R1, R3–R5; base lines 382–410. | **delete** |
| `command-data.ts:CommandDataService` | Interface solely for the obsolete factory and harness. | R1, R3–R5; base lines 412–470. | **delete** |
| `command-data.ts:CommandDataAccountQuotaResult` | Local structural quota result solely for the obsolete service. | R1, R3–R5; base lines 94–112. Keep metadata/group types used by the projection. | **delete** |
| `opencode/src/plugin/command-data.test.ts`: obsolete service harness and service-only tests | These instantiate the deleted service, not the current command dispatcher. | Base `makeHarness:113–368`, service suite `378–1567`, sidebar-service suite `1569–1669`. Retain independent coverage of the shared row projection: privacy/ordinal labels, cache-only reads, identity mismatch, unstamped legacy cache, normalization, percentages/reset times and both quota groups. Retarget those assertions to `projectCommandAccountRows` before removing the service harness; do not delete current menu/repository/sidebar tests. | **delete** service-only tests; **keep** projection assertions |
| `opencode/src/plugin/gemini-dump.ts:GeminiDumpCommandAction` | Discriminant type solely for the retired command parser. | R2–R5; base lines 29–33. | **delete** |
| `gemini-dump.ts:parseGeminiDumpCommandAction` | Parses arguments of an unregistered command, rather than shared-menu actions. | R2–R5; base lines 119–129; callgraph leads only to its renderer and command-only tests. | **delete** |
| `gemini-dump.ts:executeGeminiDumpCommand` | Module-level wrapper for retired command rendering. | R2–R5; base lines 146–151. | **delete** |
| `gemini-dump.ts:renderGeminiDumpCommand` | Only called by the unused state method. | R2–R5; base lines 153–176. Delete its exclusive `DUMP_ENABLED_TITLE`, `DUMP_DISABLED_TITLE`, `DUMP_USAGE_TITLE` and `DUMP_USAGE` constants too. | **delete** |
| `gemini-dump.ts:GeminiDumpState.executeCommand` and factory property | No live caller; current menu owns dispatch and confirmation. | R2–R5; base lines 70–71,92–93. Keep state switch, `dumpRequest` and state `buildStatusSummary`. | **delete** |
| `gemini-dump.ts:buildGeminiDumpStatusSummary` (module-level wrapper only) | Used only by retired command tests. | R2–R5; base lines 131–133. The state method and private `renderGeminiDumpStatus` are separately live and stay. | **delete** |
| `opencode/src/plugin/gemini-dump.test.ts`: first two command-only tests | Sole consumers of retired parser/module status/command renderer. | Base lines 38–60. Request/response capture, enabled/disabled switch and redaction tests at 63–170 stay. | **delete** command-only tests |
| `command-data.ts:projectCommandAccountRows`, `CommandAccountRow`, `CommandDataAccountStorage`, projection helpers/types | The old service is dead, but its privacy-safe projection is not. | R1; live V1 account OAuth result projection and row contracts. Keep the file listed in the manifest and preserve projection assertions. | **keep** |
| `gemini-dump.ts:legacyDumpState`, switch/dump wrappers, `resetGeminiDumpState`, `GEMINI_DUMP_COMMAND_NAME` | Legacy naming suggests dead singleton state. | V1 `plugin/index.ts:569–573,603–609,662–670` binds the switch; `fetch-interceptor.ts:236` binds `dumpGeminiRequest`. Reset and constant are used test seams (`gemini-dump.test.ts`, `shared/location-state.test.ts`, `plugin-entry.test.ts`). | **keep** |
| `gemini-dump.ts`: request/response writer, redaction and location state/status | The command is retired, not the diagnostic request capture. | `request.ts:2822–2825,2877–2879`; `shared/request-services.ts:1923–1934,2005`; `shared/runtime.ts:307–313,416–422`; live dump/redaction and location-isolation tests. | **keep** |
| `opencode/src/plugin/persist-account-pool.ts` and guarded pool-file storage operations | Pre-store implementation resembles replaced runtime. | `plugin/index.ts:752–764,833–843` still dispatches to pool-file versus repository login; `commands.ts:317–359` retains that source/target selection. Guards refuse retired pools (`storage.ts:386–397,627–677`). | **keep** |
| `core/src/account-migration.ts` and CLI `migrate`/`rollback` | Offline legacy migration is not on ordinary request calls. | Public barrel export; migration/rollback factories and pool parsing remain supported upgrade/recovery APIs. Tests in `test/common-auth-010-store/migration-crash.test.ts` exercise the actual embedded common-auth store, rather than a mock, including migration and rollback; e2e store seeding and CLI also reach them. | **keep**; removing public exports would be breaking |
| `opencode/src/plugin/storage.ts:unboundOpening` / unmigrated-pool refusal | Refusal branch can look like obsolete pool compatibility. | `openAccountStore:523–570` returns `migration-required` for the legacy-only binding; `storage.test.ts:791–802` and V1 loader/entry/e2e tests exercise refusal. No implicit fresh-store conversion or local request fallback is permitted. | **keep** |
| `core/src/account-storage.ts`, `AccountStorageV4` reader and schema | Old pool format predates the store. | Public core barrel plus migration, CLI and guarded pool-file adapters still read it; do not remove v1–v4 compatibility or fail-closed unreadable-file behavior. | **keep**; removing public exports would be breaking |
| `custodyPlaceholder`, `isCustodyPlaceholder`, host tombstone recognition and V1 activation | Marker values are not ordinary OAuth credentials. | Embedded public claustrum host-slot API; `vault-activation.ts:69`, `vault-custody.ts`, Pi setup and `stream.ts:557–560`; activation/source/slot tests use genuine placeholders. V1 enrollment-only serving and GA/Pi ownership are intentionally different. | **keep** |
| Historical Claude 4.6 model enums and `isRetiredAgyModel` | Retired models have no selectable public catalog entry. | `request-services.ts:515,865`, `request.ts:2705`, Pi `stream.ts:377,463` still reject retired IDs. Core barrel exports the registry and metadata; historical wire metadata remains readable. | **keep** |
| `PluginDependencyOverrides`, `_on*Created` hooks and `__fixtures__` | Test-only reachability can resemble dead production code. | Source/e2e harnesses and lifecycle/consumer tests use these composition seams; test reachability is intentional. | **keep** |
| `opencode/src/plugin/fetch/retry-state.ts` and `warmup.ts` | State helpers used by the pre-shared interceptor could have been superseded. | Shared executor imports and constructs both (`request-services.ts:56–60,773–774`); `shared/import-graph.test.ts:204–209` pins that graph. | **keep** |
| OpenCode terminal auth menu (`plugin/ui/auth-menu.ts`) | Shared `/antigravity` could appear to replace it. | CLI prompts still call `showAuthMenu`, `showAccountDetails`, `showFingerprintHistory` (`plugin/cli.ts:11–14,167,192,221`), through the published CLI binary. | **keep** |
| OpenCode/Pi menu and vault wrappers | Similar names suggest a fold into core. | Both already delegate shared behavior to `createAntigravityCommandMenu` / `createAntigravityVaultAccountSource`. OpenCode host sections and Pi provider-slot/setup effects are not the same behavior (`commands.ts:250–281`, Pi `commands.ts:119–208`, `vault-source.ts:259–280`). Core is the existing shared destination, not a reason to merge unlike host effects. | **keep**; no genuine duplicate approved for folding |

## Scope and application plan

`research/` directories are **out of scope**: committed evidence, not runtime code. Both `src/common-auth-embedded/` trees and their manifests are **generated producer output** and must not be edited. Package manifests, root scripts, lockfiles, and CI are not permitted to change in this cleanup and need no changes for the proposed symbol deletions.

The inventory step changes only this document, before any runtime deletion. After reviewer approval, remove exactly the delete rows and exclusive imports/constants; preserve the named projection assertions by exercising the live projection directly. Correct the obsolete service and `/gemini-dump` descriptions in `ARCHITECTURE.md` and `STRUCTURE.md`, and any other permitted documentation that names removed behavior. Do not migrate live singleton bindings or refactor unrelated code.

## Mutation checks

Review of the committed inventory (`ee29ddb2e457761c8b460ba5bdec79b8d257ae62`) approved removing the tests-only service and retired argument renderer, while keeping live projection, diagnostic capture and upgrade paths. Approval required the kept projection assertions to run directly and demonstrate their guards before the old service harness was removed. Those five tests were retargeted and passed (5 tests, 22 assertions), all ten projection controls listed below then failed individually, and all five tests passed again after restoration. Only the 35 service-only tests and two retired-command tests were deleted; live dump and location-state tests were not changed.

These controls were later kept as rows of a root mutation catalogue replayed in CI. That catalogue and its CI replay jobs have since been removed; git history keeps their exact production anchors and replay commands.

The 14 controls recorded while removing the tests-only command service and retired dump renderer were:

- `command-projection-ordinal-labels`
- `command-projection-email-redaction`
- `command-projection-cache-only`
- `command-projection-quota-identity`
- `command-projection-unstamped-legacy`
- `command-projection-cache-wiring`
- `command-projection-legacy-normalization`
- `command-projection-percentages`
- `command-projection-reset-times`
- `command-projection-both-quota-groups`
- `unmigrated-pool-refusal`
- `offline-migration-independent-cursors`
- `pi-vault-placeholder-recognition`
- `gemini-dump-project-redaction`

The original isolated Linux checks reported **0 passing tests, 1 failing test** for each production mutation, with all other tests filtered rather than claimed as passing; the selected tests passed before mutation and after byte restoration. The cache-wiring break discarded canonical readings before normalization; the separate legacy-normalization break retained canonical readings but lost legacy non-Gemini keys. No OpenCode/Pi implementations were merged into core. The verification results below remain the historical cleanup results, not a claim that any later replay has completed.

## Verification results

All gates ran on the Linux runner. Tool versions: Bun **1.4.2**, TypeScript **6.0.3**, Biome **2.5.3** (Linux Node **24.21.0**). No manifests or lockfiles changed and no test selector was relaxed for the required full gates.

| Command/check | Result |
| --- | --- |
| `bun run --cwd packages/core build` (first gate) | Passed; TypeScript emit and 129 embedded files copied. |
| `bun run typecheck` | Passed; core, OpenCode V1/GA, Pi, e2e GA and root script profiles, including 77 strict embedded declaration roots. |
| `bun run build` | Passed; three packages, two audited bundles, V1 25-file and GA 12-file raw/runtime renderer trees and finalized declarations. |
| `bun run test` | **Failed**: 3,299 pass, 20 fail, 6 errors; 3,319 tests in 173 files, 17,864 assertions. Failure details below; this is not an all-green claim. |
| `bun run test:e2e` (preceded by core build in the same Linux job) | Passed; 79 tests in 5 files, 529 assertions. |
| `bun run --cwd packages/opencode smoke:tui` (preceded by core build) | Passed with registry network access; 4 fresh packs, 8 product and 4 baseline consumers. An initial network-disabled job failed at `npm install --ignore-scripts` with `ETIMEDOUT`; it is not counted as passing. |
| `bun run format:check` | Passed; 452 files checked, no fixes. |
| `bun run lint` | Passed; 452 files checked, no fixes or warnings. |
| Direct `projectCommandAccountRows` suite after service deletion | Passed; 5 tests, 22 assertions. |
| Prepared public-consumer run of the five projection tests, three kept dump tests, and named refusal/migration/Pi-marker controls | Passed after restoration; 11 tests in 5 files, 74 assertions. Only the narrow supplemental run filtered unrelated tests; the full root gate above did not. |
| `bun test --isolate packages/opencode/src/plugin/shared/location-state.test.ts` | Passed unchanged; 36 tests, 205 assertions, including dump switch/isolation and collision-free IDs. |
| TOML/control-target validation (Python 3.14.4) | Passed; 14 parsed controls, each `old` occurs exactly once in its live target, each replacement contains the break marker, and no live source contains a break marker. |
| Source diagnostics | Partial: TypeScript language-server startup failed parsing the environment's mise configuration. Biome reported no changed-file diagnostics; authoritative root TypeScript checks passed. |

### Full source-suite limitations

The full selector ran without changes to tests outside the approved deletions. Its failures were in unmodified behavior/test targets:

- **Runner prerequisites:** `embed.clean_input` could not find `docker`; `build.repo_hygiene` and `build.private_toolchain` could not install frozen compiler dependencies from the runner's offline Bun cache (`@opentui/core`, `@opentui/solid`, `typescript`, Babel dependencies and others absent). No Docker/private-cache checks are represented as passes.
- **Unsafe runner fixture ancestor:** both `the production V1 RPC apply refreshes sections when switching …` cases, `selected credential boundary > production Pi provider refuses enrollment approved during its project await`, and `enrollment authority at loader and request start > serves public vault enrollment with a genuinely corrupt unused local store` were stopped by Claustrum's existing `unsafe-file` guard: the public-consumer fixture was under a writable `node_modules` ancestor. No enrollment guard or permissions policy was bypassed.
- **Deadline/cleanup failures:** ten `owned real-process migration crash seams` cases hit their 2.5/3/5-second child or test bounds (add/disable/enable/remove write seams, rollback after-retire, fresh after-build). `replays after an actual child exit at after-state-write`, `createAntigravityCommandMenu > refuses an item whose credential was replaced, writing nothing`, and `does not refund an earlier physical main debit when supersession blocks the next auxiliary attempt` also hit existing deadlines. These are recorded failures, not proven baseline passes. The ordinary lossless migration control and restored refusal/marker controls passed in the narrower prepared-consumer run.

The cleanup did not change these failing targets or their bounds. The full suite was not rerun in a pristine base checkout, so timing failures are not independently certified as baseline failures. Required next gate action is to rerun the unchanged full selector on a Linux runner with Docker, the frozen offline compiler cache, safe fixture ancestors and sufficient child-execution capacity; no cleanup-code workaround is proposed.
