# `@cortexkit/opencode-antigravity-auth`

[![npm version](https://img.shields.io/npm/v/@cortexkit/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/@cortexkit/opencode-antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dw/@cortexkit/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/@cortexkit/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenCode 1.x plugin + OpenTUI sidebar for Google Antigravity. Authenticate with your Google account, get **Antigravity quota** access to Claude 4.6, Gemini 3.x/2.5, and GPT-OSS 120B, plus standalone OAuth login and quota commands through the bundled `antigravity-auth` CLI.

> **CAUTION — read before installing.**
>
> Using this plugin (and any proxy for Antigravity) violates Google's Terms of Service. Google account holders have reported suspensions, bans, and shadow-bans (restricted access without notice). The plugin is **not endorsed by Google**; you assume all risks.

This package is part of the `@cortexkit/antigravity-auth@2.0.0` monorepo. See the [root README](../../README.md) for the full operator and contributor guide, the installation matrix, the configuration reference, and the release process.

## What you get

- **Claude Opus 4.6 / Sonnet 4.6 (thinking)** and **Gemini 3 Pro / Flash / 3.6 Flash / 3.1 Pro / 3.1 Flash Image** via Google OAuth against the Antigravity quota pool.
- **GPT-OSS 120B Medium** through the Antigravity-style headers.
- **Multi-account rotation** with deterministic selection (`sticky`, `round-robin`, `hybrid`), per-account rate-limit cooldowns, and a failsafe **killswitch** that hard-blocks accounts below a quota threshold.
- **Dual quota pools:** Antigravity headers + Gemini CLI headers with style-fallback so a single exhausted pool does not stall a request.
- **OpenTUI sidebar** — read-only, polls the on-disk sidebar-state file every 2s. Carries per-account health, cooldown, and per-quota-group remaining percent; never carries credentials.
- **Six slash commands** wired through the OpenTUI dialog system — `/antigravity-quota`, `/antigravity-account`, `/antigravity-routing`, `/antigravity-killswitch`, `/antigravity-dump`, `/antigravity-logging`. See `packages/opencode/src/plugin/commands.ts` and `packages/opencode/src/tui/command-dialogs.tsx`. `/gemini-dump` remains a backward-compat alias.
- **Thinking models** with optional signature caching and precompiled OpenTUI JSX.
- **Standalone CLI** shipped as the `antigravity-auth` bin (`login`, `list`, `quota`) — same storage as the plugin.
- **Auto-recovery** from `tool_result_missing` errors and proactive background token refresh.

## Host requirement

| Host field | Required range |
| --- | --- |
| `@opencode-ai/plugin` peer dependency | `>=1.17.13 <2` |
| `@opentui/core`, `@opentui/keymap`, `@opentui/solid` (peer) | `^0.4.5` each |
| Node | `>=20` |

The package pins the supported host range through `engines.opencode` (`>=1.17.13 <2`); `opencode plugin` refuses to install a plugin that asks for an unsupported range.

The package exposes two `exports` subpaths the host installer reads:

- `exports["."]` — the bundled `dist/index.js` server root. `opencode plugin` writes this entry into `opencode.json`'s `plugin` array.
- `exports["./tui"]` — `src/tui/entry.mjs`, the OpenTUI sidebar loader. `opencode plugin` writes this entry into `tui.json` so the TUI process picks it up on the next host start.

## Installation

### End-user (npm) — the supported path

The supported installer writes both registrations in one step:

```bash
opencode plugin @cortexkit/opencode-antigravity-auth@latest
```

What this does:

- Reads the package's `exports["."]` and writes it into `~/.config/opencode/opencode.json` under the `plugin` array — the `auth.loader` and `fetch` interceptor the host calls on every model dispatch.
- Reads the package's `exports["./tui"]` and writes it into `~/.config/opencode/tui.json` so the TUI process picks the sidebar up on the next host start.
- Refuses to install when the host's OpenCode version falls outside the package's `engines.opencode` range.

#### Manual config (hand-edited configs)

If you cannot use `opencode plugin`, write both files by hand:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth@latest"]
}
```

```jsonc
// ~/.config/opencode/tui.json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth"]
}
```

The two files are independent — the server registration is read from `opencode.json` and the TUI registration from `tui.json`.

Then start OpenCode and run `opencode auth login`, pick **Antigravity (Google OAuth)** in the menu (or `/antigravity-account add`). Verify with `npx -y @cortexkit/opencode-antigravity-auth quota`.

### Contributor (Bun)

```bash
bun install                                          # at repo root
bun run build                                        # core -> opencode -> pi
bun run --cwd packages/opencode smoke:tui            # bundle + spawn the precompiled TUI
```

A precompiled JSX tree ships under `dist/src/tui-compiled/` and is regenerated by `bun run build:tui` (alias of `bunx tsx packages/opencode/scripts/build-tui.ts`). The host runtime module loads either the **precompiled** tree (production) or the **raw** `src/tui.tsx` source (development installs). `bun run --cwd packages/opencode smoke:tui` confirms both subpaths resolve correctly against the packaged tarball.

> Note: the pre-`2.0` inline quota helper is no longer shipped. Use `antigravity-auth quota [--refresh] [--json]` from this package or from the standalone CLI.

## v2.0 migration

- **Root exports changed.** The package no longer re-exports `authorizeAntigravity` / `exchangeAntigravity` at the root — import them from `@cortexkit/antigravity-auth-core` instead:

  ```ts
  // v1.x — no longer supported at the root
  // import { authorizeAntigravity } from "@cortexkit/opencode-antigravity-auth"

  // v2.0 — explicit core import
  import { authorizeAntigravity, exchangeAntigravity } from "@cortexkit/antigravity-auth-core"
  ```

- **`@opencode-ai/plugin` peer dependency** moved from `^0.15.30` to `^1.17.13`. Hosts on 1.17.13+ get the TUI registration through `opencode plugin` (the host reads `exports["./tui"]` and writes it into `tui.json`).
- **New peer dependencies** (`@opentui/core`, `@opentui/keymap`, `@opentui/solid` at `^0.4.5`) — required by the sidebar.
- No account-storage changes: the on-disk format is unchanged from the v1.4+ storage schema (`AccountStorageV4`).
- Missing accounts now return **HTTP 401 `UNAUTHENTICATED`** from the fetch interceptor instead of a synthetic 200 with assistant text.

See [packages/opencode/CHANGELOG.md](./CHANGELOG.md) for the full list of v2.0.0 changes.

## Models

### Quick reference

The model registry lives at `packages/core/src/model-registry.ts`; the OpenCode package re-exports it through `getAntigravityOpencodeModelIds()`. Models below are an authoritative mirror at the time of release.

| Model | Variants | Quota group |
| --- | --- | --- |
| `antigravity-gemini-3.6-flash` | `low`, `high` | `gemini-flash` |
| `antigravity-gemini-3.5-flash` | `low`, `high` | `gemini-flash` |
| `antigravity-gemini-3.1-pro` | `low`, `high` | `gemini-pro` |
| `antigravity-gemini-3.1-flash-image` | — | `gemini-flash` |
| `antigravity-claude-sonnet-4-6` | — | `claude` |
| `antigravity-claude-opus-4-6-thinking` | `low`, `max` | `claude` |
| `antigravity-gpt-oss-120b-medium` | — | `gpt-oss` |
| `gemini-2.5-flash` | — | `gemini-flash` (CLI pool) |
| `gemini-2.5-pro` | — | `gemini-pro` (CLI pool) |
| `gemini-3-flash-preview` | — | `gemini-flash` (CLI pool) |
| `gemini-3-pro-preview` | — | `gemini-pro` (CLI pool) |
| `gemini-3.1-pro-preview` | — | `gemini-pro` (CLI pool) |
| `gemini-3.1-pro-preview-customtools` | — | `gemini-pro` (CLI pool) |

> Gemini 3.5 Flash-Lite is not in the AGY 1.1.5 Antigravity or Gemini CLI quota catalogs, and Gemini 3.5 Flash Cyber is restricted to a limited-access CodeMender pilot — neither is exposed by this plugin.

### Routing

- **Antigravity-first (default).** Gemini requests go to the Antigravity header style first; on `429 RESOURCE_EXHAUSTED` they fall back to the Gemini CLI header set.
- **CLI-first** (`cli_first: true`). Flip the order — Gemini CLI first, Antigravity fallback. Toggle at runtime through `/antigravity-routing cli_first=true`.
- **Style-fallback** (`quota_style_fallback: true`). Re-send the SAME request through the other header set on a rate limit. Default OFF to prevent double-spend across pools. Toggle at runtime through `/antigravity-routing quota_style_fallback=true`.
- **Claude and image models** always use Antigravity regardless of toggles.
- Model names transform automatically between Antigravity and Gemini CLI namespaces (`antigravity-gemini-3-flash` ↔ `gemini-3-flash-preview`).

### Quota, killswitch, and the soft-threshold fail-open

Each cached quota entry carries `{ remainingFraction, resetTime }` per group:

- **Soft-quota threshold** — `soft_quota_threshold_percent` (default 80). Accounts above the threshold are skipped as if rate-limited. Set to `100` to disable.
- **Stale-TTL fail-open** — `soft_quota_cache_ttl_minutes = "auto"` resolves to `max(2 × refresh, 10)` minutes. Cache older than the TTL is treated as unknown and allowed through.
- **Proactive rotation** — `proactive_rotation_threshold_percent` (default 20). When the active account's remaining quota drops below, dispatch the next request from a warm-cache account.
- **All-throttled wait** — `max_rate_limit_wait_seconds` (default 300). Cap on how long the interceptor waits when every account is rate-limited before failing fast.

The **operator killswitch** is a hard rejection layer run BEFORE the soft-quota filter:

- `enabled` master switch.
- `minimum_remaining_percent` (default 5) — global hard-block threshold.
- `accounts[key]` — per-account override keyed by `sha256(refreshToken).slice(0,12)`. The hash is deterministic but irreversible; the raw token never appears in the config, the sidebar, RPC payloads, or apply responses.
- **Cache-TTL fail-open** — when an account has no fresh cached quota (default 5 min TTL), it is allowed through so a cold start cannot deadlock.
- **All-killed error** — if the entire pool is excluded, the interceptor throws `AntigravityKillswitchError` with a per-account summary.

Both filters run before the token bucket / health score pick, so the operator's threshold is authoritative even on a healthy pool.

## Six slash commands

All commands are registered through `packages/opencode/src/plugin/catalog.ts` and the modal flow renders in `packages/opencode/src/tui/command-dialogs.tsx`. The apply RPC defaults to `2_000` ms; account `add` / `refresh` opts into `120_000` ms because OAuth can take up to two minutes on a fresh login.

| Command | Args | Default timeout |
| --- | --- | --- |
| `/antigravity-quota` | `[refresh]` — status (default) or refresh all accounts | `2_000` |
| `/antigravity-account` | `add` · `refresh` · `remove` · `list` | `2_000` for list/remove, `120_000` for add/refresh |
| `/antigravity-routing` | `cli_first=true\|false` · `quota_style_fallback=true\|false` (omit a key to flip) | `2_000` |
| `/antigravity-killswitch` | `enabled=true\|false` · `minimum_remaining_percent=0..100` | `2_000` |
| `/antigravity-dump` | `enable` · `disable` · `status` (alias: `/gemini-dump`) | `2_000` |
| `/antigravity-logging` | `error` · `warn` · `info` · `debug` · `trace` | `2_000` |

Every apply mutates persistent state and bumps the sidebar's `checkedAt` via `createSidebarRefresher` so the TUI's next poll sees a fresh snapshot. Sidebar writers go through `sidebarWriteChain` (cross-process fenced lock, 2s lock timeout, atomic write `0600`).

## Standalone CLI

The `antigravity-auth` bin is bundled into this package:

```bash
npx -y @cortexkit/opencode-antigravity-auth login [--project <id>] [--no-browser]
npx -y @cortexkit/opencode-antigravity-auth list [--json]
npx -y @cortexkit/opencode-antigravity-auth quota [--json] [--refresh]
```

- `login` runs the full PKCE + local callback flow. `--no-browser` prints the URL instead of opening it (handy in headless / SSH sessions where the browser cannot reach the callback port; see Troubleshooting).
- `list` prints `INDEX`, `EMAIL`, `STATUS` for every account in storage (`active`, `disabled`, `ineligible`, `verification-required`).
- `quota` prints `ACCOUNT`, `STATUS`, `GROUP`, `REMAINING`, `RESET` rows. `--refresh` forces a live refresh; `--json` emits the same data as JSON.

Exit codes: `0` success, `1` thrown error, `2` parse failure. The CLI writes to the same `antigravity-accounts.json` the plugin reads — a CLI login shows up at the next plugin reload.

## Multi-account setup

```bash
opencode auth login                  # run again to add more accounts; pick Antigravity (Google OAuth)
opencode auth login                  # → "Check quotas" or "Manage accounts" for the existing pool
```

Options exposed through the auth menu: configure models in `opencode.json` automatically, view remaining quota per account, enable/disable specific accounts. See [docs/MULTI-ACCOUNT.md](./docs/MULTI-ACCOUNT.md) for the storage schema, fenced-lock writers, and the rotation strategies (`sticky`, `hybrid`, `round-robin`) in depth.

## Sidebar / RPC state and recovery

The sidebar reads from `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` (or whatever `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE` points at) and polls every `2s`. The contract version is `1`; malformed JSON or unknown versions silently fall back to `DEFAULT_SIDEBAR_STATE` (which is rendered as "Awaiting Antigravity state"). Carries `version`, `checkedAt`, `accounts[]`, `activeRouting` (per-session map, pruned to 24h / 100 entries), `routingAuthoritative`, optional `quotaBackoffUntil` and `lastError`. **Never carries refresh tokens, access tokens, project IDs, or fingerprints.**

The RPC lives under `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` (override via `ANTIGRAVITY_AUTH_RPC_DIR`). The TUI process reads the highest-mtime live entry, drops entries whose owning PID is dead (`process.kill(pid, 0)`), and posts to `/rpc/apply` / `/rpc/pending-notifications` with a `Bearer <token>` header on `http://127.0.0.1`. The default request timeout is `2_000` ms; account `add` / `refresh` opts into `120_000` ms.

