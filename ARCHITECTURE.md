# Architecture

## Pattern Overview

**Overall:** OpenCode plugin — fetch-interceptor that transforms Gemini API requests into Antigravity (Cloud Code Assist) format, with OAuth multi-account rotation, quota management, session recovery, and cross-model compatibility.

**Key Characteristics:**
- Single `createAntigravityPlugin` factory exported from `src/plugin.ts` that returns the full OpenCode plugin surface
- All outbound traffic to `generativelanguage.googleapis.com` is intercepted and rewritten before it leaves the process
- Two header-style routing paths: `antigravity` (Electron-style UA + fingerprint) and `gemini-cli` (nodejs-client UA)
- All state (accounts, rate-limit counters, health scores) is module-level; the plugin factory runs once per session
- Config schema is Zod-validated; environment variables always override file config

---

## Layers

**Entry Point / Orchestrator:**
- Purpose: Intercepts fetch calls, manages auth lifecycle, routes requests, handles rate-limit retry loops
- Location: `src/plugin.ts`
- Contains: `createAntigravityPlugin` factory, rate-limit state machines, toast debounce, OAuth login flows, verification probe, account persistence helpers, per-message request counter, capacity retries limited to 1 per endpoint before fingerprint regeneration
- Depends on: Every other layer
- Used by: OpenCode host via `@opencode-ai/plugin` contract

**OAuth / Credentials:**
- Purpose: OAuth token exchange with Google, token refresh, access-token lifecycle
- Location: `src/antigravity/oauth.ts`, `src/plugin/auth.ts`, `src/plugin/token.ts`
- Contains: `authorizeAntigravity`, `exchangeAntigravity`, `refreshAccessToken`, `AntigravityTokenRefreshError`, token expiry helpers
- Depends on: `@openauthjs/openauth`, `src/constants.ts`
- Used by: `src/plugin.ts`, `src/plugin/refresh-queue.ts`

**Request Transform:**
- Purpose: Convert OpenCode/Anthropic-format request bodies into Antigravity (Cloud Code Assist) wire format and back
- Location: `src/plugin/request.ts`, `src/plugin/request-helpers.ts`, `src/plugin/transform/`
- Contains: `prepareAntigravityRequest`, `transformAntigravityResponse`, schema cleaning, thinking-block stripping, tool-hardening injection, cross-model sanitisation, stable system-instruction ordering (prompt → tool hardening → thinking hint) for prompt caching, and streaming cache-stats tracking via `onUsageMetadata` callback
- Depends on: `src/constants.ts`, `src/plugin/transform/`, `src/plugin/thinking-recovery.ts`, `src/plugin/cache/`
- Used by: `src/plugin.ts`

**Model Resolution & Per-Model Transforms:**
- Purpose: Map request model names to Antigravity model IDs, choose header style (antigravity vs gemini-cli), apply model-specific config, resolve thinking tier budgets
- Location: `src/plugin/transform/model-resolver.ts`, `src/plugin/transform/claude.ts`, `src/plugin/transform/gemini.ts`, `src/plugin/transform/cross-model-sanitizer.ts`, `src/plugin/model-registry.ts`
- Contains: `resolveModelWithTier`, `resolveModelWithVariant`, `resolveModelForHeaderStyle`, `applyClaudeTransforms`, `applyGeminiTransforms`, `sanitizeCrossModelPayload`, `supportsThinkingTiers`, `extractThinkingTierFromModel`
- Depends on: `src/plugin/transform/types.ts`
- Used by: `src/plugin/request.ts`

