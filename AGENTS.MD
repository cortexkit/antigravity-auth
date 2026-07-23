# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

OpenCode plugin for Google Antigravity OAuth. Intercepts `fetch()` calls to `generativelanguage.googleapis.com`, transforms them to Antigravity format, and handles auth, quota, recovery, and multi-account rotation.

## Build & Test Commands

```bash
bun install                          # Install dependencies
bun run build                        # Compile (tsc -p tsconfig.build.json)
bun run typecheck                    # Type-check only (tsc --noEmit)
bun run test                         # Run all unit tests (bun test --isolate across packages)
bun test --isolate src/plugin/auth.test.ts            # Single test file
bun test --isolate -t "test name here"                # Single test by name (uses bun:test's -t filter)
bun test --isolate --watch src/plugin/auth.test.ts   # Watch mode, single file
bun run test:e2e                     # Deterministic e2e flows (mock Antigravity server, no network)
bun run test:e2e:models              # Live Antigravity model inventory (CI-gated, network)
bun run test:e2e:regression          # Cross-model + Gemini CLI regression (network)
bun run --cwd packages/opencode smoke:tui            # Pack-and-install smoke test for the TUI subpath
```

Format and lint via Biome:

```bash
bun run format                       # biome format --write .
bun run format:check                 # biome format .  (CI gate)
bun run lint                         # biome lint .     (CI gate)
```

Pre-commit hooks (`.lefthook.yml`) run Biome on changed `*.{ts,tsx,js,mjs,json,jsonc,yml,yaml}` files via `bunx biome check --staged --no-errors-on-unmatched`. The repo pins the toolchain in `mise.toml` (`bun = "1.3"`, `node = "24"`) and CI uses `oven-sh/setup-bun@v2` with `bun-version: 1.3`.

## TypeScript Configuration

- `strict: true` with extra strictness: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `target: ESNext`, `module: Preserve`, `moduleResolution: bundler`
- `allowImportingTsExtensions: true` — use `.ts` extensions in imports
- No path aliases — all imports are relative

## Code Style

### Imports
- Use `import type { ... }` for type-only imports (enforced by `verbatimModuleSyntax`)
- Named imports only — no default imports in src/
- Relative paths with `.ts` extensions: `import { foo } from "./bar.ts"`
- Order: node builtins > external packages > local modules

### Exports
- Named exports only in src/ — no default exports
- Barrel files (index.ts) for module surfaces

### Naming
- `camelCase` for functions, variables, parameters
- `PascalCase` for types, interfaces, classes, enums
- `UPPER_SNAKE_CASE` for constants
- `kebab-case` for file names (e.g., `request-helpers.ts`, `thinking-recovery.ts`)
- Test files: `*.test.ts` colocated with source

### Types
- No `I` prefix on interfaces, no `Type` suffix
- Use `z.infer<typeof Schema>` for Zod-derived types
- Extract to `types.ts` when shared, inline when local
- Discriminated unions preferred over boolean flags
- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`

### Functions
- `export function` for public APIs
- Arrow functions for callbacks, factories, and inline closures
- Async functions with targeted try/catch (not blanket)

### Error Handling
- Defensive try/catch with graceful degradation (fallback values, not crashes)
- Custom error classes with metadata when domain-specific
- Catch `unknown`, log, and convert to domain errors — never empty catch blocks
- Rate limit / quota errors trigger account rotation, not failure

### Formatting
- 2-space indentation
- Single quotes for strings (Biome `quoteStyle: single`)
- Trailing commas in multiline constructs
- No semicolons (project convention)

### Logging
- `createLogger("module-name")` for structured logging
- `console.log` only for CLI/user-facing output

## Module Structure

```
src/
├── plugin.ts                # Main entry, fetch interceptor
├── constants.ts             # Endpoints, headers, API config, system prompts
├── antigravity/oauth.ts     # OAuth token exchange
└── plugin/
    ├── auth.ts              # Token validation & refresh
    ├── request.ts           # Request transformation (core logic)
    ├── request-helpers.ts   # Schema cleaning, thinking filters
    ├── thinking-recovery.ts # Turn boundary detection
    ├── recovery.ts          # Session recovery (tool_result_missing)
    ├── quota.ts             # Quota checking (API usage stats)
    ├── cache.ts             # Auth & signature caching
    ├── accounts.ts          # Multi-account management & storage
    ├── storage.ts           # Persistent storage schemas (Zod)
    ├── fingerprint.ts       # Device fingerprint generation & headers
    ├── project.ts           # Managed project context resolution
    └── debug.ts             # Debug logging utilities