**Recovery from a stale sidebar** — stop the host, verify `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` exists and is `0600`, then restart. **Recovery from a missing RPC port file** — confirm the running plugin process exists; `getRpcDir(directory)` derives the directory from a sha256 of the project directory, so two projects on the same host get independent RPC dirs.

## Disposal

The plugin's `dispose()` (host shutdown) runs in order:

1. Dispose the active `AccountManager` + proactive token-refresh queue.
2. Shut down the disk signature cache (if `keep_thinking` is on).
3. Clear the session registry.
4. Drop the fetch-interceptor state.
5. `drainSidebarWrites()` — wait for any in-flight sidebar-state merge to land so the TUI sees a fully landed snapshot if the user immediately reopens.
6. Tear down registered disposables (RPC server, file logger, quota manager).

This ordering matters because a routing upsert enqueued at shutdown must land before the host closes the terminal. See `packages/opencode/src/plugin/lifecycle.ts:createPluginLifecycle`.

## File / state inventory (this package)

| Purpose | Path | Mode | Notes |
| --- | --- | --- | --- |
| Account pool | `~/.config/opencode/antigravity-accounts.json` (`%APPDATA%\opencode\…` on Windows) | `0600` | Storage schema `V4`. |
| Plugin config | `~/.config/opencode/antigravity.json` (and project `.opencode/antigravity.json`) | `0600` | Zod-validated config. |
| Debug logs | `~/.config/opencode/antigravity-logs/` (or `log_dir`) | `0600` | Sensitive — request/response bodies. |
| Sidebar state | `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` | `0600` dir `0700` | Poll-every-2s; pruned to 24h / 100 entries. |
| RPC port file | `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` | `0600` | Loopback token bearer. |
| Signature cache | `signature-cache-disk-<hash>.json` (when `keep_thinking: true`) | `0600` | 2-day default TTL. |

