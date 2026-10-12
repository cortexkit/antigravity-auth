# Native red-first diagnosis

## Measured result (before any product edit)

The baseline **fails**. One running official OpenCode 1.17.13 process served two requests from an authentic published-2.2.1 pool through freshly built and packed 3.0.0 packages, and rewrote the pool after the second request.

- Original recorder namespace: `c1cd4f2098959f91`; task `bash-908b0af4c4425b60`; native job `01a12d0d-0c01-7214-9216-342762db8980`; actual remote input tree `b16584085e3a52e9f56d41406c7f8b3d66bca2ac`.
- Original command: `bun --version && bun test --isolate ./packages/e2e-tests/src/v1-unmigrated-upgrade.e2e.test.ts`. Bun 1.4.2; inner and outer exit 1. One test failed at the zero-TLS assertion: expected 0 requests, received 2. There was no setup error in this attempt.
- Both native API responses were HTTP 200 with assistant text `GA_OK_92030db9b50646b1fec6f038159d5ead`, not the requested offline-migration refusal.
- TLS recorder captured two real POSTs to `/v1internal:streamGenerateContent?alt=sse`, `Host: daily-cloudcode-pa.googleapis.com`, `Authorization: Bearer synthetic-upgrade-access`, project `synthetic-upgrade-project`.
- Native server PID 209, parent/group/session 207, birth/start `62685868`, non-zombie, leader exit null at startup, after each request, and immediately before cleanup. It was not a per-request CLI restart. Cleanup reaped it via SIGTERM without timeout or signal failure. Old writer had already exited 0 and was fully reaped before server startup.
- Pool SHA256 before old-writer shutdown, before new-host startup, and after request 1: `7b5aae0f2755414dd1278c3d5f047580c1d8403537fcc7a2dbcefc7980ecf82a`. After request 2 and final host cleanup: `fd5f48b58a589cfa7db52f9dbbfe1a13d44f87386a6fa46dd994207174f0698a`.
- Syscalls show pool chmod, reads, an exclusive `.accounts.lock`, temporary pool-file creation, rename over the original, and lock unlink. Native auth.json remained unchanged. No new account-store generation/pointer/journal was observed. These are observations of a failing baseline, not a zero-account-mutation claim.

The native receipt retains the network and process-isolation measurements from the repository's unmodified `measureNativeJob` helper (Linux x64, only lo, empty capabilities, NoNewPrivs/Seccomp, inherited namespace, denied escape and external traffic), namespace-local port443 sysctl, host archive SRI/size/SHA256, extracted ELF SHA256/machine, and actual executed 1.17.13 version. Pack manifests both report 3.0.0 and the plugin core pin is exactly 3.0.0. Installed manifest entry and resolved entry are under the owned consumer, not source factories; source and entry hashes are retained in the same receipt.

## Authentic old writer provenance

Public registry metadata and release archive were acquired separately, before the egress-disabled native job. The package is `@cortexkit/antigravity-auth-core@2.2.1`, gitHead `626cce39848b4b6db2d64ff7cbed1f7b4dc0259d`, 149696 archive bytes, SHA1 `b79e2384f0e55a3267b20d9b8e8f5416f204a1df`, SHA256 `d36d22ffca3c06f1e495218bc48fbf462d0babef329f576a211181c5d15f5cf1`; published SHA512 SRI is verified before bounded unpacking. All 115 archive members are inventoried. The separate old child imports the released public index by its manifest and calls its real `saveAccountStorage` and `generateFingerprint` APIs. It does not import the new core. Synthetic account inputs are not hand-written pool bytes.

## Causal source chain at baseline

1. `packages/opencode/src/server.ts` exposes `AntigravityCLIOAuthPlugin` on the normal default hybrid server entry. Installed-entry syscall trace and hashes witness loading the actual pack.
2. `packages/core/src/account-migration.ts:1998-2009` returns a pending unbound binding for a legacy pool with no published pointer. `packages/opencode/src/plugin/storage.ts:486-503` maps that to `migration-required`, but its message only names the unpinned `antigravity-auth migrate --offline`.
3. `packages/opencode/src/plugin/auth-loader.ts:184-196` explicitly includes `migration-required` in `usesPoolFile`. `runLoader` at 487-518 therefore bypasses refusal. With valid synthetic host OAuth it loads the manager at 583 and installs a `pool-file` request runtime at 584.
4. `packages/opencode/src/plugin/accounts.ts:52-67` backs that manager with legacy load/save operations. `packages/opencode/src/plugin/storage.ts:625-665` allows those operations when no store pointer exists, delegating pool-file reads and lock-held writes to the current core storage implementation.
5. `installRuntime` in `auth-loader.ts:382-389` builds the production fetch interceptor. `packages/opencode/src/plugin/fetch-interceptor.ts:50-56` selects the unchanged real TLS transport, which is observed by the recorder. The selected account is updated and its debounced save replaces the pool, as witnessed in the syscall trace.

Merely removing migration-required from `usesPoolFile` would hit an auth-loader throw with a generic cannot-open error; it does not yet prove running-host startup/liveness or the required fixed request error. The proposed alternative—return a loader result whose generative fetch refuses locally without building an account manager—needs native error/liveness review before product editing.

## Scope and setup records

Account mutation includes the original pool and all sidecars, store generations/pointers/backups/journals/migration files, credentials and native auth.json. Normal owned OpenCode session DB/WAL/SHM, logs/cache, and plugin RPC runtime files are separately inventoried and are not account mutation. Sidebar state, `.gitignore` and config changes are retained in the full tree diffs and not silently hidden. No migrate, rollback, or enrollment was run; no live credentials or user profile was read.

Two setup-only failures are preserved unchanged, not presented as behavioral red evidence: `bash-505c05340e156421` could not see the initially ignored hydrated archive; `bash-d6cba1883ab3ced8` attempted an unnecessary effect dependency closure and could not resolve pure-rand. Original commands, metadata, stdout/stderr and exits for these two setup attempts and the behavioral run `bash-908b0af4c4425b60` are retained and hashed.

Correction to the initial setup inference: `assertGaFixturePins` expects the **lock packages** set, which contains transitive subc-client, not just the five manifest root dependencies. The unchanged assertion actually passed in the measured job. There is no verified fixture mismatch and no attribution of a fixture change to the version-only commit. With parent approval, the new consumer copies the already installed runtime dependency packages rather than installing another host. Each copied file is read through a no-follow file descriptor and hashed; each selected package version is checked against the old or new package's declared dependency range. Plugin main publicly exports tool.js, whose runtime dependency is zod; sdk is also staged. Unused effect/AI-provider plugin subpath dependencies are not executed or staged.

Remaining proof gaps before a final gate: add explicit OAuth/project/quota boundary counters and a broad file-write fence with positive non-vacuity controls; test all fixed-message and account-mutation assertions independently rather than stopping at the first failure. The real TLS requests and native assistant responses show that the baseline model is in the plugin's registered catalog and that synthetic OAuth credentials are sufficient to serve it. Background update DNS probes occurred inside the disabled namespace; no egress was granted. The final proof must retain native error semantics, refuse without synthesis of success, and preserve the original deadlines and strict cleanup.