```

## Key Design Patterns

### 1. Request Interception
Plugin intercepts `fetch()` for `generativelanguage.googleapis.com`, transforms to Antigravity format. Two header styles: `antigravity` (Electron-style UA + fingerprint) and `gemini-cli` (nodejs-client UA).

### 2. Claude Thinking Blocks
ALL thinking blocks are stripped from outgoing requests for Claude models. Claude generates fresh thinking each turn. This eliminates signature validation errors.

### 3. Session Recovery
When tool execution is interrupted (ESC/timeout), the plugin injects synthetic `tool_result` blocks to recover the session without starting over.

### 4. Schema Sanitization
Tool schemas are cleaned via allowlist. Unsupported fields (`const`, `$ref`, `$defs`) are removed or converted to Antigravity-compatible format.

### 5. Multi-Account Load Balancing
Accounts rotate on rate limits. Gemini has dual quota pools (Antigravity headers + Gemini CLI headers). Fingerprints are per-account and regenerated on capacity exhaustion.

### 6. Fingerprint System
Per-account device fingerprints stored in `antigravity-accounts.json`. Each fingerprint includes deviceId, sessionToken, userAgent, and a reduced clientMetadata (ideType, platform, pluginType — no osVersion, arch, or sqmId). The only header composed is `User-Agent`, built by `buildFingerprintHeaders()` in `fingerprint.ts` and applied on the antigravity request path in `request.ts`. History tracked (max 5), restorable.

## Dependencies

- `zod ^4` — schema validation (NOT zod v3)
- `@opencode-ai/plugin` — OpenCode plugin interface
- `@openauthjs/openauth` — OAuth client
- `proper-lockfile` — file locking for concurrent access
- `xdg-basedir` — XDG directory resolution

## Testing

- Framework: **Bun's test runner** (`bun test`; the `bun:test` module re-exports a jest-compatible namespace)
- Config: no per-package config — Bun discovers `*.test.ts` next to source. The `bunfig.toml` at the root and in each workspace preloads `test/setup.ts` (env-isolation + a per-test mkdtemp root + a `globalThis.stubbed` / `unstubAllGlobals` / `freshImport` helper). The e2e workspace uses `bunfig.toml` `root = "./src"` so its tests stay isolated from the unit workspace.
- Tests colocated: `src/plugin/foo.test.ts` next to `src/plugin/foo.ts`. The e2e workspace uses `*.e2e.test.ts` so the root `bun run test` and `bun run test:e2e` selectors can target them precisely.
- Use `describe`/`it`/`expect` from `bun:test` — the standard API.
- Mock with `mock()`, `spyOn()`, and the `jest` namespace exported from `bun:test` (`jest.fn`, `jest.spyOn`, `jest.setSystemTime`, etc.). The `test/setup.ts` preload patches `jest.setSystemTime` / `jest.useRealTimers` so they also spy on `Date.now()` (Bun's `bun:test` clock only fakes the timer queue, not the wall clock).

## Documentation

- [README.md](README.md) — Installation & usage
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Detailed architecture guide
- [docs/ANTIGRAVITY_API_SPEC.md](docs/ANTIGRAVITY_API_SPEC.md) — API reference
- [CHANGELOG.md](CHANGELOG.md) — Version history
- [ARCHITECTURE.md](ARCHITECTURE.md) and [STRUCTURE.md](STRUCTURE.md) — repo-level architecture and file-system map
- [biome.json](biome.json) — formatter + linter config
- [lefthook.yml](lefthook.yml) — pre-commit Biome hook
- [mise.toml](mise.toml) — pinned `bun` + `node` versions