## Debug sinks

The plugin has **two** debug sinks controlled independently:

- `debug: true` — file logging under `log_dir`. Disabled by default. May include request/response bodies; handle with care.
- `debug_tui: true` — TUI log-panel verbosity. Independent of `debug`.

Combined with the runtime log-level filter (`operator.log_level`, mutable through `/antigravity-logging`), you have three independent knobs.

## Plugin interactions

For load-balancing, dual quota pools, and account storage details, see [docs/MULTI-ACCOUNT.md](./docs/MULTI-ACCOUNT.md).

### `@tarquinen/opencode-dcp`

DCP creates synthetic assistant messages that lack thinking blocks. **List this plugin BEFORE DCP**:

```json
{
  "plugin": [
    "@cortexkit/opencode-antigravity-auth@latest",
    "@tarquinen/opencode-dcp@latest"
  ]
}
```

### `oh-my-opencode`

Disable built-in auth and override agent models in `oh-my-opencode.json`:

```json
{
  "google_auth": false,
  "agents": {
    "frontend-ui-ux-engineer": { "model": "google/antigravity-gemini-3-pro" },
    "document-writer": { "model": "google/antigravity-gemini-3-flash" },
    "multimodal-looker": { "model": "google/antigravity-gemini-3-flash" }
  }
}
```

