# Codebase Structure

## Directory Layout

```
opencode-antigravity-auth/
├── src/                          # All TypeScript source code
│   ├── plugin.ts                 # Main entry: createAntigravityPlugin factory
│   ├── constants.ts              # Endpoints, headers, OAuth constants, prompts
│   ├── shims.d.ts                # Ambient type shims
│   ├── antigravity/              # Google OAuth exchange layer
│   │   └── oauth.ts              # authorize / exchange / token types
│   ├── hooks/                    # OpenCode lifecycle hooks
│   │   └── auto-update-checker/  # Background npm update check + auto-pin
│   └── plugin/                   # Core plugin subsystems
│       ├── accounts.ts           # AccountManager: selection, rotation, cooldowns, request counter and session metrics
│       ├── auth-doctor.ts        # Self-healing diagnostics for auth storage drift
│       ├── auth-drift.ts         # Detection of drift between active auth and storage
│       ├── auth.ts               # Token validation, refresh-parts parsing
│       ├── cache.ts              # Thin re-export of cache/ module
│       ├── cli.ts                # Interactive terminal prompts (login, project ID)
│       ├── debug.ts              # Debug file logging: request/response dumps
│       ├── errors.ts             # Domain error classes (EmptyResponseError, etc.)
│       ├── fingerprint.ts        # Per-account device fingerprint generation
│       ├── image-saver.ts        # Save Gemini image-generation output to disk
│       ├── logger.ts             # Structured logger with TUI + file sinks
│       ├── logging-utils.ts      # ANSI helpers, console write utilities
│       ├── model-registry.ts     # Centralized model specifications and quota groups
│       ├── project.ts            # Managed project context resolution
│       ├── quota.ts              # Quota API queries; QuotaGroup types, endpoint fallbacks and per-model tracking
│       ├── recovery.ts           # Thin re-export / error-type detection helpers
│       ├── refresh-queue.ts      # Proactive background OAuth token refresh
│       ├── request.ts            # Core request transform & response transform
│       ├── request-helpers.ts    # Schema cleaning, thinking filters, tool helpers
│       ├── rotation.ts           # HealthScoreTracker, TokenBucketTracker, hybrid selection
│       ├── search.ts             # Google Search grounding tool (executeSearch)
│       ├── server.ts             # Local OAuth callback HTTP listener
│       ├── storage.ts            # Zod schemas for antigravity-accounts.json, file I/O, and daily request counters
│       ├── thinking-recovery.ts  # Turn-boundary detection, thinking block repair
│       ├── token.ts              # refreshAccessToken, AntigravityTokenRefreshError
│       ├── types.ts              # Shared plugin interfaces (PluginResult, AuthDetails, …)
│       ├── version.ts            # Runtime Antigravity version fetch + setter
│       ├── cache/                # Signature cache subsystem
│       │   ├── index.ts          # Public exports (SignatureCache, createSignatureCache)
│       │   └── signature-cache.ts # In-memory + disk cache for Claude thinking signatures
│       ├── config/               # Config loading and schema
│       │   ├── index.ts          # Public exports (loadConfig, initRuntimeConfig, …)
│       │   ├── loader.ts         # File + env merge logic
│       │   ├── models.ts         # Model-specific config helpers
│       │   ├── schema.ts         # AntigravityConfigSchema (Zod), DEFAULT_CONFIG
│       │   └── updater.ts        # Config file writer (auto-update pin)
│       ├── core/                 # Low-level streaming primitives
│       │   └── streaming/
│       │       ├── index.ts      # Public exports
│       │       ├── transformer.ts # SSE line transformer, signature caching, and usage metadata tracking
│       │       └── types.ts      # SignatureStore, StreamingCallbacks, StreamingOptions, and StreamingUsageMetadata
│       ├── recovery/             # Session recovery subsystem
│       │   ├── index.ts          # Public exports + createSessionRecoveryHook
│       │   ├── constants.ts      # Recovery error strings
│       │   ├── storage.ts        # Recovery state persistence helpers
│       │   └── types.ts          # Recovery types
│       ├── stores/               # Shared in-memory stores
│       │   └── signature-store.ts # defaultSignatureStore singleton
│       ├── transform/            # Model-specific request/response transforms
│       │   ├── index.ts          # Barrel re-export of all transform functions
│       │   ├── types.ts          # TransformContext, ResolvedModel, ThinkingConfig, etc.
│       │   ├── model-resolver.ts # resolveModelWithTier/Variant; MODEL_ALIASES
│       │   ├── claude.ts         # Claude thinking config, tool-hardening, token limits
│       │   ├── gemini.ts         # Gemini 3/2.5 thinking config, image generation
│       │   └── cross-model-sanitizer.ts # Strip incompatible fields when switching models
│       └── ui/                   # Terminal UI primitives
│           ├── ansi.ts           # ANSI colour helpers
│           ├── auth-menu.ts      # Multi-account auth menu with tier separators and breakdowns showing model availability
│           ├── confirm.ts        # Y/n prompt
│           ├── model-status.ts   # Per-model status aggregation across accounts
│           ├── quota-status.ts   # Quota status labels, stale cache fail-open logic, and ANSI badge formatting
│           └── select.ts         # Arrow-key selection list
├── docs/                         # Additional documentation
│   ├── ARCHITECTURE.md           # Detailed architecture (this repo also has root ARCHITECTURE.md)
│   └── ANTIGRAVITY_API_SPEC.md   # Antigravity API wire-format reference
├── scripts/                      # Build/release helper scripts
├── script/                       # Additional utility scripts
├── assets/                       # Static assets
├── logs/                         # Runtime debug log output (gitignored)
├── index.ts                      # Package entry point (re-exports plugin factory)
├── package.json                  # Dependencies and npm scripts
├── tsconfig.json                 # Base TypeScript config
├── tsconfig.build.json           # Build-only TypeScript config (excludes tests)
├── vitest.config.ts              # Test runner configuration
├── README.md                     # Installation and usage guide
├── CHANGELOG.md                  # Version history
└── AGENTS.md                     # AI agent guidance (build commands, conventions)
```