**Multi-Account Management:**
- Purpose: Track per-account OAuth state, rate-limit cooldowns, quota cache, fingerprints, and daily request usage; select the best account for each request; detect and repair auth storage drift; track session metrics and request rate estimation
- Location: `src/plugin/accounts.ts`, `src/plugin/storage.ts`, `src/plugin/rotation.ts`, `src/plugin/fingerprint.ts`, `src/plugin/auth-doctor.ts`, `src/plugin/auth-drift.ts`
- Contains: `AccountManager`, `HealthScoreTracker`, `TokenBucketTracker`, `selectHybridAccount`, `generateFingerprint`, `buildFingerprintHeaders`, `FingerprintVersion` history (max 5), account storage version 4 support with migration, secure POSIX permissions, `detectAuthStorageDrift`, `createAuthDoctorReport`, self-healing repairs, per-family daily request tracking, and in-memory session summaries with hourly rate calculations
- Depends on: `src/plugin/auth.ts`, `src/plugin/quota.ts`, `proper-lockfile`, `xdg-basedir`
- Used by: `src/plugin.ts`

**Token Refresh Queue:**
- Purpose: Background proactive OAuth token refresh so requests never block on expiry
- Location: `src/plugin/refresh-queue.ts`
- Contains: `ProactiveRefreshQueue`, `createProactiveRefreshQueue`
- Depends on: `src/plugin/accounts.ts`, `src/plugin/token.ts`
- Used by: `src/plugin.ts`

**Quota:**
- Purpose: Query Antigravity API for per-account quota usage; populate quota cache used by AccountManager for soft-quota gating; fetch Antigravity and Gemini CLI quotas in parallel; handle sequential endpoint fallback; track per-model quota data; manage stale-cache fail-open scenarios
- Location: `src/plugin/quota.ts`
- Contains: `checkAccountsQuota`, `QuotaGroup`, `QuotaGroupSummary`, `fetchGeminiCliQuota`, parallel fetches, wider model matching (gemini-3.5-*, gemini-3.1-*, gemini-2.5-*), `gpt-oss` quota group tracking, sequential endpoint fallbacks across `ANTIGRAVITY_ENDPOINT_FALLBACKS`, per-model quota tracking (`cachedPerModelQuota`), stale-cache fail-open (treating 0% quota as `READY` when reset time is past or missing), and paywall detection (`(unavailable)` status)
- Depends on: OAuth token utilities, `src/plugin/model-registry.ts`
- Used by: `src/plugin.ts` (async background refresh), `src/plugin/accounts.ts`

**Session Recovery:**
- Purpose: Detect interrupted tool executions (`tool_result_missing`) and malformed thinking blocks; inject synthetic completions to restore session
- Location: `src/plugin/recovery/` (`index.ts`, `types.ts`, `constants.ts`, `storage.ts`), `src/plugin/thinking-recovery.ts`
- Contains: `createSessionRecoveryHook`, `isRecoverableError`, `handleSessionRecovery`, `analyzeConversationState`, `closeToolLoopForThinking`
- Depends on: OpenCode session client API
- Used by: `src/plugin.ts` event handler

**Signature Cache:**
- Purpose: Persist and recall Claude thinking-block signatures across requests and restarts when `keep_thinking` is enabled
- Location: `src/plugin/cache/` (`index.ts`, `signature-cache.ts`), `src/plugin/stores/signature-store.ts`
- Contains: `SignatureCache`, `createSignatureCache`, `defaultSignatureStore`
- Depends on: `src/plugin/config/`
- Used by: `src/plugin/request.ts`

**Streaming Core:**
- Purpose: Transform SSE stream payloads line-by-line; cache signatures; inject debug annotations
- Location: `src/plugin/core/streaming/` (`transformer.ts`, `types.ts`, `index.ts`)
- Contains: `createStreamingTransformer`, `transformSseLine`, `transformStreamingPayload`, and `onUsageMetadata` callback to extract usage stats and log cache hit-rate at stream completion
- Depends on: `src/plugin/stores/signature-store.ts`
- Used by: `src/plugin/request.ts`

**Configuration:**
- Purpose: Load, merge, and validate plugin configuration from files and environment variables
- Location: `src/plugin/config/` (`schema.ts`, `loader.ts`, `models.ts`, `updater.ts`, `index.ts`)
- Contains: `AntigravityConfigSchema`, `loadConfig`, `initRuntimeConfig`, `AntigravityConfig`, settings for `thinking_warmup`, `max_account_switches`, `quota_style_fallback`
- Depends on: `zod`
- Used by: `src/plugin.ts`, most `src/plugin/` modules via `getKeepThinking()` etc.

