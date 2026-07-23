# Architecture

## Pattern Overview

**Overall:** Monorepo architecture with a harness-agnostic core & host-specific integration plugins.

**Key Characteristics:**
- **Shared Agnostic Core:** Consolidates all wire formats, OAuth code exchanges, model configurations, project context resolutions, and Claude/Gemini-specific transformations into the `@cortexkit/antigravity-auth-core` package.
- **Interception & Extraction:** Translates host-specific formats (e.g. Gemini, Claude) into Google Cloud Code Assist (Antigravity) API envelopes, intercepts network transport levels, and parses downstream SSE response streams to strip metadata and recover signatures.
- **TCP/TLS Raw Socket Transport:** Outbounds all Antigravity API requests via custom raw TLS sockets (`packages/core/src/agy-transport.ts`) supporting SSL connection racing and corporate HTTP proxy tunneling, bypassing default fetch agents.
- **Multi-Account State & Cooldowns:** Manages account rotation, rate-limit backoffs (with jitter), token refresh queues, session-scoped account pinning, and secure POSIX permissions within the OpenCode wrapper.

## Layers

**Host Integration Layer (Wrappers):**
- Purpose: Registers integration points and config/event bindings into target execution environments.
- Location: `packages/opencode/` and `packages/pi/`
- Contains: Main plugin interfaces, lifecycle hook listeners, interactive UI menus, and Pi-specific streaming adapters.
- Depends on: `@cortexkit/antigravity-auth-core` and target client environments (`@opencode-ai/plugin`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`).
- Used by: OpenCode editor host and Pi agent runner.

**Multi-Account Management:**
- Purpose: Rotates OAuth accounts, tracks cooldowns, caches remaining quotas, builds device fingerprints, and monitors storage health.
- Location: `packages/opencode/src/plugin/accounts.ts`, `packages/opencode/src/plugin/rotation.ts`, `packages/opencode/src/plugin/session-context.ts`, `packages/opencode/src/plugin/fingerprint.ts`, `packages/opencode/src/plugin/auth-doctor.ts`
- Contains: `AccountManager`, `HealthScoreTracker`, `TokenBucketTracker`, fingerprint generation algorithms, self-healing diagnostic tasks, and daily request tracking counters.
- Depends on: `@cortexkit/antigravity-auth-core` (for fingerprints, request metadata, auth types, and models).
- Used by: OpenCode plugin orchestrator (`packages/opencode/src/plugin.ts`).

**Core Authentication & Project Context:**
- Purpose: Handles Google OAuth flow redirection, PKCE code exchanges, token refreshes, and dynamic GCP project context lookup or provisioning.
- Location: `packages/core/src/antigravity/oauth.ts`, `packages/core/src/auth.ts`, `packages/core/src/project.ts`
- Contains: `authorizeAntigravity`, `exchangeAntigravity`, `refreshAntigravityToken`, `ensureProjectContext`, `loadManagedProject`.
- Depends on: `@openauthjs/openauth`
- Used by: Account manager modules and Pi authentication hooks.

**Payload Transformation:**
- Purpose: Resolves client-supplied model names into logical Antigravity identifiers, injects tool description hardening rules, strips Claude thinking blocks, and sanitizes payload fields during model family swaps.
- Location: `packages/core/src/transform/` and `packages/core/src/model-registry.ts`
- Contains: `resolveModelWithTier`, `applyClaudeTransforms`, `applyGeminiTransforms`, `sanitizeCrossModelPayload`, `getGemini36FlashAntigravityModel`.
- Depends on: `packages/core/src/constants.ts`
- Used by: Host request interceptors and streaming parsers.

**Low-Level Socket Transport:**
- Purpose: Custom TCP/TLS socket transport for sending serialized HTTP requests directly to Google endpoints, bypassing proxy restrictions or system agents.
- Location: `packages/core/src/agy-transport.ts`
- Contains: `fetchWithAgyCliTransport`, SSL racing sockets, chunked decoding streams, and idle-timeout logic.
- Depends on: Node `net` and `tls` built-ins.
- Used by: Request pipelines, quota fetches, and project discovery.

## Data Flow

**OpenCode Interception and Request Transformation Pipeline:**

1. Host triggers `loader()` function with client request — `packages/opencode/src/plugin.ts`
2. `isGenerativeLanguageRequest()` checks if target URL corresponds to googleapis — `packages/opencode/src/plugin/request.ts`
3. `AccountManager.getCurrentOrNextForFamily()` selects and pins an eligible Google account using model quota, rate limits, and host session identity — `packages/opencode/src/plugin/accounts.ts`
4. `resolveModelWithTier()` converts user-facing model tag into Antigravity wire model ID — `packages/core/src/transform/model-resolver.ts`
5. `prepareAntigravityRequest()` sanitizes properties, strips Claude thinking, and appends Claude tool instructions in a strict prefix-stabilized order to optimize prompt caching — `packages/opencode/src/plugin/request.ts`
6. `buildFingerprintHeaders()` constructs the live-captured AGY CLI identity header — `packages/core/src/fingerprint.ts`
7. `fetchWithAgyCliTransport()` sends the raw bytes over direct/proxied TLS socket connection — `packages/core/src/agy-transport.ts`
8. `AccountManager.recordRequest()` registers request metrics and updates daily file counters — `packages/opencode/src/plugin/accounts.ts`
9. `transformAntigravityResponse()` translates the resulting stream back to the expected Gemini client format — `packages/opencode/src/plugin/request.ts`
10. Streaming transformer captures SSE tokens, caches signatures, and logs cache-hit rates via `onUsageMetadata` callback — `packages/opencode/src/plugin/core/streaming/transformer.ts`

**Pi Extension Stream Mapping:**

1. Extension triggers the `streamSimple` callback for model generation — `packages/pi/src/stream.ts`
2. Model parameters are mapped, and cached authorization details are fetched — `packages/pi/src/stream.ts`
3. `ensureProjectContext()` retrieves or provisions a Code Assist project ID — `packages/core/src/project.ts`
4. Payload details map to a standard Gemini request structure — `packages/pi/src/convert.ts`
5. SSE connection is initiated to the Antigravity daily endpoint via custom socket transport — `packages/core/src/agy-transport.ts`
6. Incoming chunks are unwrapped and parsed into Pi-compatible text and tool-call events — `packages/pi/src/stream.ts`

## Key Abstractions

**`AccountManager`:**
- Purpose: Stateful manager orchestrating Google accounts, token refreshes, health values, rate limit backoffs, and fingerprint history.
- Location: `packages/opencode/src/plugin/accounts.ts`
- Pattern: Selection state machine delegating to `HealthScoreTracker` and `TokenBucketTracker`.

**`AgyRequestSessionStore`:**
- Purpose: Keeps conversation and trajectory IDs stable per host session while deriving request step metadata from payload parts.
- Location: `packages/core/src/agy-request-metadata.ts`
- Pattern: Bounded session-context store shared by OpenCode and Pi; OpenCode hashes the workspace URI for its numeric session ID.

**`fetchWithAgyCliTransport`:**
- Purpose: Direct TCP/TLS streaming connection agent that replicates the official Google Cloud SDK/agy CLI networking behavior.
- Location: `packages/core/src/agy-transport.ts`
- Pattern: Raw socket read-write buffer stream with custom chunked-transfer decoding.

**`ModelResolver` (`resolveModelWithTier`):**
- Purpose: Maps external AI model tags (e.g. `claude-3-7-sonnet`, `gemini-3.6-flash`) into internal Google Antigravity identifiers, specifying thinking budgets and custom header styles.
- Location: `packages/core/src/transform/model-resolver.ts`
- Pattern: Regular expression and alias lookup maps backed by tiered route definitions in `packages/core/src/model-registry.ts`.

**`ensureProjectContext`:**
- Purpose: Automatically initializes, caches, and maintains valid Google Cloud project mappings for standard or enterprise accounts.
- Location: `packages/core/src/project.ts`
- Pattern: Async caching proxy with TTL checks and onboard fallback triggers.

**`Cross-Model Sanitizer`:**
- Purpose: Strips or converts metadata fields that would violate schema expectations when switching between Claude and Gemini model backends.
- Location: `packages/core/src/transform/cross-model-sanitizer.ts`
- Pattern: Recursive JSON tree pruning.

## Entry Points

**OpenCode Plugin Entry:**
- Location: `packages/opencode/index.ts`
- Triggers: OpenCode loading the package at host startup.
- Responsibilities: Exposes `createAntigravityPlugin` to initialize interceptors, UI CLI systems, and event channels.

**Pi Extension Entry:**
- Location: `packages/pi/src/index.ts`
- Triggers: Pi agent runtime loading extensions.
- Responsibilities: Registers the "Google Antigravity (CortexKit OAuth)" provider, login menus, credentials refresh hooks, and stream processors.

**Agnostic Core Entry:**
- Location: `packages/core/src/index.ts`
- Triggers: Sub-packages importing core libraries.
- Responsibilities: Exports all shared constants, transforms, transport mechanisms, and OAuth helper functions.

## Error Handling

**Strategy:** Fail closed with active fallback and self-healing. Intercepted request errors (like 429/503) trigger account cooldown penalties and rotate execution to a different account rather than throwing to the client. Storage corruption or auth drift is checked during boot via `AuthDoctor` and self-healed. Invalid or mismatched thinking signatures utilize the `SKIP_THOUGHT_SIGNATURE` sentinel to prevent server-side verification failures. Capacity limits automatically regenerate the device fingerprint history.

## Cross-Cutting Concerns

**Logging:** A unified `createLogger` wrapper maps log records to the OpenCode TUI interface or a file sink (`packages/core/src/logger.ts`). At stream end, request rates, cache hit rates (HIT, MISS, WRITE), and remaining account quota are logged.

**Caching:** Accounts and project identifiers are cached in memory (with TTL) and serialized to disk. Claude thinking block signatures are stored in memory and flushed to a signature cache on disk to persist across sessions (`packages/opencode/src/plugin/cache/signature-cache.ts`).

**Storage:** Account pools are persisted to `antigravity-accounts.json` under the OpenCode/XDG configuration directory using `proper-lockfile` to prevent parallel write conflicts. Sensitive files use mode 0600 and their directories use mode 0700.