---

## Directory Purposes

**`src/`:**
- Purpose: All production TypeScript source
- Contains: Plugin factory, OAuth layer, request transform pipeline, account management, config, recovery hooks
- Key files: `src/plugin.ts` (orchestrator), `src/constants.ts` (all magic values)

**`src/antigravity/`:**
- Purpose: Google OAuth exchange — authorize URL generation and authorization-code exchange
- Contains: `oauth.ts`
- Key files: `src/antigravity/oauth.ts`

**`src/hooks/auto-update-checker/`:**
- Purpose: Self-contained hook that checks npm for new plugin versions on `session.created`
- Contains: checker, cache, logging, constants, types, index
- Key files: `src/hooks/auto-update-checker/index.ts` (public API), `src/hooks/auto-update-checker/checker.ts` (npm fetch + version compare)

**`src/plugin/`:**
- Purpose: All core plugin subsystems — auth, request transform, account management, recovery, config, logging
- Contains: ~35 TypeScript modules + 7 subdirectories
- Key files: `src/plugin/accounts.ts`, `src/plugin/request.ts`, `src/plugin/storage.ts`, `src/plugin/types.ts`

**`src/plugin/transform/`:**
- Purpose: Model-resolution and per-model payload transforms (Claude, Gemini, cross-model sanitizer)
- Contains: `model-resolver.ts`, `claude.ts`, `gemini.ts`, `cross-model-sanitizer.ts`, `types.ts`, `index.ts`
- Key files: `src/plugin/transform/model-resolver.ts` (resolves model name to header style + model ID)

**`src/plugin/config/`:**
- Purpose: Load, validate, and expose runtime configuration
- Contains: Zod schema, file loader, model config helpers, config file updater
- Key files: `src/plugin/config/schema.ts` (full schema with env var docs), `src/plugin/config/loader.ts`

**`src/plugin/recovery/`:**
- Purpose: Session recovery from interrupted tool calls and broken thinking blocks
- Contains: `createSessionRecoveryHook`, error-type constants, session-state storage, types
- Key files: `src/plugin/recovery/index.ts` (public API)

**`src/plugin/cache/`:**
- Purpose: Disk-backed cache for Claude thinking-block signatures (used when `keep_thinking: true`)
- Contains: `SignatureCache` class, public exports
- Key files: `src/plugin/cache/signature-cache.ts`

**`src/plugin/core/streaming/`:**
- Purpose: Low-level SSE stream transformer used by `request.ts`
- Contains: `createStreamingTransformer`, `transformSseLine`, interface types
- Key files: `src/plugin/core/streaming/transformer.ts`

**`src/plugin/stores/`:**
- Purpose: Shared singleton in-memory stores
- Contains: `defaultSignatureStore` (in-memory `SignatureStore` singleton)
- Key files: `src/plugin/stores/signature-store.ts`

