# `@cortexkit/opencode-antigravity-auth`

[![npm version](https://img.shields.io/npm/v/@cortexkit/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/@cortexkit/opencode-antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dw/@cortexkit/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/@cortexkit/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Unified OpenCode 1.x (V1) and 2.x general-availability (GA) server/TUI plugin for Google Antigravity. Authenticate with your Google account, get **Antigravity quota** access to Claude 4.6, Gemini 3.x/2.5, and GPT-OSS 120B, plus standalone OAuth login and quota commands through the bundled `antigravity-auth` CLI.

> **CAUTION — read before installing.**
>
> Using this plugin (and any proxy for Antigravity) violates Google's Terms of Service. Google account holders have reported suspensions, bans, and shadow-bans (restricted access without notice). The plugin is **not endorsed by Google**; you assume all risks.

This package is part of the Antigravity Auth monorepo. See the [root README](../../README.md) for the full operator and contributor guide, the installation matrix, the configuration reference, and the release process. This guide describes the current source tree; it does not imply that an unreleased major version is available on npm.

## What you get

- **Claude Opus 4.6 / Sonnet 4.6 (thinking)** and **Gemini 3 Pro / Flash / 3.6 Flash / 3.1 Pro / 3.1 Flash Image** via Google OAuth against the Antigravity quota pool.
- **GPT-OSS 120B Medium** through the Antigravity-style headers.
- **Multi-account rotation** with deterministic selection (`sticky`, `round-robin`, `hybrid`), per-account rate-limit cooldowns, and a failsafe **killswitch** that hard-blocks accounts below a quota threshold.
- **Dual quota pools:** Antigravity headers + Gemini CLI headers with style-fallback so a single exhausted pool does not stall a request.
- **OpenTUI sidebar** — read-only account/quota state; V1 polls the on-disk sidebar-state file, while GA polls location-scoped snapshots through native host RPC. Neither carries credentials.
- **One `/antigravity` menu** for accounts, quota, routing, limits, diagnostics, sign-in, and vault setup. See [`src/plugin/commands.ts`](src/plugin/commands.ts) and [`src/tui/command-dialogs.tsx`](src/tui/command-dialogs.tsx).
- **Thinking models** with optional signature caching and precompiled OpenTUI JSX.
- **Standalone CLI** shipped as the `antigravity-auth` bin (`init`, `migrate`, `rollback`, `login`, `list`, `quota`) — same local shared account store as the plugin.
- **Auto-recovery** from `tool_result_missing` errors and proactive background token refresh.

## Host requirement

| Host field | Required range |
| --- | --- |
| OpenCode engine | `>=1.17.13 <2` or `>=2.0.22` |
| V1 SDK peer (`@opencode-ai/plugin`) | `*` (checkout pin `1.17.13`) |
| GA SDK peer (`@opencode/plugin`) | `>=2.0.22` (checkout pin `2.0.22`) |
| `@opentui/core`, `@opentui/keymap`, `@opentui/solid` peers | `>=0.4.5` each |
| `solid-js` peer | `>=1.9.0` |
| Node | `>=20` |

Host peers are optional in the [manifest](package.json), since each process uses its matching SDK/runtime. The checkout pins V1 OpenTUI `0.4.5` and GA OpenTUI `0.5.14`; the broad peer range is not proof that every host/runtime combination works. Installer enforcement must be checked against the host itself.

The public entries are:

- `exports["."]` — `dist/index.js`, the legacy V1 root.
- `exports["./server"]` — `dist/server.js`, the hybrid V1/GA server from [`src/server.ts`](src/server.ts).
- `exports["./tui"]` — [`src/tui/entry.mjs`](src/tui/entry.mjs), dispatching to V1 or GA compiled/raw TUI trees.

Top-level [`server.js`](server.js) and [`tui.js`](tui.js) forward directory-based host loading to those same entries. No separate OpenCode 2 adapter is installed.

## Installation

### OpenCode V1 (npm)

For V1 hosts that expose `opencode plugin`, the documented npm command is:

```bash
opencode plugin @cortexkit/opencode-antigravity-auth@latest
```

Verify the command in the matching host's help and inspect the resulting registrations. The package source proves its entries, not every host installer's effects. V1 uses a server registration in `opencode.json` and a TUI registration in `tui.json`; this recipe is not a GA CLI/config recipe.

#### Manual config (hand-edited configs)

V1 manual examples (merge into existing configs):

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

Before starting OpenCode, initialize a fresh local store or complete the [offline migration](#major-upgrades-account-store-migration-and-rollback). Pick **Antigravity (Google OAuth)** from the Google provider login, or use Sign in from `/antigravity`. Verify with the new build's `antigravity-auth quota`.

### OpenCode GA (2.x)

The same package provides GA server **and TUI**. The [pinned OpenCode 2.0.22 harness](../e2e-tests/src/opencode-ga-harness.ts) uses plural `plugins` with an absolute wrapper directory; its colocated server/TUI wrappers import the public `./server` and `./tui` entries. The shipped `server.js`/`tui.js` forwarders support registering the installed package's absolute directory in `plugins`, as shown below:

```jsonc
{
  "plugins": ["/absolute/path/to/node_modules/@cortexkit/opencode-antigravity-auth"]
}
```

The directory example follows the shipped forwarders, not a verified GA npm-installer command. Direct npm-spec registration and host CLI installation syntax remain unproven here; use the matching host's documentation. Do not copy the harness's synthetic provider credentials/mock URL. The harness's default fixture config has no user model map; no copied model-map requirement is established. See [the root GA guide](../../README.md#opencode-ga-2x) and the [host pin](../e2e-tests/docker/ga-binary-pin.json).

### Contributor (Bun)

```bash
bun install --frozen-lockfile                        # at repo root
bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts # Bun 1.4.2 private compiler
bun run build                                        # core -> opencode -> pi
bun run --cwd packages/opencode smoke:tui            # bundle + spawn the precompiled TUI
```

The public TUI loader chooses the V1 or GA renderer. V1 uses `src/tui-compiled/tui.js` for the host runtime or `src/tui-raw/tui.tsx` as the raw fallback; GA uses the `src/tui-ga-compiled/` and `src/tui-ga-raw/` trees. The loader probes virtual runtime support before selecting compiled or raw JSX. Other import errors propagate unchanged. Regenerate the trees with **Bun 1.4.2**: `bun run --cwd packages/opencode build:tui`. `bun run --cwd packages/opencode smoke:tui` checks fresh tarballs and consumer-local resolution. The private compiler and its input archive are repository-only and never shipped.

> Note: the pre-`2.0` inline quota helper is no longer shipped. Use `antigravity-auth quota [--refresh] [--json]` from this package or from the standalone CLI.

## Major upgrades: account-store migration and rollback

The local OpenCode pool now uses a shared account store, not direct writes to legacy `antigravity-accounts.json`. Use `antigravity-auth` from the **build you are upgrading to**, whose `--help` lists `init`, `migrate`, and `rollback`, before starting the host. “New CLI” below means that build's CLI:

**Before a major upgrade**, disable automatic config updates with the top-level setting below in the effective `antigravity.json`; project overrides must not re-enable it:

```json
{
  "auto_update": false
}
```

The published v2.2.1 default is `true`, and its restart-time update check can advance pinned configs across majors. Pinning a version alone is not an update hold. Merge this setting into existing config before stopping the host for migration; it does not replace the offline procedure. See the [root upgrade guide](../../README.md#major-upgrades-migration-and-rollback) for the historical updater/schema references.

- **Fresh installation:** run `antigravity-auth init`, then log in. Initialization refuses an existing legacy pool; use migration instead.
- **Existing legacy OpenCode pool:** stop **every OpenCode and Antigravity process and timer** that can use the pool, then run `antigravity-auth migrate --offline`. Confirm the stopped-process prompt by typing `yes`. Optional `--yes` skips the prompt, not the requirement to stop processes.
- **Downgrade after migration:** stop every OpenCode and Antigravity process and timer using the pool again, run `antigravity-auth rollback --offline` with the **new CLI**, confirm and wait for successful completion, and only then install/start an older build.

Rollback exports **current credentials and metadata** from the active generation into legacy V4 JSON; it never revives tokens from the original backup. It refuses an existing/recreated legacy file, changed snapshots, or credentials/metadata changed during rollback. Do not copy an old snapshot back, recreate the legacy file, or run old and new versions concurrently. If migration or rollback fails, keep the hosts stopped and resolve the reported refusal rather than bypassing it.

These commands manage the local OpenCode pool only. The host's native Google auth slot used to activate the provider and approved credentials held by the vault are separate: before changing builds, disconnect vault enrollment via `/antigravity` → Vault in the currently installed plugin, and re-login if native credentials cannot be safely restored. No complete restoration of native host records is promised. Pi's native auth file is **not** this pool; Pi-only users must not migrate it. See [the root upgrade guide](../../README.md#major-upgrades-migration-and-rollback), [`src/cli.ts`](./src/cli.ts), and [`account-migration.ts`](../core/src/account-migration.ts).

## Models

### Quick reference

The model registry lives at `packages/core/src/model-registry.ts`; the OpenCode package re-exports it through `getAntigravityOpencodeModelIds()`. Models below are an authoritative mirror at the time of release.

| Model | Variants | Quota group |
| --- | --- | --- |
| `antigravity-gemini-3.8-flash` | `low`, `high` | `gemini-flash` |
| `antigravity-gemini-3.7-flash` | `low`, `high` | `gemini-flash` |
| `antigravity-gemini-3.6-flash` | `low`, `high` | `gemini-flash` |
| `antigravity-gemini-3.5-flash` | `low`, `high` | `gemini-flash` |
| `antigravity-gemini-3.1-pro` | `low`, `high` | `gemini-pro` |
| `antigravity-gemini-3.1-flash-image` | — | `gemini-flash` |
| `antigravity-claude-sonnet-5-5` | low / medium / high | `claude` |
| `antigravity-claude-opus-5-5` | low / medium / high | `claude` |
| `antigravity-gpt-oss-120b-medium` | — | `gpt-oss` |

> Claude 5.5 has a 1,000,000-token context and 128,000-token output limit, with adaptive thinking. Claude 4.6 requests refuse rather than redirecting to a different model.

> Gemini 3.8 Flash Cyber is absent from the captured AGY 1.3.3 server catalog, so it is not exposed by this plugin. Gemini 3.5 Flash-Lite is also absent from the AGY catalog, and Gemini 3.5 Flash Cyber remains restricted to a limited-access CodeMender pilot.

### Routing

- **Antigravity-first (default).** Gemini requests go to the Antigravity header style first; on `429 RESOURCE_EXHAUSTED` they fall back to the Gemini CLI header set.
- **CLI-first** (`cli_first: true`). Flip the order — Gemini CLI first, Antigravity fallback. Change the live setting in `/antigravity` → Routing.
- **Style-fallback** (`quota_style_fallback: true`). Re-send the SAME request through the other header set on a rate limit. Default OFF because retrying can consume quota from both header-style pools. Change it in `/antigravity` → Routing.
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

## `/antigravity` menu

Open `/antigravity` for Accounts, Quota, Routing, Limits (killswitch/account floors), Diagnostics (logging/dumps), Sign in, and Vault. Sections/actions depend on the active credential source. Use the menu actions rather than supplying per-feature slash-command arguments.

V1 registers the command in [`src/plugin/catalog.ts`](src/plugin/catalog.ts), builds it in [`src/plugin/commands.ts`](src/plugin/commands.ts), and renders it in [`src/tui/command-dialogs.tsx`](src/tui/command-dialogs.tsx). The common menu comes from core's [`antigravity-command-menu.ts`](../core/src/antigravity-command-menu.ts).

## Standalone CLI

The `antigravity-auth` bin is bundled into this package:

```bash
npx -y @cortexkit/opencode-antigravity-auth login [--project <id>] [--no-browser]
npx -y @cortexkit/opencode-antigravity-auth list [--json]
npx -y @cortexkit/opencode-antigravity-auth quota [--json] [--refresh]
```

The new build also exposes `antigravity-auth init`, `migrate --offline [--yes]`, and `rollback --offline [--yes]`; see [Major upgrades](#major-upgrades-account-store-migration-and-rollback) before using them. Do not rely on an older npm CLI for store migration or rollback.

- `login` runs the full PKCE + local callback flow. `--no-browser` prints the URL instead of opening it (handy in headless / SSH sessions where the browser cannot reach the callback port; see Troubleshooting).
- `list` prints `INDEX`, `EMAIL`, `STATUS` for every account in storage (`active`, `disabled`, `ineligible`, `verification-required`).
- `quota` prints `ACCOUNT`, `STATUS`, `GROUP`, `REMAINING`, `RESET` rows. `--refresh` forces a live refresh; `--json` emits the same data as JSON.

Exit codes: `0` success, `1` thrown error, `2` parse failure. In local mode, CLI login writes through the same active shared store as the OpenCode adapters. `list` and `quota` read accounts; neither initializes nor migrates storage.

## Multi-account setup

Use the Google provider login or `/antigravity` → Sign in to add local accounts, then Accounts and Quota to inspect/manage the initialized repository. Models use the `google/` provider prefix (for example `google/antigravity-gemini-3.8-flash`); do not create a `google-antigravity` provider to activate this plugin. See [the root guide](../../README.md#multi-account-behavior) for the current store and the rotation strategies (`sticky`, `hybrid`, `round-robin`).

### Local authority / vault custody

Both OpenCode host lines share the local store at the resolved account path; starting a new project does not create a separate pool. `/antigravity` → Vault manages enrollment and source selection. Local authority uses local repository credentials; vault custody excludes the local pool, including when the vault is unavailable. OpenCode 1 needs a saved Google auth entry to load the provider. Once loaded, approved enrollment supplies vault credentials without reading or validating that entry's contents: existing ordinary Google logins and placeholder records from other enrollments remain unchanged. Explicit fresh provider activation refuses to overwrite an occupied Google auth slot. GA vault serving requires the native Google connection created for that enrollment; Pi requires the non-secret Google-slot marker created for that enrollment. Host activation and source-mode files are separate from pool migration/rollback. See [`src/plugin/vault-custody.ts`](src/plugin/vault-custody.ts), [`src/plugin/auth-loader.ts`](src/plugin/auth-loader.ts), and [`src/plugin/vault-activation.ts`](src/plugin/vault-activation.ts).

## Sidebar / RPC state and recovery

The **V1 sidebar** reads from `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` (or whatever `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE` points at) and polls every `2s`. The contract version is `1`; malformed JSON or unknown versions silently fall back to `DEFAULT_SIDEBAR_STATE` (which is rendered as "Awaiting Antigravity state"). Carries `version`, `checkedAt`, `accounts[]`, `activeRouting` (per-session map, pruned to 24h / 100 entries), `routingAuthoritative`, optional `quotaBackoffUntil` and `lastError`. **Never carries refresh tokens, access tokens, project IDs, or fingerprints.** GA's sidebar/menu instead uses location-scoped snapshots through native host RPC; see [`src/ga/tui/host-ga.tsx`](src/ga/tui/host-ga.tsx).

The **V1 RPC** lives under `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` (override via `ANTIGRAVITY_AUTH_RPC_DIR`). The TUI selects a live entry and exchanges shared menu requests/notifications with the loopback server using a `Bearer <token>` header. GA uses its own server/TUI integration; this V1 port file is not a GA host configuration requirement.

**Recovery from a stale sidebar** — stop the host, verify `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` exists and is `0600`, then restart. **Recovery from a missing RPC port file** — confirm the running plugin process exists; `getRpcDir(directory)` derives the directory from a sha256 of the project directory, so two projects on the same host get independent RPC dirs.

## V1 disposal

`dispose()` marks the plugin closing synchronously so no new work is admitted. Shutdown then:

1. Aborts and waits for live and retiring requests and token-refresh shutdown before disposing their account managers.
2. Closes the disk signature cache and clears session/fetch state.
3. Stops and waits for registered producers, so they cannot enqueue more sidebar writes.
4. Waits for the queued sidebar writes to settle through `drainSidebarWrites()`.
5. Stops registered consumers, including the RPC server and file logger.

The shutdown ordering above does not guarantee every attempted write succeeded or that the terminal rendered a final snapshot. See [`src/plugin/lifecycle.ts`](src/plugin/lifecycle.ts).

## File / state inventory (this package)

| Purpose | Path | Mode | Notes |
| --- | --- | --- | --- |
| Local account store | Beside the resolved account path: `antigravity-accounts.json.store.pointer.json` selects `antigravity-accounts.json.store.<id>.generation/` | Owner-only | Active `config.json` / `state.json`, migration journal, protected backups/transfers. |
| Legacy pool | `~/.config/opencode/antigravity-accounts.json` (or `OPENCODE_CONFIG_DIR`) | `0600` | Legacy JSON schema version 4: migration input / successful rollback output, not the active writer target. |
| Plugin config | `~/.config/opencode/antigravity.json` (and project `.opencode/antigravity.json`) | `0600` | Zod-validated config. |
| Debug logs | `~/.config/opencode/antigravity-logs/` (or `log_dir`) | `0600` | Sensitive — request/response bodies. |
| V1 sidebar state | `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` | `0600` dir `0700` | Poll-every-2s; pruned to 24h / 100 entries. |
| V1 RPC port file | `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` | `0600` | Loopback token bearer. |
| Signature cache | `signature-cache-disk-<hash>.json` (when `keep_thinking: true`) | `0600` | 2-day default TTL. |

## Debug sinks

The plugin has **two** debug sinks controlled independently:

- `debug: true` — file logging under `log_dir`. Disabled by default. May include request/response bodies; handle with care.
- `debug_tui: true` — TUI log-panel verbosity. Independent of `debug`.

Combined with the runtime log-level filter (`operator.log_level`, mutable through `/antigravity` → Diagnostics), you have three independent knobs.

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
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
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

Run these commands from the **repository root**. Deterministic tests use isolated source selectors; live model/regression checks are separate:

| Scope | Tooling | Network | Command |
| --- | --- | --- | --- |
| Unit (deterministic) | isolated source selectors in root `package.json` | No | `bun run test` |
| Black-box e2e (deterministic) | mock Antigravity + harness runner in `packages/e2e-tests/` | No | `bun run test:e2e` |
| Live model inventory | `script/test-models.ts` | Yes (gated by label) | `bun run test:e2e:models` |
| Cross-model regression | `script/test-regression.ts` + `script/test-cross-model*.sh` | Yes | `bun run test:e2e:regression` |
| TUI smoke | install tarball + spawn | No | `bun run --cwd packages/opencode smoke:tui` |

The deterministic tier is what CI gates; the live tier is opt-in for changes that touch the model registry, the request transform, or the response transform.

## Troubleshooting

> Do not delete the legacy pool, store pointer/generation, or custody files as a generic reset. Stop the host, resolve the reported store/source refusal, then use `/antigravity` account actions or provider re-login. Deletion can destroy rollback evidence or the saved native login.

### Configuration paths (all platforms)

The default account path is `~/.config/opencode/antigravity-accounts.json`; override its config directory with `OPENCODE_CONFIG_DIR`. Platform-path compatibility handling is separate from the new account-store migration: an existing legacy pool still requires explicit `migrate --offline`, not an automatic upgrade on first read. See [`src/plugin/storage.ts`](src/plugin/storage.ts).

### OAuth callback issues

- **Safari HTTPS-Only mode** blocks `http://localhost`. Switch browsers or temporarily disable HTTPS-Only (Safari → Settings → Privacy) during login.
- **Stale `Address already in use :51121`** — `lsof -i :51121` (or `netstat -ano | findstr :51121` on Windows) → stop the stale listener → retry. `--no-browser` suppresses browser launch; it is not a guarantee that the callback port is unused.
- **SSH / remote dev** — forward the callback port with `ssh -L 51121:localhost:51121 user@remote`. The standalone CLI + `--no-browser` is the simplest workaround when SSH-port-forwarding is awkward.
- **Docker / WSL2 / containers** — localhost OAuth does not work in containers out of the box. Wait 30s for the manual URL flow, or port-forward `51121` to the host.

### Common errors

- **`Permission 'cloudaicompanion.companions.generateChat' denied on resource '…/locations/global'`** — Antigravity returned no project ID and the plugin used the fallback `rising-fact-p41fc`. Enable the Gemini for Google Cloud API on your project and authenticate locally with `antigravity-auth login --project <id>`; do not edit retired pool JSON. For vault credentials, contact the vault operator.
- **Gemini 3 model 400 "Unknown name 'parameters'"** — usually a tool-schema incompatibility. Update to the latest plugin version; or disable MCP servers one-by-one to isolate the offender.
- **`Invalid function name must start with a letter or underscore`** — an MCP tool name starts with a digit (e.g. `1mcp_*`). Rename the MCP key to start with a letter (e.g. `gw`) or disable that MCP entry for Antigravity models.
- **`All Accounts Rate-Limited (But Quota Available)`** — inspect thresholds and readings. Lower `soft_quota_threshold_percent` (or raise to `100`) and use `/antigravity` → Quota to check now; do not delete the store to clear cooldowns.
- **Unexpected temporary files** — stop every process/timer using the pool and inspect the reported error. Do not remove migration, transfer, or custody artifacts while diagnosing a failed operation.

### Sidebar / TUI

- **`Awaiting Antigravity state` stuck** — verify `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` exists, is `0600`, and the host user can write. Restart the host.
- **TUI bundle fails to spawn** — with **Bun 1.4.2**, `bun run --cwd packages/opencode build:tui` regenerates V1 and GA compiled/raw trees. Check the tree selected by `src/tui/entry.mjs`, then run `bun run --cwd packages/opencode smoke:tui`.
- **`Antigravity RPC server is not available` (V1)** — the TUI uses a per-PID port file in `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/`. If the running plugin process is gone, stop and restart the host.

### Moving between machines

A migrated pool is not a single `antigravity-accounts.json` file. Do not copy only the old JSON or manually splice generation files into another profile. A general cross-machine store transfer procedure is not established here; prefer a fresh explicit initialization and re-login on the destination, or vault enrollment through `/antigravity`. Offline rollback downgrades the active store produced by initialization/migration; it is not a generic backup restore.

### Plugin config schema

The schema reference at `assets/antigravity.schema.json` drives editor IntelliSense. Set `$schema: "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json"` in your `antigravity.json` for autocomplete in the IDE.

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
