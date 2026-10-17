# Antigravity Auth

Google Antigravity OAuth for coding agents. Authenticate with your Google account and access Antigravity quota for Gemini, Claude, and GPT-OSS models from OpenCode, the Pi coding agent, or the standalone CLI.

Here **V1** means OpenCode 1.x; **GA** means the OpenCode 2.x general-availability host API. Both use one OpenCode package, including server and TUI entries.

This monorepo ships three publishable packages:

| Package | Host | Role |
| --- | --- | --- |
| [`@cortexkit/opencode-antigravity-auth`](packages/opencode) | OpenCode V1 + GA server/TUI | Unified package: V1 fetch interception, GA loopback bridge, account pool + quota manager, and the `/antigravity` menu/sidebar. |
| [`@cortexkit/pi-antigravity-auth`](packages/pi) | Pi coding agent | Registers a custom provider with OAuth login + Gemini streaming. |
| [`@cortexkit/antigravity-auth-core`](packages/core) | Any harness | Harness-agnostic core: OAuth PKCE, raw HTTP/1.1 transport, device fingerprint, request transforms, account pool, quota manager, durable storage. All host adapters depend on it. |

## Risk and terms-of-service warning

> **CAUTION — read before installing.**
>
> Using this software (and any proxy for Antigravity) violates Google's Terms of Service. Google account holders have reported **suspensions, bans, and shadow-bans** (restricted access without notice). The tool is **not endorsed by Google**, and every account is operated by the account holder. You assume all legal, financial, and technical risk. Operators and contributors are not liable for outcomes.

The shipped headers, project IDs, and OAuth client identifiers match the publicly observable behavior of the upstream Antigravity CLI; they are not credentials and may be inspected in this repository. **Keep OAuth credentials (refresh/access tokens, browser cookies), bearer tokens, and request/response dumps out of this repository, issues, and chat.** Credentials belong in the local shared account store, native host auth slots, or vault custody files; debug logs and dumps can also contain sensitive data.

## Packages and supported hosts

| Host | Package version | Host requirement | Install path |
| --- | --- | --- | --- |
| OpenCode V1 (server + TUI) | unified OpenCode package | OpenCode `>=1.17.13 <2`; V1 uses `@opencode-ai/plugin` | V1 installer/manual registrations below |
| OpenCode GA (2.x server + TUI) | same unified OpenCode package | OpenCode `>=2.0.22`; `@opencode/plugin >=2.0.22` | Public `./server` + `./tui` entries; source-backed directory config below |
| Pi coding agent | `latest` | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (peer) | `pi install npm:@cortexkit/pi-antigravity-auth` then `/login google` |
| Standalone CLI | shipped inside the unified OpenCode package as the `antigravity-auth` bin | Node 20+ | `npx @cortexkit/opencode-antigravity-auth --help` |
| Node libraries (harness builders) | `latest` core | Node 20+ | `npm install @cortexkit/antigravity-auth-core` |

The [OpenCode manifest](packages/opencode/package.json) exposes `.` (`dist/index.js`, legacy V1 root), `./server` (`dist/server.js`, hybrid V1/GA server), and `./tui` (`src/tui/entry.mjs`, dispatching to the appropriate V1/GA TUI). Shipped top-level [`server.js`](packages/opencode/server.js) and [`tui.js`](packages/opencode/tui.js) forward directory-based host loading to those public entries. There is no separate OpenCode 2 package.

`engines.opencode` is `>=1.17.13 <2 || >=2.0.22`; Node is `>=20`. Host peers are optional in the manifest: V1/GA plugin SDKs are separate, OpenTUI peers are `>=0.4.5`, and `solid-js` is `>=1.9.0`. The checkout pins V1 SDK `1.17.13`/OpenTUI `0.4.5` and GA SDK `2.0.22`/OpenTUI `0.5.14`; the peer range alone does not prove every host/runtime combination. Host installer behavior is distinct from these package exports.

## Installation matrix

### OpenCode V1 (npm)

For V1 hosts that expose `opencode plugin`, the documented npm installation command is:

```bash
opencode plugin @cortexkit/opencode-antigravity-auth@latest
```

Check your host's help and resulting registrations: the repository establishes the package entries, not every host installer's behavior. V1 needs the server registration in `opencode.json` and a TUI registration in `tui.json`; do not reuse this V1 CLI/config recipe for GA.

#### Manual config (hand-edited configs)

