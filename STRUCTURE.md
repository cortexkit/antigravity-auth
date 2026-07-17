# Codebase Structure

## Directory Layout

```
antigravity-auth/
├── packages/
│   ├── core/                     # Harness-agnostic core logic
│   ├── opencode/                 # OpenCode integration plugin wrapper
│   └── pi/                       # Pi coding agent extension wrapper
├── scripts/                      # Build and release utility scripts
└── package.json                  # Root monorepo configuration
```

## Directory Purposes

**`packages/core`:**
- Purpose: Provides harness-agnostic utilities for Google Antigravity integrations.
- Contains: Direct TCP/TLS socket transport, Google OAuth PKCE auth flow, Google Cloud project bootstrapping, Claude and Gemini request/response transforms, device fingerprint generators, and centralized model registries.
- Key files: `packages/core/src/agy-transport.ts` (TCP/TLS socket), `packages/core/src/project.ts` (project resolution), `packages/core/src/transform/model-resolver.ts` (model mapping).

**`packages/opencode`:**
- Purpose: Integrates the Antigravity authentication and request transformation logic into the OpenCode host environment.
- Contains: Fetch interceptors, account managers, interactive CLI authorization menus, signature caching, and session error recovery hooks.
- Key files: `packages/opencode/src/plugin.ts` (main orchestrator), `packages/opencode/src/plugin/accounts.ts` (AccountManager), `packages/opencode/src/plugin/config/schema.ts` (Zod schema).

**`packages/pi`:**
- Purpose: Bridges the Antigravity core library into the Pi coding agent environment as a custom provider extension.
- Contains: Pi-compatible authorization flow handlers and streaming translators.
- Key files: `packages/pi/src/index.ts` (provider setup), `packages/pi/src/stream.ts` (stream mapping).

## Key File Locations

**Entry Points:**
- `packages/core/src/index.ts`: Harness-agnostic library exports.
- `packages/opencode/index.ts`: OpenCode plugin package entry.
- `packages/pi/src/index.ts`: Pi extension provider entry.

**Configuration:**
- `packages/opencode/src/plugin/config/schema.ts`: OpenCode Zod runtime configuration schema.

**Core Logic:**
- `packages/core/src/agy-transport.ts`: Custom TCP/TLS transport socket implementation.
- `packages/core/src/project.ts`: Project resolution, context loading, and GCP project provisioning.
- `packages/core/src/transform/cross-model-sanitizer.ts`: Payload cleanup when switching model families.
- `packages/opencode/src/plugin/accounts.ts`: Multi-account selection, rotation, metrics, and health scores.

**Tests:**
- `packages/core/src/**/*.test.ts`: Unit tests for core transport, models, and transforms.
- `packages/opencode/src/**/*.test.ts`: OpenCode account manager, UI elements, and config validations.
- `packages/pi/src/**/*.test.ts`: Pi converters and cache helpers.

## Naming Conventions

**Files:** `kebab-case.ts` — e.g., `model-resolver.ts`
**Directories:** `kebab-case/` — e.g., `auto-update-checker/`
**Types/Interfaces:** `PascalCase` — e.g., `AccountManager`, `AntigravityConfig`
**Functions:** `camelCase` — e.g., `resolveModelWithTier`
**Constants:** `UPPER_SNAKE_CASE` — e.g., `ANTIGRAVITY_ENDPOINT`

## Where to Add New Code

**New shared core logic / transport rule:** `packages/core/src/` — create helper module or edit existing transport/auth managers.
**New model transform / payload filter:** `packages/core/src/transform/` — add custom Claude or Gemini schema conversion rules.
**New OpenCode lifecycle hook:** `packages/opencode/src/hooks/[hook-name]/` — register in `packages/opencode/src/plugin.ts`.
**New OpenCode plugin configuration field:** `packages/opencode/src/plugin/config/schema.ts` — extend `AntigravityConfigSchema`.
**New Pi stream handler / message converter:** `packages/pi/src/` — adjust converters in `convert.ts` or mapping logic in `stream.ts`.
**Tests:** Co-locate unit and regression tests alongside code using `*.test.ts`.
