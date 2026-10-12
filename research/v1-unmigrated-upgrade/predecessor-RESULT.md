# Unmigrated 2.2.1 upgrade release gate

## Result

The unmodified 3.0.0 preparation served and rewrote the real published-2.2.1 pool. After the bounded adapter change, the native gate passes **19 tests / 136 assertions** with production plugin defaults enabled. The final native job is `bash-2d1909ee147087bf`, job `01a12d3f-8b16-73ef-86a6-085eb8f96df8`, actual input tree `8f1f850bd845cba8dd667dc126cecd35652d3fd3`; both inner and outer exits are 0. `FINAL-SUMMARY.json` is a derived navigation aid; the original terminal records and gzip receipt are authoritative.

One official OpenCode 1.17.13 server, PID 211 / birth 63015714, remains alive across both refused model requests. Both native assistant messages contain an `APIError` with statusCode 412, isRetryable false, and exactly:

> Antigravity accounts require offline migration. Stop OpenCode, then run `npx @cortexkit/opencode-antigravity-auth@3.0.0 migrate --offline`.

No assistant success text is synthesized. Generation, OAuth, project, quota, unknown TLS calls, TLS accepts, OAuth DNS attempts, and account-file mutation syscalls are all zero during the negative phase. The original pool SHA256 stays `c30340125e80be0dd8684020363075434f328f12710553a22086d917ff6ac075` before writer shutdown, before host startup, after each request, and after native instance disposal and owned host shutdown. Full account/credential/sidecar inventories also retain bytes, inode, mode and modification time. No new store, pointer, journal or backup is created in this phase.

## Product change

- Storage supplies one static, pinned migration instruction for `migration-required`.
- The loader returns its existing delegating fetch without constructing a manager or refresh queue. Local generative calls receive Google's 412 `FAILED_PRECONDITION` envelope; unrelated fetches retain normal passthrough and caller cancellation. Request-time authority is still checked first, so an approved vault can serve without reading the dormant native login.
- Account target resolution no longer treats `migration-required` as permission to use the pool. Account-state sidebar publication and quota/tier producers leave the unavailable local target untouched; they do not fabricate an empty manager or change defaults.
- Two prior unit assertions deliberately change contract: an existing pool's opening now has the pinned command, and `usesPoolFile(migration-required)` is false. Fresh-install and bound-store tests remain unchanged.

No core migration/store primitive, embedding, dependency, manifest, lockfile, updater policy, existing native helper, `.motor/hosts`, or documentation outside this evidence directory is changed.

## Exact host retry behavior

The official v1.17.13 `session/retry.ts`, `provider/error.ts` and package manifest are retained as separately acquired public source, with URL/byte/SHA256 provenance in `official-retry-source/inventory.json`. The native binary itself remains pinned by the original archive SRI/size/SHA256, ELF machine/hash and executed version in each receipt.

The official retry function returns immediately for an APIError when `isRetryable` is false and status is not at least 500 (`retry.ts.txt:68-75`). This precedes its API message handling at line 122 and the plain-text rate-limit patterns at lines 125-150. The measured Google SDK error has the exact instruction, status 412 and `isRetryable: false`. Native logs show exactly two INFO process attempts and no retry status; each API request terminates under the original finite deadline. The release manifest pins Google's SDK to 3.0.73; the native result, rather than a guessed SDK parser, proves the actual message extraction.

## Positive companions

1. Approved synthetic vault custody serves a real model request through the production raw TLS path while the old local pool and retained Google OAuth bytes stay unchanged. The actual native activation command reports authentication failure rather than overwriting that occupied slot. The served bearer/project are the synthetic vault's, not the dormant local credential. Existing occupied-slot, vault shutdown, caller cancellation and passthrough tests pass unchanged.
2. After the hosts and old writer are fully stopped, the actual packed new CLI runs `migrate --offline --yes` and exits 0. The same binary, profile and 3.0.0 packs then restart. A real production OAuth POST obtains a synthetic renewed bearer; the first model request succeeds over real TLS with the correct project and nonce. Public read-only packed-core inspection shows the same RowRef/credential epoch, no access token immediately after migration, then the persisted renewed accessToken and unchanged refresh secret after serving. No manager, transport or migration result is injected.