**Auto-Update Checker Hook:**
- Purpose: On `session.created`, check npm for a newer plugin version and optionally auto-update the pinned version in `opencode.json`
- Location: `src/hooks/auto-update-checker/` (`index.ts`, `checker.ts`, `cache.ts`, `logging.ts`, `constants.ts`, `types.ts`)
- Contains: `createAutoUpdateCheckerHook`, `getLatestVersion`, `updatePinnedVersion`
- Depends on: npm registry HTTP, OpenCode TUI toast API
- Used by: `src/plugin.ts`

**Google Search Tool:**
- Purpose: Expose a `google_search` OpenCode tool that runs separate Antigravity API calls with native grounding tools
- Location: `src/plugin/search.ts`
- Contains: `executeSearch`
- Depends on: `src/constants.ts`, `src/plugin/logger.ts`
- Used by: `src/plugin.ts` (registers tool via `@opencode-ai/plugin` `tool()`)

**Logging / Debug:**
- Purpose: Structured per-module logger with TUI integration; detailed debug file logging for request/response inspection
- Location: `src/plugin/logger.ts`, `src/plugin/debug.ts`, `src/plugin/logging-utils.ts`
- Contains: `createLogger`, `initLogger`, `initializeDebug`, `isDebugEnabled`, `logAntigravityDebugResponse`
- Depends on: OpenCode TUI client
- Used by: All modules

**Errors:**
- Purpose: Domain-specific error classes with metadata
- Location: `src/plugin/errors.ts`
- Contains: `EmptyResponseError`, and other typed error classes
- Depends on: nothing
- Used by: `src/plugin.ts`, `src/plugin/request.ts`

**CLI / UI:**
- Purpose: Interactive terminal prompts for login, account selection, project ID entry, per-model availability, and aggregate quota health display
- Location: `src/plugin/cli.ts`, `src/plugin/ui/` (`auth-menu.ts`, `ansi.ts`, `confirm.ts`, `select.ts`, `model-status.ts`, `quota-status.ts`)
- Contains: `promptLoginMode`, `promptAddAnotherAccount`, `promptProjectId`, `showAuthMenu` with two-line layout and status/availability breakdown per model group, `getModelStatusFromAccounts`, `formatQuotaStatusBadge`, `classifyGroupStatus` with stale-cache fail-open, and `buildModelBreakdown` showing available/exhausted model counts
- Depends on: Node.js readline
- Used by: `src/plugin.ts` auth flow

---

## Data Flow

**Request Transform Pipeline:**
1. OpenCode calls plugin `loader()` with the original request — `src/plugin.ts`
2. `isGenerativeLanguageRequest()` confirms the URL matches — `src/plugin/request.ts`
3. `AccountManager.selectAccount()` picks the best OAuth account — `src/plugin/accounts.ts`
4. `resolveModelWithTier()` maps model name → Antigravity model ID + header style — `src/plugin/transform/model-resolver.ts`
5. `prepareAntigravityRequest()` cleans schema, strips thinking blocks for Claude, injects tool-hardening, and appends Claude thinking hints in a strict stable ordering (original prompt → tool hardening → thinking hint) to maximize prompt cache hits — `src/plugin/request.ts`, `src/plugin/request-helpers.ts`
6. `buildFingerprintHeaders()` attaches per-account device fingerprint — `src/plugin/fingerprint.ts`
7. `fetch()` is called against Antigravity endpoint with Bearer token — `src/plugin.ts`
8. `accountManager.recordRequest()` tracks daily request usage per account and updates in-memory session request counts for rate consumption estimation — `src/plugin.ts`, `src/plugin/accounts.ts`
9. `transformAntigravityResponse()` converts SSE stream back to Gemini API format — `src/plugin/request.ts`
10. Streaming transformer processes each SSE line, caches signatures, injects debug annotations, and fires `onUsageMetadata` callback to log cache hit statistics upon stream termination — `src/plugin/core/streaming/`