> **Tip:** When spawning parallel subagents, enable `pid_offset_enabled: true` in `antigravity.json` to distribute sessions across accounts.

### Plugins you don't need

- **gemini-auth plugins** — not needed; this plugin handles all Google OAuth.

## Configuration keys (selected)

Created by `~/.config/opencode/antigravity.json` for optional overrides. The full list with defaults and env overrides is in the [root README](../../README.md#configuration-reference) and the generated schema at [`assets/antigravity.schema.json`](./assets/antigravity.schema.json).

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/assets/antigravity.schema.json",
  "account_selection_strategy": "hybrid",
  "scheduling_mode": "cache_first",
  "soft_quota_threshold_percent": 80,
  "quota_refresh_interval_minutes": 30,
  "keep_thinking": false
}
```

Environment variables:

```bash
OPENCODE_CONFIG_DIR=/path/to/config opencode
OPENCODE_ANTIGRAVITY_DEBUG=1 opencode
OPENCODE_ANTIGRAVITY_DEBUG_TUI=1 opencode
OPENCODE_ANTIGRAVITY_LOG_DIR=/secure/path opencode
```

For every option, see [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) and the generated [`assets/antigravity.schema.json`](./assets/antigravity.schema.json).

## Tests

This package ships **deterministic** tests for everything except the model registry and the live cross-model regression suite:

| Scope | Tooling | Network | Command |
| --- | --- | --- | --- |
| Unit (deterministic) | `bun test --isolate` | No | `bun run test` |
| Black-box e2e (deterministic) | mock Antigravity + harness runner in `packages/e2e-tests/` | No | `bun run test:e2e` |
| Live model inventory | `script/test-models.ts` | Yes (gated by label) | `bun run test:e2e:models` |
| Cross-model regression | `script/test-regression.ts` + `script/test-cross-model*.sh` | Yes | `bun run test:e2e:regression` |
| TUI smoke | install tarball + spawn | No | `bun run smoke:tui` |

The deterministic tier is what CI gates; the live tier is opt-in for changes that touch the model registry, the request transform, or the response transform.

## Troubleshooting

> **Quick reset** when nothing else works: stop OpenCode, `rm ~/.config/opencode/antigravity-accounts.json`, then `opencode auth login`.

### Configuration paths (all platforms)

OpenCode uses `~/.config/opencode/` on **all platforms** including Windows; do not use `%APPDATA%` for new installs. Override with `OPENCODE_CONFIG_DIR`. v1.3.x and earlier stored config under `%APPDATA%\opencode\` — the plugin auto-migrates on first read.

### OAuth callback issues

- **Safari HTTPS-Only mode** blocks `http://localhost`. Switch browsers or temporarily disable HTTPS-Only (Safari → Settings → Privacy) during login.
- **Stale `Address already in use :51121`** — `lsof -i :51121` (or `netstat -ano | findstr :51121` on Windows) → kill the PID → retry. The standalone CLI's `--no-browser` flag avoids the listener entirely.
- **SSH / remote dev** — forward the callback port with `ssh -L 51121:localhost:51121 user@remote`. The standalone CLI + `--no-browser` is the simplest workaround when SSH-port-forwarding is awkward.
- **Docker / WSL2 / containers** — localhost OAuth does not work in containers out of the box. Wait 30s for the manual URL flow, or port-forward `51121` to the host.