**`src/plugin/ui/`:**
- Purpose: Terminal UI primitives for the interactive OAuth login flow and status breakdowns
- Contains: ANSI helpers, multi-account auth menu, confirm and select prompts, per-model and quota status aggregates
- Key files: `src/plugin/ui/auth-menu.ts`, `src/plugin/ui/model-status.ts`, `src/plugin/ui/quota-status.ts`

**`docs/`:**
- Purpose: Supplementary documentation beyond the root README
- Contains: `ARCHITECTURE.md` (detailed design), `ANTIGRAVITY_API_SPEC.md` (API wire format)

---

## Key File Locations

**Entry Point:** `index.ts` — re-exports `createAntigravityPlugin` as the npm package entry
**Plugin Orchestrator:** `src/plugin.ts` — main plugin factory with all auth and request logic
**Constants:** `src/constants.ts` — all endpoints, headers, OAuth IDs, system prompts, tool constants
**Config Schema:** `src/plugin/config/schema.ts` — full `AntigravityConfigSchema` with field docs
**Config Loader:** `src/plugin/config/loader.ts` — merges project file + user file + env vars
**Account Store:** `src/plugin/storage.ts` — Zod schemas for `antigravity-accounts.json` (version 4 and daily request counter schemas); `loadAccounts`/`saveAccounts`
**Account Manager:** `src/plugin/accounts.ts` — `AccountManager` class; `selectHybridAccount`; `parseRateLimitReason`; request counting and session diagnostics
**Request Transform:** `src/plugin/request.ts` — `prepareAntigravityRequest`, `transformAntigravityResponse`
**Model Resolution:** `src/plugin/transform/model-resolver.ts` — `resolveModelWithTier`, `MODEL_ALIASES`
**Types:** `src/plugin/types.ts` — `PluginResult`, `AuthDetails`, `PluginContext`, `OAuthAuthDetails`
**Tests:** `src/plugin/*.test.ts`, `src/plugin/transform/*.test.ts`, `src/hooks/**/*.test.ts` — co-located with source

---

## Naming Conventions

**Files:** `kebab-case.ts` — e.g., `request-helpers.ts`, `thinking-recovery.ts`, `cross-model-sanitizer.ts`
**Test files:** `*.test.ts` co-located with source — e.g., `src/plugin/auth.test.ts` next to `src/plugin/auth.ts`
**Directories:** `kebab-case/` — e.g., `auto-update-checker/`, `cross-model-sanitizer` (file not dir)
**Types/Interfaces:** `PascalCase` — e.g., `AccountManager`, `AntigravityConfig`, `HealthScoreTracker`
**Functions:** `camelCase` — e.g., `resolveModelWithTier`, `buildFingerprintHeaders`
**Constants:** `UPPER_SNAKE_CASE` — e.g., `ANTIGRAVITY_ENDPOINT_PROD`, `MAX_WARMUP_SESSIONS`
**Zod schemas:** `PascalCase` + `Schema` suffix — e.g., `AntigravityConfigSchema`, `SignatureCacheConfigSchema`

---

## Where to Add New Code

**New request transform feature:** `src/plugin/request-helpers.ts` — add helper functions, import in `src/plugin/request.ts`

**New model support:** `src/plugin/model-registry.ts` — register model specifications in `PUBLIC_MODEL_DEFINITIONS` and alias mapping in `MODEL_ALIASES`; add per-model logic in `src/plugin/transform/claude.ts` or `src/plugin/transform/gemini.ts`

**New config option:** `src/plugin/config/schema.ts` — add Zod field with default and JSDoc; update `DEFAULT_CONFIG`; add getter in `src/plugin/config/index.ts` if needed

**New account selection strategy:** `src/plugin/accounts.ts` — extend `AccountSelectionStrategy` union; add branch in `AccountManager.selectAccount()`

**New OpenCode hook:** `src/hooks/[hook-name]/` — follow `auto-update-checker/` structure with `index.ts`, `types.ts`, `constants.ts`

**New OpenCode tool:** `src/plugin/search.ts` pattern — implement `executeSearch`-style function, register via `tool()` in `src/plugin.ts`

**New recovery type:** `src/plugin/recovery/constants.ts` — add error string; extend `src/plugin/recovery/types.ts`; handle in `src/plugin/recovery/index.ts`

**New UI prompt:** `src/plugin/ui/` — add `.ts` file following `confirm.ts` or `select.ts` pattern

**Shared utilities:** `src/plugin/logging-utils.ts` (logging), `src/plugin/debug.ts` (debug output)

**Tests:** Co-locate as `src/plugin/[module].test.ts` — use Vitest `describe`/`it`/`expect`; mock with `vi.fn()`, `vi.mock()`