**Rate-Limit Retry Loop:**
1. 429 / 503 response received — `src/plugin.ts`
2. `parseRateLimitReason()` classifies the error — `src/plugin/accounts.ts`
3. `getRateLimitBackoff()` computes exponential delay with deduplication — `src/plugin.ts`
4. `AccountManager.markRateLimited()` records cooldown — `src/plugin/accounts.ts`
5. If other accounts available, `selectAccount()` switches — `src/plugin/accounts.ts`
6. Loop retries until success or `max_rate_limit_wait_seconds` exceeded

**OAuth Login Flow:**
1. `auth.login()` invoked by OpenCode host — `src/plugin.ts`
2. `authorizeAntigravity()` generates authorization URL — `src/antigravity/oauth.ts`
3. Local HTTP listener or manual URL paste captures callback — `src/plugin/server.ts`
4. `exchangeAntigravity()` exchanges code → tokens — `src/antigravity/oauth.ts`
5. `persistAccountPool()` merges into `antigravity-accounts.json` — `src/plugin.ts`, `src/plugin/storage.ts`

**Session Recovery:**
1. `session.error` event fires — `src/plugin.ts` event handler
2. `isRecoverableError()` checks error type — `src/plugin/recovery/`
3. `handleSessionRecovery()` injects synthetic `tool_result` blocks — `src/plugin/recovery/`
4. If `auto_resume`, plugin sends a "continue" prompt via `client.session.prompt()` — `src/plugin.ts`

**Quota Tracking & Refresh Flow:**
1. Background refresh or user-triggered update invokes `checkAccountsQuota()` — `src/plugin.ts`
2. `fetchAvailableModels()` and `fetchGeminiCliQuota()` query endpoints sequentially across `ANTIGRAVITY_ENDPOINT_FALLBACKS` — `src/plugin/quota.ts`
3. Quota responses map to group-level (`cachedQuota`) and model-level (`cachedPerModelQuota`) summaries — `src/plugin/quota.ts`
4. Active storage persists the updated summaries — `src/plugin/storage.ts`
5. The terminal UI `showAuthMenu()` displays the status, treating stale cache values (0% remaining without a future reset time or reset time in the past) as `READY` (fail-open) and displaying paywalled Pro models as `(unavailable)` — `src/plugin/ui/auth-menu.ts`, `src/plugin/ui/quota-status.ts`

---

## Key Abstractions

**`AccountManager`:**
- Purpose: Single source of truth for all OAuth accounts, their cooldowns, health scores, quota caches, fingerprints, and daily/session request metrics
- Location: `src/plugin/accounts.ts`
- Pattern: Stateful class with selection algorithms (`sticky`, `round-robin`, `hybrid`) delegating to `HealthScoreTracker` and `TokenBucketTracker`; tracks in-memory session stats and persists daily request counters on disk

**`AntigravityConfig` / `AntigravityConfigSchema`:**
- Purpose: Zod-validated runtime configuration with environment variable overrides
- Location: `src/plugin/config/schema.ts`, `src/plugin/config/loader.ts`
- Pattern: Zod schema → `z.infer<>` type, merged from project file + user file + env vars

**`HeaderStyle`:**
- Purpose: Discriminate between `antigravity` (Electron UA) and `gemini-cli` (nodejs UA) request paths
- Location: `src/constants.ts`, `src/plugin/transform/model-resolver.ts`
- Pattern: String literal union; resolved per model name suffix (`:antigravity` vs no suffix)

**`ModelFamily`:**
- Purpose: Route model-specific logic (`claude` vs `gemini`)
- Location: `src/plugin/storage.ts` (type), `src/plugin/transform/model-resolver.ts`
- Pattern: Discriminated string union used by `AccountManager`, `quota.ts`, and rate-limit key construction

**`ModelQuotaGroup`:**
- Purpose: Partition available models into four quota tracking groups (`claude`, `gemini-pro`, `gemini-flash`, and `gpt-oss`)
- Location: `src/plugin/model-registry.ts` (type), `src/plugin/quota.ts` (tracking)
- Pattern: String literal union mapping physical model IDs to logical quota partitions, allowing parallel quota fetching, aggregated health reporting, and granular per-model status rendering (`cachedPerModelQuota` tracks individual models)