The V1 manual registration examples are below (merge them into your existing host configs). The server entry lives in `opencode.json`:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth@latest"]
}
```

The TUI entry lives in a separate `tui.json` file under the same config dir:

```jsonc
// ~/.config/opencode/tui.json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth"]
}
```

The two files are independent — the host reads the server registration from `opencode.json` and the TUI registration from `tui.json`. Dropping one side disables that half of the plugin without touching the other.

### OpenCode GA (2.x)

Use **the same** `@cortexkit/opencode-antigravity-auth` package. It ships both GA server and TUI entries. The repository's [pinned host input](packages/e2e-tests/docker/ga-binary-pin.json) is OpenCode `2.0.22`; the [GA harness](packages/e2e-tests/src/opencode-ga-harness.ts) registers an absolute plugin **directory** in `opencode.json`'s plural `plugins` array and colocates `server`/`tui` wrappers importing the public package entries.

The shipped `server.js`/`tui.js` forwarders support registering the installed package's absolute directory in `plugins`, as shown below:

```jsonc
{
  "plugins": ["/absolute/path/to/node_modules/@cortexkit/opencode-antigravity-auth"]
}
```

The package attaches its Antigravity catalog to the host's `google` provider, so the host must expose one. OpenCode 2.0.22 shipped a `google` provider by default; hosts that do not (for example later 2.x builds whose catalog omits it until configured) register nothing until `providers.google` exists. Declare it alongside the plugin:

```jsonc
{
  "plugins": ["/absolute/path/to/node_modules/@cortexkit/opencode-antigravity-auth"],
  "providers": {
    "google": {
      "settings": {
        "baseURL": "https://generativelanguage.googleapis.com/v1beta",
        "apiKey": "cortexkit-antigravity-local"
      }
    }
  }
}
```

The `apiKey` and `baseURL` are placeholders: the adapter rewrites and authenticates every request for its models on the loopback bridge before egress. Do not reuse the harness's synthetic key or mock `baseURL`. The directory example follows the shipped forwarders, not a verified GA npm-installer command. The pinned harness uses an instrumented wrapper directory; direct npm-spec registration/installer syntax is not established here. Consult the matching host's install/config documentation rather than assuming V1's `opencode plugin` or `tui.json` behavior. Do not copy the harness's synthetic Google API key or mock `baseURL` into a real config. The harness's default fixture config has no user model map; no copied model-map requirement is established. Models are served under `google/…`, and the package supplies the Antigravity catalog.

### OpenCode from this checkout (contributors)

Link the package into your local OpenCode config so the working-tree version is used:

```bash
bun install --frozen-lockfile                # at repo root
bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
bun run build                                # core -> unified opencode -> pi
bun run --cwd packages/opencode smoke:tui    # smoke-test the bundled TUI
```

Use an isolated config/database if you run a host from source; never point source probes at your everyday host profile. Register the complete built package's public server/TUI entries using the matching host's config surface above. Copying only `dist/` omits the top-level directory forwarders and `src/tui/entry.mjs` loader.

### Pi

```bash
pi install npm:@cortexkit/pi-antigravity-auth
pi                                                # interactive
/login google                         # OAuth
```

Pi's extension loader discovers the package's `pi.extensions` field and registers the provider automatically; no manual wiring required.

### Standalone CLI

The `antigravity-auth` bin lives inside the OpenCode package; no separate install is needed:

```bash
npx -y @cortexkit/opencode-antigravity-auth login        # OAuth flow, no plugin
npx -y @cortexkit/opencode-antigravity-auth list         # print accounts
npx -y @cortexkit/opencode-antigravity-auth quota        # live quota snapshot
npx -y @cortexkit/opencode-antigravity-auth quota --refresh --json
```

In local mode, the CLI and both OpenCode adapters use the same shared account store. Initialize or migrate it before login; the old `antigravity-accounts.json` pool is retired by migration and is no longer the active writer target.

### Major upgrades: migration and rollback

This guide describes the current source tree, not a claim that an unreleased major version is available on npm. Use `antigravity-auth` from the **build you are upgrading to**, whose `--help` lists `init`, `migrate`, and `rollback`; an older installed CLI may not implement them. Below, “new CLI” means that build's CLI.

**Before a major upgrade**, set the top-level `auto_update` field to `false` in the effective `antigravity.json` (merge into existing settings), and ensure project overrides do not re-enable it:

```json
{
  "auto_update": false
}
```

The published v2.2.1 default is `true`; its update check on host restart can advance pinned plugin configs across major versions. A version specifier alone is not an update hold. This precaution disables the existing automatic config update, not the required offline migration. See the [v2.2.1 updater](https://github.com/cortexkit/antigravity-auth/blob/v2.2.1/packages/opencode/src/hooks/auto-update-checker/index.ts) and [schema](https://github.com/cortexkit/antigravity-auth/blob/v2.2.1/packages/opencode/src/plugin/config/schema.ts).

- **Fresh installation:** run `antigravity-auth init` before login. Initialization refuses an existing legacy OpenCode pool.
- **Upgrade an existing legacy OpenCode pool:** stop **every OpenCode and Antigravity process and timer** using that pool, then run `antigravity-auth migrate --offline`. Type `yes` at the stopped-process confirmation prompt. Optional `--yes` skips the prompt but does not make concurrent use safe.
- **Downgrade after migration:** stop every OpenCode and Antigravity process and timer using the pool again, run `antigravity-auth rollback --offline` with the **new CLI**, confirm and wait for success, then install/start the older build. Never run old and new builds concurrently.

Offline rollback exports **current credentials and metadata** from the active store generation into legacy V4 JSON, rather than restoring tokens from the original backup. It refuses an existing/recreated legacy file, a changed rollback snapshot, or credentials/metadata changed during rollback. Do not copy an old snapshot back or recreate the legacy pool. On a refusal, leave hosts stopped and resolve the reported conflict.

Migration and rollback manage the **local OpenCode pool**, not the host's native Google auth slot used to activate the provider, or approved credentials held by the vault. Before changing builds, disconnect vault enrollment via `/antigravity` → Vault in the currently installed plugin or extension; re-login if native credentials cannot be safely restored. Do not assume all native host records will be restored. Pi's native auth file is not the OpenCode pool: **Pi-only users must not run these migration commands on it**. For Pi, change old `google-antigravity/…` model selections to `google/…` and run `/login google`; old credential slots are not automatically moved or overwritten.

The exact CLI options and stopped-process confirmation are in [`packages/opencode/src/cli.ts`](packages/opencode/src/cli.ts); current-credential export and refusal checks are in [`packages/core/src/account-migration.ts`](packages/core/src/account-migration.ts).

## First login

1. Install the intended build and initialize a fresh local store with `antigravity-auth init`, or complete the [offline migration](#major-upgrades-migration-and-rollback) of an existing OpenCode pool before starting the host.
2. For OpenCode: open the Google auth menu and choose **Antigravity (Google OAuth)**, or use Sign in from `/antigravity`.
3. For the CLI: run `antigravity-auth login`. `--project <id>` pins a Google Cloud project before the flow; `--no-browser` prints the URL instead of opening it (useful in headless / SSH sessions — see [Troubleshooting](#troubleshooting)).
4. Approve the consent screen. The browser redirects to `http://localhost:51121/oauth-callback`; the local listener completes the PKCE exchange and persists the account through the active local shared store, not the legacy JSON file. Vault mode uses vault custody instead of the local pool.
5. Verify with `antigravity-auth quota`.