### Common errors

- **`Permission 'cloudaicompanion.companions.generateChat' denied on resource '…/locations/global'`** — Antigravity returned no project ID (likely a workspace account) and the plugin used the hardcoded fallback `rising-fact-p41fc`. Enable the Gemini for Google Cloud API on a Cloud project and set `projectId` on the account in `antigravity-accounts.json`.
- **Gemini 3 model 400 "Unknown name 'parameters'"** — usually a tool-schema incompatibility. Update to the latest plugin version; or disable MCP servers one-by-one to isolate the offender.
- **`Invalid function name must start with a letter or underscore`** — an MCP tool name starts with a digit (e.g. `1mcp_*`). Rename the MCP key to start with a letter (e.g. `gw`) or disable that MCP entry for Antigravity models.
- **`All Accounts Rate-Limited (But Quota Available)`** — usually a stale cascade in `clearExpiredRateLimits()`. Lower `soft_quota_threshold_percent` (or raise to `100`), run `/antigravity-quota refresh`, or delete `antigravity-accounts.json` and re-authenticate.
- **Infinite `.tmp` files** — a rate-limit retry loop is creating temp files faster than cleanup. Stop OpenCode, `rm ~/.config/opencode/*.tmp`, add accounts, or wait for the cooldown.

### Sidebar / TUI