The owned DNS responder binds only namespace-local 127.0.0.1:53, answers A only for oauth2.googleapis.com, gives no AAAA address and rejects every unknown name. This native job has no `/etc/resolv.conf`; its actual resolver reaches the local responder, as proved by a separately recorded control. The CA/leaf covers exactly the two admitted AGY hostnames and OAuth2; generated input/output hashes and actual form-encoded refresh bytes are retained. Trust is limited to that owned startup CA. No shared DNS/hosts/trust setting, TLS verification override, capability or egress grant is used. The unchanged containment helper passes both before and after fixture cleanup.

## Background and mutation proof

No antigravity.json settings suppress production quota, proactive-refresh, recovery, warmup or update defaults. A source companion forces a real default quota tick through the existing clock/timer seam and waits for its next schedule before disposal. Kernel directory notifications catch even transient poll-lock creation. Removing its admission predicate uniquely reddens that companion; the unrelated package-export test stays green.

Two earlier attempts exposed inadequate observations: disposing at the timer callback could stop asynchronous admission before the lock phase, and a promise-module spy did not observe the imported file-lock implementation. Both undefended controls are retained; the final witness uses natural tick completion and real kernel notifications. Neutralizing the native syscall write detector uniquely reddens its real baseline-write control while the baseline-send/error control stays green. Breaking the static instruction uniquely reddens the loader contract test while the handle-surface test stays green.

Omitting OAuth from the recorder, without changing its real response, uniquely reddens the genuine migration companion at the expected refresh-count assertion; the negative OAuth-zero test stays green. The first attempt at this control did not reach refresh: immediate SIGTERM of a successful vault request left an outstanding sidebar lock. The harness now invokes the official `/instance/dispose` endpoint to drain the native instance before strict owned process cleanup, preserving the original time limits. That earlier unrelated 500 is retained as not-reached evidence, not credited as a counter proof. Structured entries are in `mutation-evidence.json`.

## Evidence layout and scope

`original-aft.tar.gz` retains the byte-identical `original-aft/c1cd4f2098959f91/<task>/control|io` TerminalRecord tree, including commands, stdout/stderr, metadata, inner/outer exits and available pipeline status. `original-record-hashes.json` binds each member, and `original-archive.json` binds the archive. The expanded copies remain in this owned worktree but are ignored to keep Git review bounded; the archive preserves the actual tree, not reconstructed terminal text. Decoded receipts are stored as gzip; only the baseline JSON is also committed because the positive write/send control reads it directly.

Account mutation scope includes legacy pool bytes and metadata; all pool locks, temporary files and sidecars; credentials/native auth.json; sidebar account state; and all new-store generations, pointers, backups, journals and migration files. OpenCode session database/write-ahead-log/shared-memory files, host logs/cache and plugin RPC connection/port files inside the owned temporary profile are separately inventoried normal runtime, not account mutation. Global host state and live profiles are never read. All account, enrollment and refreshed bearer values are synthetic; application client identifiers in the real OAuth form are unchanged published constants.

All setup failures and intermediate failed gates are retained, including ignored-archive ENOENT, unnecessary effect dependency resolution, initial resolver-file assumption, typed socket annotation error, sidebar-state writes exposed with defaults, corrected native INFO/error log counting, the accessor assertion corrected from access to the public accessToken field, and the mistaken disconnect method corrected to the existing useLocal operation. The initial assertion that the GA fixture mismatched was an inference error: its lock includes transitive subc-client, and `assertGaFixturePins` passed unchanged.

Final strict checks: TypeScript 6.0.3 passes the script, OpenCode and evidence programs; Bun 1.4.2 runs 136 unit tests / 770 assertions across the six relevant files; Biome 2.5.3 checks eight changed TypeScript files. Native build/pack and all 19 gate tests pass in the final no-egress Linux-x64 job. No tag, publish, push or fleet operation occurred. Commit is held for the parent engineering agent's independent source/receipt review.