A fresh install may auto-fetch a project ID from the Cloud Code Assist API. If the lookup fails the plugin uses the fallback project (`rising-fact-p41fc`); see [Troubleshooting](#troubleshooting) for choosing your own project during login.

## Models and routing

`packages/core/src/model-registry.ts` is the canonical source of truth. The OpenCode package re-exports it as `getAntigravityOpencodeModelIds()` (consumed by `applyAntigravityProviderCatalog`).

| Family | Header style | Quota group | Routing |
| --- | --- | --- | --- |
| Claude (Opus / Sonnet thinking) | `antigravity` | `claude` | Antigravity only |
| Gemini 3.x / 2.5 (Pro / Flash / Image) | `antigravity` then `gemini-cli` | `gemini-pro`, `gemini-flash` | Antigravity first; `cli_first: true` reverses it |
| GPT-OSS 120B | `antigravity` | `gpt-oss` | Antigravity only |

Header style controls the `User-Agent`, `X-Goog-Api-Client`, and `Client-Metadata` triplets that the request transform attaches. The interceptor picks style per request:

- **Antigravity-first (default):** Gemini requests first try the Antigravity header set; on `429 RESOURCE_EXHAUSTED` they fall back to the Gemini CLI header set.
- **CLI-first (`cli_first: true`):** Gemini requests first try the Gemini CLI header set; on `429` they fall back to Antigravity.
- **Style-fallback (`quota_style_fallback: true`):** Re-sends the SAME request through the other header set when the active pool is rate-limited, consuming tokens from BOTH pools (default off to prevent double-spend across pools). Change the live routing setting from `/antigravity` → Routing.
- **Claude always uses Antigravity** regardless of the toggles.

When all accounts for a given family cool down, the fetch interceptor waits up to `max_rate_limit_wait_seconds` (default `300`) before failing fast.

### Model IDs shipped in the registry

- `antigravity-gemini-4-argon`, `antigravity-gemini-3.8-flash`, `antigravity-gemini-3.5-flash`, `antigravity-gemini-3.1-flash-image`
- `antigravity-claude-sonnet-5-5`, `antigravity-claude-opus-5-5` (low, medium and high effort)

Claude 4.6 routes are retired and refuse requests; they are not aliases for 5.5.
Gemini 3.1 Pro, Gemini 3.6/3.7 Flash and `gemini-pro-agent` were withdrawn by
Antigravity. Their grouped and native tier selectors refuse without redirecting;
historical transcripts remain readable.

Gemini 4 Argon requires **Google AI Ultra**, supports low/medium/high variants
(medium by default), and advertises 1,048,576 context and 65,536 output tokens.
It uses Antigravity only. Its per-model quota is reported independently; weekly
pool attribution is unverified.
- `antigravity-gpt-oss-120b-medium`
- `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash-preview`, `gemini-3-pro-preview`, `gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools` (Gemini CLI namespace)

Legacy `antigravity-gemini-3-flash` style aliases resolve through `MODEL_ALIASES` in the resolver; new model names should be added through the registry, not hand-coded in the transforms. The Transform layer renames old → new automatically.

## Multi-account behavior

In local mode, OpenCode V1 and GA share the account repository at the resolved account path; projects do not create independent pools. After initialization/migration, `antigravity-accounts.json.store.pointer.json` beside the legacy path records the active store directory containing `config.json` and `state.json`. Legacy `antigravity-accounts.json` is an import/export format, not the active writer target. Each local account carries:

- `refreshToken` (stored in plaintext in owner-only files/directories — filesystem permissions are not encryption)
- `email`, `enabled`, `coolingDownUntil`, `cachedQuota`, `healthScore`
- `projectId` (optional; used by Gemini CLI)
- `fingerprintHistory` and `verificationRequired` / `verificationUrl` (used by the verification flow)

Account selection (`account_selection_strategy`):

| Strategy | Behavior |
| --- | --- |
| `sticky` | Use one account until it is rate-limited; preserves Anthropic's prompt cache. Recommended for single-session use. |
| `hybrid` (default) | Token bucket + health score + LRU freshness. Best for most workloads. |
| `round-robin` | Rotate per request. Useful when running many short requests in parallel. |

`pid_offset_enabled` shifts the per-session starting index so different PIDs begin at different accounts — recommended when running multiple parallel subagents and `oh-my-opencode` is installed. Per-request caps: `max_account_switches` (default `10`) bounds how many accounts a single request may try before failing.

`switch_on_first_rate_limit` controls whether the interceptor switches accounts after the first 429 (default on) or retries the same account once first. `default_retry_after_seconds` (60) and `max_backoff_seconds` (60) shape the wait between attempts. `request_jitter_max_ms` adds timing jitter — set to `100–500` to avoid thundering-herd patterns when running many parallel agents.

### Local authority and vault custody

Use `/antigravity` → Vault to request access, select approved vault accounts, or return to local mode. **Local** authority uses the initialized/migrated local repository. **Vault custody** uses vault request credentials and excludes the local pool; unavailable enrollment or vault data does not permit a local fallback. OpenCode 1 needs a saved Google auth entry to load the provider. Once loaded, approved enrollment supplies vault credentials without reading or validating that entry's contents: existing ordinary Google logins and placeholder records from other enrollments remain unchanged. Explicit fresh provider activation refuses to overwrite an occupied Google auth slot. GA vault serving requires the native Google connection created for that enrollment; Pi requires the non-secret Google-slot marker created for that enrollment. Do not hand-edit mode files or copy credentials to bypass a refusal. See [`vault-custody.ts`](packages/opencode/src/plugin/vault-custody.ts), [`auth-loader.ts`](packages/opencode/src/plugin/auth-loader.ts), and [`vault-activation.ts`](packages/opencode/src/plugin/vault-activation.ts).

## Quota semantics and killswitch

Each account carries a per-quota-group `cachedQuota` (`{ remainingFraction, resetTime }` for `claude`, `gemini-pro`, `gemini-flash`, `gpt-oss`). The quota manager refreshes them opportunistically:

- **Periodic refresh:** every `quota_refresh_interval_minutes` after a successful request (default `30`; the schema migrated from 15 to 30 for v2 — set to `0` to disable).
- **TTL:** `soft_quota_cache_ttl_minutes = "auto"` resolves to `max(2 × refresh_interval, 10)`. While the cache is fresh the threshold check is authoritative.
- **Stale-TTL fail-open:** when the cache is older than the TTL OR for an account the plugin has never refreshed, the account is allowed through the soft-quota check. A cold start can never deadlock on the first dial.
- **Soft-quota threshold:** `soft_quota_threshold_percent` (default `80`) — accounts with usage ≥ threshold are skipped as if rate-limited.
- **All-exhausted:** when every account exceeds the threshold the interceptor waits for the earliest reset time, then waits up to `max_rate_limit_wait_seconds` before failing fast.
- **Proactive rotation:** after a successful request, if the active account's remaining quota drops below `proactive_rotation_threshold_percent` (default `20`) the next request is dispatched from a warm-cache account to avoid a forced 429 mid-conversation.

The **operator killswitch** (`/antigravity` → Limits) excludes accounts below configured remaining-quota floors and rejects a request if no eligible account remains:

- `enabled` (default `false`) — master switch.
- `minimum_remaining_percent` — global threshold; accounts whose freshest cached quota is ≤ this are excluded.
- `accounts` — per-account override keyed by `sha256(refreshToken).slice(0,12)`. The key never appears outside the config file; no raw token is ever written, logged, or sent over RPC.
- **Fail-open on stale/missing cache:** a candidate with no fresh cached quota (TTL `5min` by default) is allowed through so the first dispatch after a cold start cannot deadlock.
- **All-killed error:** when the entire pool is excluded, the interceptor throws `AntigravityKillswitchError` carrying a per-account summary so the host can surface a single, structured error rather than a synthetic body.

Both filters are evaluated *before* the token bucket / health score pick, so the operator has the last word even on a healthy pool.

## OpenCode sidebar and slash commands

The V1 sidebar is **read-only** and polls `sidebar-state.json` every two seconds. The file contract version is `1`; the loader falls back to `DEFAULT_SIDEBAR_STATE` on malformed JSON or unknown versions. GA also ships a sidebar and menu, but polls location-scoped snapshots through the host's native RPC client rather than this V1 file protocol; see [`ga/tui/host-ga.tsx`](packages/opencode/src/ga/tui/host-ga.tsx).

### Slash commands

There is one public command: **`/antigravity`**. It opens the shared menu rather than accepting the old per-feature slash commands or their arguments. V1 registration is in [`plugin/catalog.ts`](packages/opencode/src/plugin/catalog.ts); menu construction is in [`plugin/commands.ts`](packages/opencode/src/plugin/commands.ts), with TUI rendering in [`tui/command-dialogs.tsx`](packages/opencode/src/tui/command-dialogs.tsx).

| Menu section | Use |
| --- | --- |
| Accounts / Sign in | Inspect, enable/disable, remove, or reauthorize local accounts; start Google OAuth. Availability depends on the active source. |
| Quota | Inspect readings or check quota now. |
| Routing | Change live routing settings, including CLI-first and style fallback. |
| Limits | Configure the killswitch and account floors. |
| Diagnostics | Adjust logging and wire-dump capture. Treat dumps as sensitive. |
| Vault | Request enrollment, choose approved vault accounts, or disconnect to return to local authority. |

### Sidebar contract

`getSidebarStateFile()` resolves to `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` (or `~/.local/state/...`). Override with `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE`. The file carries:

- `version: 1`, `checkedAt` (epoch ms), `accounts[]`, `activeRouting` (per-session map, pruned to 24h / 100 entries), `routingAuthoritative`, optional `quotaBackoffUntil` and `lastError`.

Every writer follows the same recipe (serialize through `sidebarWriteChain` → acquire fenced file lock with `2s` retry → re-read and merge → atomic rename mode `0600`). If a cross-process lock holder does not release within `SIDEBAR_LOCK_TIMEOUT_MS` (`2_000` ms) the writer surfaces `SidebarStateLockContentionError`; the caller decides whether to surface a toast, drop the write, or retry next tick.

## Standalone CLI

`antigravity-auth` (the bin inside `@cortexkit/opencode-antigravity-auth`) accepts the commands listed below, plus `--help`. The parser rejects unsupported commands/options with `exit 2`.

```bash
antigravity-auth login [--project <id>] [--no-browser]
antigravity-auth list [--json]
antigravity-auth quota [--json] [--refresh]
antigravity-auth init
antigravity-auth migrate --offline [--yes]
antigravity-auth rollback --offline [--yes]
```

- `login` performs the same PKCE + local callback flow as the plugin. `--project <id>` pins the project ID before the request; `--no-browser` prints the URL instead of opening it. The CLI auto-detects a headless session (`SSH_*`, `OPENCODE_HEADLESS=1`) and combines that with `--no-browser` for you.
- `list` prints a fixed-width table (`INDEX`, `EMAIL`, `STATUS`) where `STATUS` is `active`, `disabled`, `ineligible`, or `verification-required`. `--json` emits the same data as JSON.
- `quota` prints `ACCOUNT`, `STATUS`, `GROUP`, `REMAINING`, `RESET`. With `--refresh` it forces a live refresh; with `--json` it emits the same array as JSON. Exit code is `0` on success, `1` on a thrown error, and `2` on a parse failure.

`init`, `migrate`, and `rollback` change which account store is active; migration/rollback require all pool users to be stopped. See [Major upgrades](#major-upgrades-migration-and-rollback) before using them. Login persists through the same local shared store that the OpenCode adapters use. `list` and `quota` read accounts; they are not substitutes for initialization or migration.

## Pi usage

```bash
pi install npm:@cortexkit/pi-antigravity-auth
pi
/login google                    # OAuth flow
```

The Pi extension registers the `google` provider through `pi.extensions`; select models as `google/antigravity-…`. Both host adapters delegate transport and transforms to core, but Pi local mode uses one credential in Pi's native `auth.json` Google slot, **not** the OpenCode pool. Vault mode can list/select approved vault accounts and serves one at a time, without local rotation, recorded quota gating, killswitch, or operator settings. Use `/antigravity` for vault setup. Vault custody backs up the native Google login and replaces Pi's `auth.json` Google slot with a non-secret placeholder; disconnect only restores a saved login when safe and refuses to overwrite a slot changed by another process. Re-login may be needed. See [Pi's upgrade notes](packages/pi/README.md#major-upgrades-and-downgrade) for the old `google-antigravity` provider ID.

## Configuration reference

`packages/opencode/src/plugin/config/schema.ts` defines `AntigravityConfigSchema` (Zod); the generated JSON Schema ships at `packages/opencode/assets/antigravity.schema.json`. Every nested config property, default, and environment override is documented below. **Project** settings (`.opencode/antigravity.json`) override **user** settings (`~/.config/opencode/antigravity.json`), which in turn override env vars.

| Path | Type | Default | Env override | Effect |
| --- | --- | --- | --- | --- |
| `quiet_mode` | bool | `false` | `OPENCODE_ANTIGRAVITY_QUIET=1` | Suppress rate-limit and account-switching toasts; recovery toasts always shown. |
| `toast_scope` | `root_only` \| `all` | `root_only` | `OPENCODE_ANTIGRAVITY_TOAST_SCOPE=all` | `root_only` silences subagents; `all` is verbose. |
| `debug` | bool | `false` | `OPENCODE_ANTIGRAVITY_DEBUG=1` | File logging to `~/.config/opencode/antigravity-logs/`. |
| `debug_tui` | bool | `false` | `OPENCODE_ANTIGRAVITY_DEBUG_TUI=1` | TUI log-panel verbosity (independent of `debug`). |
| `log_dir` | string | XDG-derived | `OPENCODE_ANTIGRAVITY_LOG_DIR=…` | Custom debug-log directory. |
| `keep_thinking` | bool | `false` | `OPENCODE_ANTIGRAVITY_KEEP_THINKING=1` | Preserve Claude thinking blocks (signature caching); can destabilize models. |
| `thinking_warmup` | bool | `false` | `OPENCODE_ANTIGRAVITY_THINKING_WARMUP=1` | Costly warmup probe at session start. |
| `cache_warmup_on_switch` | bool | `true` | `OPENCODE_ANTIGRAVITY_CACHE_WARMUP_ON_SWITCH=1` | Cache-seeding probe after account rotation. |
| `session_recovery` | bool | `true` | — | Auto-recover from `tool_result_missing` errors. |
| `auto_resume` | bool | `true` | — | Send `resume_text` after recovery. |
| `resume_text` | string | `"continue"` | — | What to send on auto-resume. |
| `signature_cache.enabled` | bool | `true` | — | Disk-persist thinking-block signatures. |
| `signature_cache.memory_ttl_seconds` | number (60-86400) | `3600` | — | In-memory signature TTL. |
| `signature_cache.disk_ttl_seconds` | number (3600-604800) | `172800` | — | On-disk signature TTL. |
| `signature_cache.write_interval_seconds` | number (10-600) | `60` | — | Background flush interval. |
| `empty_response_max_attempts` | number (1-10) | `2` | — | Retries when Antigravity returns no candidates. |
| `empty_response_retry_delay_ms` | number (500-10000) | `2000` | — | Delay between empty-response retries. |
| `tool_id_recovery` | bool | `true` | — | Match orphan tool IDs by name. |
| `claude_tool_hardening` | bool | `true` | — | Inject strict tool-usage rules for Claude. |
| `claude_prompt_auto_caching` | bool | `false` | — | Add top-level `cache_control` when absent. |
| `proactive_token_refresh` | bool | `true` | — | Refresh access tokens before expiry. |
| `proactive_refresh_buffer_seconds` | number (60-7200) | `1800` | — | Pre-expiry refresh window. |
| `proactive_refresh_check_interval_seconds` | number (30-1800) | `300` | — | Refresh-check cadence. |
| `max_rate_limit_wait_seconds` | number (0-3600) | `300` | — | Cap on queueing wait; `0` waits indefinitely. |
| `quota_fallback` | bool | `false` | — | **Deprecated**, ignored at runtime; kept for back-compat. |
| `cli_first` | bool | `false` | — | CLI header first instead of Antigravity for Gemini. |
| `account_selection_strategy` | `sticky` \| `round-robin` \| `hybrid` | `hybrid` | `OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY` | Account picker. |
| `pid_offset_enabled` | bool | `false` | `OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED=1` | Per-PID starting account index. |
| `switch_on_first_rate_limit` | bool | `true` | — | Switch immediately on first 429. |
| `max_account_switches` | number (0-500) | `10` | `OPENCODE_ANTIGRAVITY_MAX_ACCOUNT_SWITCHES` | Account-switch budget per request. |
| `quota_style_fallback` | bool | `false` | `OPENCODE_ANTIGRAVITY_QUOTA_STYLE_FALLBACK` | Re-send through the other header pool on exhaustion. |
| `scheduling_mode` | `cache_first` \| `balance` \| `performance_first` | `cache_first` | `OPENCODE_ANTIGRAVITY_SCHEDULING_MODE` | Rate-limit scheduling strategy. |
| `max_cache_first_wait_seconds` | number (5-300) | `60` | — | Wait cap when `scheduling_mode=cache_first`. |
| `failure_ttl_seconds` | number (60-7200) | `3600` | — | Failure-count reset window. |
| `default_retry_after_seconds` | number (1-300) | `60` | — | Fallback retry delay when 429 omits `Retry-After`. |
| `max_backoff_seconds` | number (5-300) | `60` | — | Exponential backoff cap. |
| `request_jitter_max_ms` | number (0-5000) | `0` | — | Random pre-request delay to break cadence. |
| `switch_account_delay_ms` | number (0-10000) | `500` | — | Delay before switching accounts. |
| `soft_quota_threshold_percent` | number (1-100) | `80` | — | Skip accounts above this usage %; `100` disables. |
| `quota_refresh_interval_minutes` | number (0-120) | `30` | — | Background refresh cadence; `0` disables. |
| `soft_quota_cache_ttl_minutes` | `auto` \| number (1-120) | `"auto"` | — | TTL for cached quota. `auto` = `max(2 × refresh, 10)` minutes. |
| `proactive_rotation_threshold_percent` | number (0-100) | `20` | `OPENCODE_ANTIGRAVITY_PROACTIVE_ROTATION_THRESHOLD` | Proactive account switcher; `0` disables. |
| `health_score.initial` | number (0-100) | `70` | — | Health-score starting value. |
| `health_score.success_reward` | number (0-10) | `1` | — | Score gain per success. |
| `health_score.rate_limit_penalty` | number (-50..0) | `-10` | — | Penalty per rate limit. |
| `health_score.failure_penalty` | number (-100..0) | `-20` | — | Penalty per failure. |
| `health_score.recovery_rate_per_hour` | number (0-20) | `2` | — | Slow heal over time. |
| `health_score.min_usable` | number (0-100) | `50` | — | Account is gated below this. |
| `health_score.max_score` | number (50-100) | `100` | — | Score ceiling. |
| `token_bucket.max_tokens` | number (1-1000) | `50` | — | Max concurrent budget. |
| `token_bucket.regeneration_rate_per_minute` | number (0.1-60) | `6` | — | Rate budget refills. |
| `token_bucket.initial_tokens` | number (1-1000) | `50` | — | Starting budget. |
| `auto_update` | bool | `true` | — | Background npm update check + auto-pin. |
| `operator.routing.cli_first` | bool | `false` | — | Live override of `cli_first` (from `/antigravity` → Routing). |
| `operator.routing.quota_style_fallback` | bool | `false` | — | Live override of `quota_style_fallback`. |
| `operator.killswitch.enabled` | bool | `false` | — | Master killswitch. |
| `operator.killswitch.minimum_remaining_percent` | number (0-100) | `5` | — | Global hard block threshold. |
| `operator.killswitch.accounts` | record<string, number> | unset | — | Optional per-account override (key = `sha256(refreshToken).slice(0,12)`). Absent by default; falls back to `minimum_remaining_percent`. |
| `operator.log_level` | `error` \| `warn` \| `info` \| `debug` \| `trace` | `"info"` | — | Runtime log-level filter (`/antigravity` → Diagnostics). |

Raw generative AGY sends and standard-fetch callers use different timeout scopes (see [State, cache, log, RPC, and dump files](#state-cache-log-rpc-and-dump-files)).

## State, cache, log, RPC, and dump files

| Purpose | Path | Mode | Notes |
| --- | --- | --- | --- |
| Local account store | Beside the resolved legacy path: `antigravity-accounts.json.store.pointer.json` selects `antigravity-accounts.json.store.<id>.generation/` | Owner-only | Active `config.json` / `state.json`, migration journal and protected transfer/backup files. Shared by OpenCode V1/GA, not Pi native auth. |
| Legacy pool | `$OPENCODE_CONFIG_DIR/antigravity-accounts.json` (default `~/.config/opencode/antigravity-accounts.json`) | `0600` | Pre-migration input / successful rollback output (V4); not the active store after migration. |
| Plugin config | `antigravity.json` (project `.opencode/`, then user) | `0600` | The Zod-validated config above; `OpenCodeConfigDir` environment variable override. |
| Debug logs | `antigravity-logs/<file>.log` (or `log_dir`) | `0600` | Created by the debug subsystem when `debug` is on. |
| V1 sidebar state | `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` (override `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE`) | `0600` | Versioned contract `1`; pruned to 24h/100 entries. |
| V1 RPC port file | `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` (override `ANTIGRAVITY_AUTH_RPC_DIR`) | `0600` dir `0700` | Loopback HTTP token bearer for the TUI. |
| Signature cache | `signature-cache-disk-<hash>.json` under `keep_thinking` path | `0600` | 2-day default TTL. |
| Wire dump | `antigravity-logs/dumps/` | `0600` | Sensitive — see [Security and redaction](#security-and-redaction). |

The raw generative AGY path uses [`agy-transport.ts`](packages/core/src/agy-transport.ts), with a default **`180_000` ms (3 min) response-header wait** and a separate **`180_000` ms no-body-data idle timeout**. Neither is a total streaming deadline. The standard-fetch helper [`fetchWithActiveTimeout`](packages/core/src/fetch-timeout.ts), used by other callers including Gemini CLI-style sends, defaults to **`15_000` ms until headers arrive**; it removes that timeout at headers but keeps caller cancellation connected until the body ends, errors, or is canceled. Do not interpret the helper's 15s budget as the raw AGY transport's limit.

The **V1 RPC** between the TUI and [`rpc-server.ts`](packages/opencode/src/rpc/rpc-server.ts) uses a per-PID port file (`$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json`). The TUI reads a live entry and exchanges shared menu requests/notifications with the loopback server using a `Bearer <token>` header. GA has its own server/TUI integration; do not treat the V1 port-file protocol as a host config requirement.

**V1 disposal:** `dispose()` marks the plugin closing synchronously, blocking new admission. It aborts and waits for live and retiring requests and token-refresh shutdown before releasing their account managers, then closes the signature cache and clears session/fetch state. Registered producers (components that enqueue sidebar writes) stop first so the sidebar-write queue can settle; registered consumers (RPC server/file logger) stop after that drain. This orders shutdown and waits for queued work to settle; it does not guarantee every attempted write succeeded or the terminal rendered a final snapshot. See [`lifecycle.ts`](packages/opencode/src/plugin/lifecycle.ts).

## Security and redaction

- Local credentials live in the active shared account-store generation; legacy JSON is only the pre-migration/rollback format. Keep the pointer, generation, backups, and transfer files private. Vault custody and native host auth slots are separate credential locations; none belong in Git or issue reports.
- The sidebar state file carries only `id`/`label`/`enabled`/`health`/`current`/`cooldownUntil`/`quota` — never a refresh token, access token, project ID, fingerprint, or other credential-shaped field. `redactAccountForSidebar` is the single conversion point.
- The killswitch `accounts` field is keyed by `sha256(refreshToken).slice(0,12)` so the raw token never lands in the config, sidebar, RPC payload, or apply response. The hash is deterministic per token but irreversible.
- `debug` file logs MAY include request headers and response bodies for the model under test. Do not enable `debug` on a session that handles personally identifiable data. The wire dump produces a raw request/response pair; keep it out of issue reports. Operators can route logs to an encrypted directory via `log_dir`.
- OAuth client ID and secret (`packages/core/src/constants.ts`) are part of the public Antigravity CLI client and are not sensitive on their own; they are not a credential pair.
- This README and project tree never contain OAuth tokens, bearer tokens, account file contents, or request/response dumps.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| OAuth callback hangs | The browser can't reach `localhost:51121` (SSH, remote dev, Docker, WSL2) | `antigravity-auth login --no-browser`, copy the URL into a browser that can reach the host; or `ssh -L 51121:localhost:51121 user@remote` to forward the callback port. |
| Safari shows "Safari can't open the page" | HTTPS-Only mode blocks `http://localhost` callback | Use Chrome or Firefox; or temporarily disable HTTPS-Only mode (Safari → Settings → Privacy) during login. |
| `Address already in use :51121` | Stale OAuth listener from a previous run | `lsof -i :51121` (or `netstat -ano \| findstr :51121` on Windows), kill the listed PID, retry. |
| `Permission 'cloudaicompanion.companions.generateChat' denied` (`rising-fact-p41fc` fallback project) | Antigravity returned no project ID | Enable the `Gemini for Google Cloud API` (`cloudaicompanion.googleapis.com`) on your project and authenticate locally with `antigravity-auth login --project <id>`. Do not hand-edit retired pool JSON; vault accounts require the vault operator's help. |
| All accounts show `cooling-down` (quota available) | The threshold filter is excluding the entire pool | Lower `soft_quota_threshold_percent`, or wait for `soft_quota_cache_ttl_minutes` to expire: expired readings are treated as unknown rather than excluding accounts. Check quota via `/antigravity` → Quota. |
| Sidebar shows "Awaiting Antigravity state" forever | The state file is missing or unreadable | Confirm `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` exists and is `0600`; verify the running plugin's user can write to the directory. |
| `Antigravity RPC server is not available` from the V1 TUI | No server has bound a port | Confirm the server plugin and `/antigravity` command loaded; the RPC dir (`ANTIGRAVITY_AUTH_RPC_DIR` or its default) must be writable. |
| TUI shows "Awaiting antigravity bundle" / spawn fails | Generated TUI trees are missing | For a source checkout, use Bun 1.4.2 and `bun run --cwd packages/opencode build:tui`; check the matching `src/tui-compiled/` or `src/tui-ga-compiled/` tree. For an npm install, reinstall the intended build rather than copying partial generated files. |
| `quota_backoff` recovered slowly | `quota_refresh_interval_minutes` is too high | Lower it; or use `/antigravity` → Quota to check now. |
| Malformed JSON in `antigravity.json` | Invalid escape / trailing comma | `bun -e 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.config/opencode/antigravity.json","utf8"))'`; the schema reference in the file (`$schema: assets/antigravity.schema.json`) drives editor IntelliSense. |
| `Invalid signature in thinking block` errors | `keep_thinking` left on through a Claude version bump | Set `keep_thinking: false`; or clear `signature_cache.disk_ttl_seconds` and restart. The `SKIP_THOUGHT_SIGNATURE` sentinel is injected automatically for known-bad signatures. |
| Pre-`v2` inline quota helper script | Removed in `v2` — the script no longer ships | Use `antigravity-auth quota [--refresh] [--json]`; the npm-installed `antigravity-auth` binary replaces it. |
| Debug log location unknown | `debug` toggled off, or `log_dir` misconfigured | `debug: true` + `log_dir: "/secure/path"`; logs sit under `antigravity-logs/` by default and contain request/response bodies — handle with care. |

When none of the above resolves the issue, stop the host and inspect the error shown by `/antigravity` or the CLI before changing credentials, especially initialization, migration, or vault-conflict errors. Do not delete the legacy file, pointer, generation, or custody files as a generic reset: that can destroy migration/rollback evidence or a saved native login. Use account actions or provider re-login once the active source is healthy; include only redacted errors in support requests.

## Development workflow

This monorepo uses Bun for contribution commands; consumers install through npm. Keep both in mind when you write a script — npm users run `npx @cortexkit/opencode-antigravity-auth`, contributors run `bun`.

```bash
# at repo root
bun install --frozen-lockfile                       # sync workspace
bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
bun run build                                       # core -> opencode -> pi
bun run typecheck                                   # tsc across the workspace + scripts tsconfig
bun run test                                        # isolated source selectors from package.json
bun run test:e2e                                    # plugin-flow + cli-flow + rpc-tui-flow
bun run test:e2e:models                             # live Antigravity model inventory (gated by CI)
bun run test:e2e:regression                         # cross-model + Gemini CLI regression
bun run --cwd packages/opencode smoke:tui           # bundle + spawn the TUI precompiled tree against the npm package shape
bun run format:check && bun run lint                # Biome format + lint (no auto-fix in CI)
```

The TUI side ships V1 and GA compiled/raw JSX trees selected by the public loader. `bun run build:tui` runs the package's Bun build script with the private compiler inputs; use **Bun 1.4.2** and install `tools/common-auth-build` from its frozen lockfile first. Generated trees are rebuilt by the package build. `bun run --cwd packages/opencode smoke:tui` installs fresh tarballs in a scratch consumer and checks server/TUI resolution; it is not a substitute for running a host against an isolated profile.

`bun run dev` is a V1 development helper: it builds core/OpenCode, links `.opencode/plugins/antigravity-auth.js` to the built OpenCode `dist/index.js`, and starts watchers. `bun run dev:clean` removes that link. It is not a GA installer or a Pi development profile; use isolated host configuration for source work. See [`scripts/dev.ts`](scripts/dev.ts).

Pre-commit hooks (`lefthook.yml`) run Biome on changed code/config files; CI re-runs the full `bun run format:check && bun run lint` gate. Biome does not validate Markdown.

## Test strategy

The repo splits tests by what they exercise and what they need:

| Scope | Tooling | Network | How to run |
| --- | --- | --- | --- |
| Unit (deterministic) | Isolated core/OpenCode/Pi source and selected repository tests; exact selectors in `package.json` | No | `bun run test` |
| Black-box e2e (deterministic) | Mock Antigravity server, harness runner (`packages/e2e-tests/`) | No | `bun run test:e2e` |
| Live model inventory | `bun run test:e2e:models` (uses `test-models.ts`) | Yes — gated by CI label | `bun run test:e2e:models` |
| Cross-model regression | `bun run test:e2e:regression` (`script/test-regression.ts`) | Yes | `bun run test:e2e:regression` |
| TUI smoke | `bun run --cwd packages/opencode smoke:tui` (build-tarball install + spawn) | No | `bun run --cwd packages/opencode smoke:tui` |

Deterministic tests run everywhere (including in CI). The live `test:e2e:models` and `test:e2e:regression` flows are gated by label because they hit real Google infrastructure. They live in `packages/opencode/script/` (TypeScript + shell launchers) and use `anthropic-agy` style fixtures kept under `test-fixtures/`.

## Release process

Maintainers pass the chosen semver to [`scripts/release.sh`](scripts/release.sh); `--dry` previews version synchronization without committing/pushing. Do not treat the source guide as an announcement that the next major version has been published.

The script enforces semver, refuses to run on a dirty tree, and requires confirmation on a non-`main`/`master` branch. After toolchain/embedding preflight it runs `bun run typecheck` → `bun run test` → `bun run build`, then synchronizes versions before committing/tagging/pushing. [`scripts/version-sync.mjs`](scripts/version-sync.mjs) sets the three publishable package versions and the adapters' core dependency pins; it does not rewrite every workspace. The GitHub workflow performs the actual publish.

The `Release` workflow (`.github/workflows/release.yml`) runs on tag push (or `workflow_dispatch`) and:

1. **Test** job — checkout the tag ref, prepare the pinned toolchains, then run the embedding, typecheck, build, TUI smoke, isolated source-test, e2e, format, and lint gates. Use `bun run test`, not bare root `bun test`; see the workflow for exact selectors.
2. **Publish** job — matrixed across core, unified OpenCode, and Pi, one package at a time (`max-parallel: 1`). Each package job obtains its own OIDC token; `npm Trusted Publishing` (`npm publish --workspace … --access public --provenance`) handles the upload. The job skips a package if its npm version is already published.
3. **GitHub Release** job — `softprops/action-gh-release@v2` creates the GitHub release with `generate_release_notes: true`.

The publish job checks out the selected tag/ref, derives the version from the dispatch input or tag name (stripping `v`), runs `node scripts/version-sync.mjs` with that version, then builds and publishes. Thus GitHub synchronizes the checked-out manifests before publishing; it does not require their original versions to already equal the tag. See [the release workflow](.github/workflows/release.yml).

CI (`.github/workflows/ci.yml`) reuses the same typecheck → build → smoke → test → e2e → format → lint chain on every push to `main` and on every pull request. The `issue-triage.yml` workflow handles GitHub-issue routing.

## Architecture and structure links

- [ARCHITECTURE.md](ARCHITECTURE.md) — architecture overview of core, unified OpenCode, and Pi.
- [STRUCTURE.md](STRUCTURE.md) — file-system map of the monorepo.
- [packages/opencode/ARCHITECTURE.md](packages/opencode/ARCHITECTURE.md) — OpenCode plugin architecture in detail.
- [packages/opencode/STRUCTURE.md](packages/opencode/STRUCTURE.md) — OpenCode package file-system map.
- [packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md) — version history.
- [packages/opencode/docs/CONFIGURATION.md](packages/opencode/docs/CONFIGURATION.md) — detailed option walkthrough.
- [packages/opencode/docs/MULTI-ACCOUNT.md](packages/opencode/docs/MULTI-ACCOUNT.md) — load balancing, dual quota pools, account storage.
- [packages/opencode/docs/MODEL-VARIANTS.md](packages/opencode/docs/MODEL-VARIANTS.md) — variants, thinking budgets, model selection.
- [packages/opencode/docs/TROUBLESHOOTING.md](packages/opencode/docs/TROUBLESHOOTING.md) — long-form troubleshooting with platform-specific commands.
- [packages/opencode/docs/ANTIGRAVITY_API_SPEC.md](packages/opencode/docs/ANTIGRAVITY_API_SPEC.md) — Antigravity API reference.
- [packages/opencode/assets/antigravity.schema.json](packages/opencode/assets/antigravity.schema.json) — generated JSON Schema for IDE validation.

## License

MIT. See [LICENSE](LICENSE).