**`AuthDoctor`:**
- Purpose: Diagnose and self-heal storage inconsistencies and active credentials drift
- Location: `src/plugin/auth-doctor.ts`, `src/plugin/auth-drift.ts`
- Pattern: Diagnostic functional reporting (`createAuthDoctorReport`) that identifies severity findings and suggests/applies target repairs (e.g., restoring active accounts, clamping indices)

**`SignatureStore` / `SignatureCache`:**
- Purpose: Cache Claude thinking-block signatures in memory and optionally on disk, keyed by session
- Location: `src/plugin/core/streaming/types.ts`, `src/plugin/cache/signature-cache.ts`, `src/plugin/stores/signature-store.ts`
- Pattern: Map-based store with TTL; disk layer uses JSON file with background flush interval

---

## Entry Points

**Plugin Factory:**
- Location: `src/plugin.ts` → `createAntigravityPlugin(providerId)`
- Triggers: OpenCode loads `index.ts` which imports and calls `createAntigravityPlugin("google")`
- Responsibilities: Initialize all subsystems, register auth methods, return `PluginResult` with `loader`, `auth`, `event`, and `tool` surfaces

**Root Index:**
- Location: `index.ts`
- Triggers: OpenCode plugin host imports the package
- Responsibilities: Re-export `createAntigravityPlugin` as the package entry

**Auto-Update Hook:**
- Location: `src/hooks/auto-update-checker/index.ts`
- Triggers: `session.created` event
- Responsibilities: Compare current vs latest npm version; update `opencode.json` pin if auto-update enabled

---

## Error Handling

**Strategy:** Defensive try/catch with graceful degradation — fallback values rather than crashes. Rate-limit and quota errors trigger account rotation, not failure. Session errors trigger recovery injection. Empty responses retry up to `empty_response_max_attempts` times before returning a synthetic error response. Token refresh failures throw typed `AntigravityTokenRefreshError`. Unknown errors are caught, logged, and surfaced as domain errors to callers. Capacity rate-limits (503/429) trigger a device fingerprint regeneration after 1 attempt per endpoint fallback.

---

## Cross-Cutting Concerns

**Logging:** `createLogger("module-name")` from `src/plugin/logger.ts` for structured per-module logging with dual sinks: TUI log panel (`debug_tui`) and debug file (`debug`). Per-message API request counters track request volumes for diagnostic visibility. Post-request logging outputs cached remaining quota percentages, session request rates (average requests per hour), and cache hit/miss statistics (HIT, MISS, WRITE status and hit rate percentage) computed from response usage metadata. `console.log` only in CLI / interactive auth flows.

**Caching:** In-memory signature store for thinking blocks; optional disk persistence via `SignatureCache` when `keep_thinking` is enabled. Auth tokens cached per-account in `AccountManager`. Quota data cached per-account with configurable TTL and background parallel refreshes. Prompt caching utilizes a strict prefix-stabilization ordering (stable system instructions first, dynamic content last) to maximize gateway-level cache hits.

**Storage:** Accounts persisted to `antigravity-accounts.json` (XDG data dir) via `src/plugin/storage.ts` with `proper-lockfile` for concurrent-write safety. Current format is version 4, featuring automatic migration from older versions (v1, v2, v3), secure POSIX permissions (0600), and legacy Windows path migration. Persists per-account daily request counters (`dailyRequestCounts`) and per-model granular quota data (`cachedPerModelQuota`). Config loaded from `.opencode/antigravity.json` (project) and `~/.config/opencode/antigravity.json` (user).

**Configuration:** Two-level config file hierarchy (project overrides user) plus environment variable overrides. All config is read once at startup via `loadConfig()` and made available globally via `initRuntimeConfig()` and module-level getters. Config supports quota fallback disabling via `quota_style_fallback: false`, switches limit via `max_account_switches: 2`, and thinking warmup option `thinking_warmup: false`.