- **`Awaiting Antigravity state` stuck** — verify `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` exists, is `0600`, and the host user can write. Restart the host.
- **TUI bundle fails to spawn** — `bun run --cwd packages/opencode build` regenerates `dist/src/tui-compiled/tui.tsx`. Verify the file exists. Then `bun run --cwd packages/opencode smoke:tui`.
- **`Antigravity RPC server is not available`** — the TUI posts to a per-PID port file in `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/`. If the running plugin process is gone, stop and restart the host.

### Migration between machines

When copying `antigravity-accounts.json` to a new machine:

1. Ensure the plugin is installed: `"plugin": ["@cortexkit/opencode-antigravity-auth@latest"]`.
2. Copy `~/.config/opencode/antigravity-accounts.json` (preserve the `0600` mode).
3. If you see `API key missing`, the refresh token may be invalid — re-authenticate.

### Plugin config schema

The schema reference at `assets/antigravity.schema.json` drives editor IntelliSense. Set `$schema: "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/assets/antigravity.schema.json"` in your `antigravity.json` for autocomplete in the IDE.

## Documentation

- [Root README](../../README.md) — full operator + contributor guide
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [STRUCTURE.md](./STRUCTURE.md) — file-system map
- [ARCHITECTURE.md](./ARCHITECTURE.md) — architecture overview
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) — every option with examples
- [docs/MULTI-ACCOUNT.md](./docs/MULTI-ACCOUNT.md) — load balancing, dual quota, storage
- [docs/MODEL-VARIANTS.md](./docs/MODEL-VARIANTS.md) — variants and thinking budgets
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — long-form troubleshooting
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — internal architecture
- [docs/ANTIGRAVITY_API_SPEC.md](./docs/ANTIGRAVITY_API_SPEC.md) — Antigravity API reference

## Support

If this plugin saves you time, consider supporting its development at <https://ko-fi.com/S6S81QBOIR>.

## Credits

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

## License

MIT. See [LICENSE](./LICENSE).
