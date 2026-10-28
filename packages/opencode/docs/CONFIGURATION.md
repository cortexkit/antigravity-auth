# Configuration

This guide covers setup, manual registration, and plugin settings. V1 means OpenCode 1; GA means OpenCode 2 general availability. For native GA login and request ownership, see [OpenCode 2](OPENCODE-2.md). Before a major upgrade, follow the [auto-update hold and offline migration](MIGRATION.md).

## Guided setup

Quit all OpenCode and Pi processes, then run:

```bash
npx @cortexkit/opencode-antigravity-auth setup
```

Setup detects installed hosts, uses local Google sign-in or optional approved Claustrum vault enrollment, writes versioned OpenCode registrations without replacing unrelated settings, or runs Pi's package installer. An existing legacy JSON account pool needs [offline migration](MIGRATION.md) into the shared store before use; Pi's native `auth.json` is not an OpenCode pool.

```bash
npx @cortexkit/opencode-antigravity-auth setup --dry-run --opencode=1 --no-claustrum
npx @cortexkit/opencode-antigravity-auth setup --yes --opencode=2 --no-claustrum
```

- `--opencode=1|2|both` resolves ambiguous host detection.
- `--no-claustrum` skips vault enrollment; `--claustrum` requires the running vault and operator approval using the printed request ID and `ck auth enroll approve` command.
- `--login` requests a new local OAuth login for OpenCode 1 or Pi instead of reuse. OpenCode 2 defers local OAuth to `opencode auth login`: select Google, then **Google (antigravity-auth pool, browser)** as the login method, and finally select the saved **Antigravity** connection. Setup does not complete that connection; stop if the method is absent. Do not substitute a real API key or the vault method for pool login.
- For approved OpenCode 2 vault mode, choose **Use approved Antigravity vault** through the same native login route. With `--opencode=both`, OpenCode 1's `auth.json` slot does not complete the separate OpenCode 2 step.
- `--yes` accepts host selection, not unsafe concurrent use or OAuth/vault approval. Start the configured host afterward and open `/antigravity`.

Pi's native login follows `PI_CODING_AGENT_DIR` (including `~` expansion), or `~/.pi/agent` by default. `PI_AGENT_DIR` and `PI_ANTIGRAVITY_AUTH_FILE` retain their plugin account/vault-state roles; they do not redirect native login. A different extension-state folder must not be mistaken for the native `auth.json` folder. Vault activation saves the native Google login in owner-only `antigravity-auth-vault/google-login-stash.json`, beside the extension's configured account file, before replacing the native login with a non-secret marker.

Real-run preflight runs **only after the stopped-host process fence**. The unchanged public credential and enrollment-state readers may create missing auth/state parent directories owned by the current user, acquire/release Pi native-slot and saved-login-stash locks, and tighten Windows auth, stash, and enrollment-authority-file DACLs (access permissions) to owner-only. `PrivateFileMigration` warnings stay visible. These metadata effects never change contents, ownership, permissions on existing ancestors, account authority, or configuration. Preflight is advisory: `enterVault` (vault activation) and each operation's fresh authority/slot checks remain authoritative, so revoked approval, changed native credentials, or inconsistent backups still refuse.

**Dry-run invokes none of those credential readers, locks, or repairs and writes nothing.** On macOS/Linux the stopped-host detector cannot reliably recognize an unquoted Node/Bun script path containing spaces in `ps` (for example `node /tmp/owned host/opencode`). Absence of a refusal is not proof the host exited; close and confirm all such instances manually. `--yes` does not override this requirement.

## OpenCode 1 manual registration

For V1 hosts exposing `opencode plugin`, check the matching host's help before using:

```bash
opencode plugin @cortexkit/opencode-antigravity-auth@latest
```

Inspect the resulting registrations. V1 has independent server and TUI files; merge these examples into existing configuration:

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

Initialize a fresh local store or complete [offline migration](MIGRATION.md) before starting V1. Choose **Antigravity (Google OAuth)** in the Google provider login, or Sign in from `/antigravity`, then verify with `antigravity-auth quota`. The callback is `http://localhost:51121/oauth-callback`. See [commands](COMMANDS.md) for project selection and remote/headless login.

Do not reuse this singular `plugin`/`tui.json` recipe for GA; [OpenCode 2](OPENCODE-2.md#install-and-register) uses a different host surface. Pi installs with `pi install npm:@cortexkit/pi-antigravity-auth`, discovers the extension via `pi.extensions`, and logs in through `/login google`.

## Plugin configuration

Create `~/.config/opencode/antigravity.json` (or `.opencode/antigravity.json` in project root):

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json"
}
```

Most settings have sensible defaults — only configure what you need.

Project settings override user settings. `OPENCODE_CONFIG_DIR` overrides the user configuration directory; otherwise it follows `XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`). The [Zod schema](../src/plugin/config/schema.ts) is authoritative; the [generated JSON Schema](../assets/antigravity.schema.json) supplies editor validation.

---

## Quick Start

**Minimal config (recommended for most users):**

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json"
}
```

**With web search enabled:**

The plugin provides a `google_search` tool that the model can call to search the web. No configuration is needed - the tool is always available.

---

## Model Behavior

Settings that affect how the model thinks and responds.

| Option | Default | Description |
|--------|---------|-------------|
| `keep_thinking` | `false` | Preserve Claude's thinking blocks across turns. **Warning:** enabling may degrade model stability. |
| `session_recovery` | `true` | Auto-recover from tool_result_missing errors |
| `auto_resume` | `true` | Auto-send resume prompt after recovery |
| `resume_text` | `"continue"` | Text to send when auto-resuming |

> **Note:** The `web_search` config options are deprecated. Google Search is now implemented as a dedicated `google_search` tool that the model can call explicitly.

### About `keep_thinking`

When `true`, Claude's thinking blocks are preserved in conversation history:
- **Pros:** Model remembers its reasoning, more coherent across turns
- **Cons:** May degrade model stability, slightly larger context

When `false` (default), thinking is stripped:
- **Pros:** More stable model behavior, smaller context
- **Cons:** Model may be less coherent, forgets previous reasoning

---

## Account Rotation

Settings for managing multiple Google accounts.

Google retired Gemini CLI for consumer accounts on June 18, 2026. All requests now use Antigravity; old routing settings (`cli_first`, `quota_fallback`, `quota_style_fallback`, and `operator.routing`) in config are ignored.

| Option | Default | Description |
|--------|---------|-------------|
| `account_selection_strategy` | `"hybrid"` | How to select accounts |
| `switch_on_first_rate_limit` | `true` | Switch account immediately on first 429 |
| `pid_offset_enabled` | `false` | Distribute sessions across accounts (for parallel agents) |

### Strategy Guide

| Your Setup | Recommended Strategy | Why |
|------------|---------------------|-----|
| **1 account** | `"sticky"` | No rotation needed, preserve prompt cache |
| **2-3 accounts** | `"hybrid"` (default) | Smart rotation with health scoring |
| **4+ accounts** | `"round-robin"` | Maximum throughput |
| **Parallel agents** | `"round-robin"` + `pid_offset_enabled: true` | Distribute across accounts |

### Available Strategies

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Single account, prompt cache |
| `round-robin` | Rotate on every request | Maximum throughput |
| `hybrid` | Health score + token bucket + LRU | Smart distribution (default) |

---

## App Behavior

Settings that control plugin behavior.

| Option | Default | Description |
|--------|---------|-------------|
| `quiet_mode` | `false` | Hide toast notifications (except recovery) |
| `debug` | `false` | Enable debug logging |
| `log_dir` | `~/.local/state/cortexkit/antigravity-auth/logs/` | Custom directory for debug logs; `OPENCODE_ANTIGRAVITY_LOG_DIR` wins over it |
| `auto_update` | `true` | Enable automatic plugin updates |

### Debug Logging

```json
{
  "debug": true,
  "debug_tui": true
}
```

Logs are written to `~/.local/state/cortexkit/antigravity-auth/logs/` (`$XDG_STATE_HOME/cortexkit/antigravity-auth/logs/` when `XDG_STATE_HOME` is set), or to `OPENCODE_ANTIGRAVITY_LOG_DIR`, then `log_dir`, when set. Older versions wrote them to `~/.config/opencode/antigravity-logs/`; logs left there are not touched, and you can delete them.

---

## Recommended Configs

Copy-paste ready configs with recommended settings pre-applied.

### 1 Account

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
  "account_selection_strategy": "sticky"
}
```

**Why these settings:**
- `sticky` — No rotation needed, preserves Anthropic prompt cache

### 2-3 Accounts

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
  "account_selection_strategy": "hybrid"
}
```

**Why these settings:**
- `hybrid` — Smart rotation using health scores, avoids bad accounts

### 3+ Accounts (Power Users / Parallel Agents)

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
  "account_selection_strategy": "round-robin",
  "switch_on_first_rate_limit": true,
  "pid_offset_enabled": true
}
```

**Why these settings:**
- `round-robin` — Maximum throughput, rotates every request
- `switch_on_first_rate_limit` — Immediately switch on 429 (default: true)
- `pid_offset_enabled` — Different sessions use different starting accounts

---

## What's Enabled by Default

These settings are already `true` by default — you don't need to set them:

| Setting | Default | What it does |
|---------|---------|--------------|
| `session_recovery` | `true` | Auto-recover from errors |
| `auto_update` | `true` | Keep plugin updated |
| `switch_on_first_rate_limit` | `true` | Fast account switching |

These settings are `false` by default:

| Setting | Default | What it does |
|---------|---------|--------------|
| `keep_thinking` | `false` | Preserve Claude thinking (may degrade stability) |

---

## Advanced error recovery

> These settings are for edge cases. Most users don't need to change them.

<details>
<summary><b>Error Recovery (internal)</b></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `empty_response_max_attempts` | `2` | Retries for empty API responses |
| `empty_response_retry_delay_ms` | `2000` | Delay between retries |
| `tool_id_recovery` | `true` | Fix mismatched tool IDs from context compaction |
| `claude_tool_hardening` | `true` | Prevent tool parameter hallucination |
| `max_rate_limit_wait_seconds` | `300` | Cumulative wait budget while no account is eligible, shared by rate limits and soft quota; resets on eligible selection (0=unlimited) |

</details>

## Additional settings and environment overrides

The [schema](../src/plugin/config/schema.ts) is the source of truth for complete bounds and defaults. The notification, warmup, retry, quota, account-floor, and logging settings formerly listed in the [root README](../../../README.md) are collected below:

| Setting | Default | Effect / environment override |
| --- | --- | --- |
| `toast_scope` | `root_only` | `all` includes subagent toasts; `OPENCODE_ANTIGRAVITY_TOAST_SCOPE` |
| `debug_tui` | `false` | TUI verbosity independent of file logging; `OPENCODE_ANTIGRAVITY_DEBUG_TUI=1` |
| `thinking_warmup` | `false` | Optional Claude probe for a missing thinking signature before tool-enabled requests |
| `cache_warmup_on_switch` | `true` | After switching accounts, send an extra copy of the prepared request, read one response chunk, then cancel that response before the normal send; `OPENCODE_ANTIGRAVITY_CACHE_WARMUP_ON_SWITCH=1` |
| `claude_prompt_auto_caching` | `false` | Add top-level `cache_control` when absent |
| `max_account_switches` | `10` | Per-request account budget; `OPENCODE_ANTIGRAVITY_MAX_ACCOUNT_SWITCHES` |
| `scheduling_mode` | `cache_first` | Also `balance` / `performance_first`; `OPENCODE_ANTIGRAVITY_SCHEDULING_MODE` |
| `max_cache_first_wait_seconds` | `60` | Wait cap for cache-first scheduling |
| `failure_ttl_seconds` | `3600` | Failure-count reset window |
| `default_retry_after_seconds` | `60` | Retry delay fallback |
| `max_backoff_seconds` | `60` | Exponential backoff cap |
| `request_jitter_max_ms` | `0` | Spread concurrent requests |
| `switch_account_delay_ms` | `500` | Delay before switching accounts |
| `soft_quota_threshold_percent` | `80` | Exclude accounts at this usage threshold; `100` disables |
| `quota_refresh_interval_minutes` | `30` | Opportunistic quota refresh cadence; `0` disables |
| `soft_quota_cache_ttl_minutes` | `auto` | `max(2 × refresh, 10)` minutes or an explicit TTL |
| `proactive_rotation_threshold_percent` | `20` | Remaining quota trigger; `OPENCODE_ANTIGRAVITY_PROACTIVE_ROTATION_THRESHOLD` |
| `operator.killswitch.enabled` | `false` | Hard exclusion switch |
| `operator.killswitch.minimum_remaining_percent` | `5` | Global remaining-quota floor |
| `operator.killswitch.accounts` | unset | Per-account floors, keyed by a short token hash, never a raw token |
| `operator.log_level` | `info` | `error`, `warn`, `info`, `debug`, `trace`; mutable via Diagnostics |

Use `OPENCODE_ANTIGRAVITY_QUIET=1`, `OPENCODE_ANTIGRAVITY_DEBUG=1`, and `OPENCODE_ANTIGRAVITY_LOG_DIR=/secure/path` for quiet mode, file logging, and log location respectively. Account strategy and PID offset also have `OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY` and `OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED` overrides. See [account and quota semantics](MULTI-ACCOUNT.md) rather than treating thresholds as live entitlement guarantees.

## Where the files live

OpenCode watches its config folder (`~/.config/opencode`, or `OPENCODE_CONFIG_DIR`). The plugin therefore keeps its account store, vault files, signature cache and default debug logs in its own state folder instead. Existing account stores move there once every OpenCode using them has closed or restarted on this version (see below).

| What | Where |
| --- | --- |
| Account store (`antigravity-accounts.json.store.pointer.json` and its `…generation/` folder), vault files (`antigravity-auth-vault/`) | The runtime folder: `~/.local/state/cortexkit/antigravity-auth/opencode/` for the config folder `~/.config/opencode`. Any other config folder gets `~/.local/state/cortexkit/antigravity-auth/opencode-<16 hex digits>/`, whose `config-dir.json` names the config folder it belongs to. |
| Signature cache | `~/.local/state/cortexkit/antigravity-auth/antigravity-signature-cache.json`, one per state folder, shared by every config folder |
| Debug logs | `~/.local/state/cortexkit/antigravity-auth/logs/`, unless `OPENCODE_ANTIGRAVITY_LOG_DIR` or `log_dir` names a folder (the variable wins) |
| `antigravity.json`, `tui-preferences.jsonc`, account-store forwarding pointer and kept old store | OpenCode's config folder |

`~/.local/state` means `$XDG_STATE_HOME` when that is set, on every OS; on Windows it is `%USERPROFILE%\.local\state`. Runtime folders are private to your user: `0700` folders and `0600` files, or an owner-only ACL on Windows. Pi's files do not move.

### When the account store moves

The account store moves at the first local-account start after every OpenCode using that config folder has closed or restarted on this version. Setup and `antigravity-auth store relocate --offline` can also move an existing store, with every OpenCode closed. Accounts, logins and quota come along; nothing needs to be re-entered. Vault-only starts leave the local account store alone until you disconnect to local accounts.

While another OpenCode still uses the config-folder store, the plugin keeps it there and logs once that it is waiting for every running OpenCode using it to restart on this version. After the move, local-account requests no longer create lock and temporary files in OpenCode's config folder.

If the state folder's path goes through a symbolic link (or a junction on Windows), the store stays put. Set `XDG_STATE_HOME` to the real path, then close every OpenCode and restart. Do not move the store by copying its files: it records and checks its own location.

The old `antigravity-accounts.json.store.<id>.generation/` folder is kept in OpenCode's config folder as a pre-move backup. Once the moved store opens successfully and you have checked that your accounts are present, you can delete that old generation folder if you do not need the backup or the ability to move back. Keep the whole old generation if you may use `store relocate --back`: that command needs its original journal and migration evidence, and replaces its account data with your current accounts. Never delete the moved generation or its own backups and transfer files.

**Never delete or edit `antigravity-accounts.json.store.pointer.json` in OpenCode's config folder.** It is the forwarding pointer, not an unused backup. It keeps older versions from starting with no accounts. Without it, logging in on an older version can create a second, separate store.

### When the vault files move

The vault files move at the first start after every OpenCode that uses that config folder has closed, or restarted on a version with the move. The plugin copies each file, checks the copy, writes `layout.json` in the runtime folder, and then removes each old file after comparing it with its copy again. An approved enrollment comes along: you do not enroll again.

While an older OpenCode is still running, the files stay where they are, and the plugin logs once: "antigravity-auth keeps its vault files in OpenCode's config folder until every running OpenCode using it has restarted on this version."

In vault mode the move leaves `opencode-enrollment-state.json` in the old `antigravity-auth-vault/` on purpose. It holds no secret, and it makes an older version refuse requests instead of serving local accounts. Disconnect removes it.

The old signature cache in OpenCode's config folder is deleted at the move, not copied; the new one fills itself again. Old debug logs in `antigravity-logs/` are left alone, and you can delete them.

### What the move cannot see

The plugin waits for running OpenCodes it can see. It cannot see an OpenCode 2 running 3.0.12 or earlier, or a short CLI command from a version before 3.0.13. **Close every OpenCode before upgrading.** If such a process writes vault files into the old folder after the move, the next start refuses until one copy is removed. An unseen process using the old account store starts refusing account operations after the move and must be restarted.

### Refusals and recovery

When the plugin cannot tell where its vault files are, it serves neither vault nor local accounts. Requests, the `/antigravity` menu and the sidebar all show the reason and what to do. A host that has never enrolled in a vault gets only the file-location message, with no vault instructions.

- **`layout.json` is damaged, or names another config folder.** Check that the old vault files are still in OpenCode's config folder, in `antigravity-auth-vault/`. If they are, delete `layout.json` and restart OpenCode. If they are not, keep the runtime folder as it is: it holds your only copy.
- **Another OpenCode is moving the files.** The message names the lock the plugin waited for. Try again, or restart OpenCode, once the other one has finished. A lock left by an OpenCode that crashed expires by itself within a minute.
- **Vault files conflict between the old and the new folder.** The message names both paths; the plugin leaves both in place. Keep the newer one, which is the copy from your most recent approval or re-enrollment, delete the other, and restart OpenCode. Do not merge them or choose by file date.
- **`config-dir.json` names another config folder.** That runtime folder belongs to another OpenCode setup. It is left untouched; move it aside and restart OpenCode.
- **The runtime folder is not private to your user, or is a link.** Replace it with a plain folder of your own and restart OpenCode.
- **A store move is in progress.** Close the other OpenCodes using that store, then restart on this version to finish the move.
- **The account store in OpenCode's config folder was reactivated.** The forwarding pointer was changed. Close every OpenCode and restore the original forwarding pointer that names the active moved store. Do not choose a store by file date, delete the pointer, or replace it with the old pre-move pointer. Rerunning `store relocate` cannot repair that manual pointer change.

### Downgrading

**Going back to 3.0.16 needs no account-store step:** that version reads a moved store. To go back to 3.0.15 or earlier, close every OpenCode and run this command on the current version **before** installing the older one:

```bash
antigravity-auth store relocate --back --offline
```

This restores the account store and its original pointer in OpenCode's config folder. **It replaces the kept pre-move backup with your current accounts.** Keep the old generation folder until the command has finished. A later upgrade respects the move back; use `antigravity-auth store relocate --offline` to move to the state folder again.

Without the move back, 3.0.15 refuses with `The account store cannot be admitted: pointer has unknown fields`. Reinstall the current version, run the command with every OpenCode closed, then downgrade. Never delete the forwarding pointer to get past the refusal.

If you are also going back to a version from before the vault-file move, move the files in `antigravity-auth-vault/` from the runtime folder back into `antigravity-auth-vault/` in OpenCode's config folder, replacing the `opencode-enrollment-state.json` the move left there. Then delete `layout.json` from the runtime folder, so that a later upgrade moves the vault files again.

Until you do, an older version finds the enrollment state without its token: it stays in vault mode and refuses requests rather than serving local accounts. Do not run an older version on an old copy while a newer one uses the moved files. Delete `layout.json` only for this move back, or to recover from a damaged `layout.json` as described above.

## State, cache, log, RPC, and dump files

| Purpose | Location | Notes |
| --- | --- | --- |
| Local account store | In the runtime folder after the move; `antigravity-accounts.json.store.pointer.json` selects the sibling `antigravity-accounts.json.store.<id>.generation/` directory | Owner-only `config.json` / `state.json`, journals, protected backups/transfers; see [where the files live](#where-the-files-live) for deferral and downgrade rules |
| Legacy pool | `$OPENCODE_CONFIG_DIR/antigravity-accounts.json` (default `~/.config/opencode/…`) | Migration input / successful V4 rollback output, not the active writer |
| Plugin config | Project `.opencode/antigravity.json`, then user config | Zod-validated settings |
| Debug logs | `~/.local/state/cortexkit/antigravity-auth/logs/`, or `OPENCODE_ANTIGRAVITY_LOG_DIR`, then `log_dir` | Sensitive request/response data; owner-only |
| Gemini wire dumps | `opencode-antigravity-gemini-dumps/` in the OS temporary folder, or `OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR` | Sensitive request/response data; turn dumps off after debugging |
| OpenCode 1 sidebar | `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` | Override `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE`; `0600` |
| OpenCode 1 RPC | `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` | Override `ANTIGRAVITY_AUTH_RPC_DIR`; loopback bearer, `0600` files / `0700` directory |
| Signature cache | `~/.local/state/cortexkit/antigravity-auth/antigravity-signature-cache.json`, one per state folder | Written only with `keep_thinking`; two-day default disk TTL |
| Vault files | `antigravity-auth-vault/` in the runtime folder; see [where the files live](#where-the-files-live) | Owner-only |

OpenCode 1's sidebar polls every two seconds. Writers emit contract version `2` and skip newer-major files; readers accept `1` and `2` but refuse unknown majors. Missing, unreadable, malformed, or unsupported files produce an empty default state. Legacy reads never invent email, quota fractions, or observation timestamps. Top-level `checkedAt` is publication time, not a quota reading's observation time; undated quota is never current. The owner-only machine snapshot may include genuinely known email; renderer-safe projections exclude it from the UI, logs, and toasts, keeping ordinal labels. Session routing entries older than 24 hours are removed, and only the 100 newest entries are kept. Writes serialize, lock, re-read/merge, and atomically replace. Lock contention is reported to the caller; successful writes do not prove that the terminal rendered the snapshot. See the [sidebar contract](sidebar-contract.md) for detailed fields and version policy.

OpenCode 2 uses location-scoped snapshots and native host RPC, not OpenCode 1 port files. If OpenCode 1's sidebar stays on old readings or "Awaiting Antigravity state", stop the host, check the state path and its `0600` file permissions (owner read/write only), then restart. For missing RPC, verify the server loaded and the project-specific directory is writable; different projects have different hashed RPC directories.

Raw generative Antigravity sends use [agy-transport.ts](../../core/src/agy-transport.ts): separate default `180_000` ms response-header and no-body-data idle timeouts, **not** a total streaming deadline. Standard-fetch callers use [fetchWithActiveTimeout](../../core/src/fetch-timeout.ts), default `15_000` ms until headers; cancellation stays connected through body completion/error/cancel. That helper's 15s budget is not the raw Antigravity limit.

Each logical generation request also has a **fixed, provisional 10-minute pre-response limit**, pending real latency measurements. This is not a setting. It covers preparation, account selection and quota waits, warmups, endpoint/account retries, and failed-response classification until the accepted main response's headers arrive. An empty-response resend retains the original deadline. It does **not** promise a first visible token within ten minutes or limit the total duration of an accepted response body. The per-attempt 180-second header allowance is unchanged; body-idle limits remain 180 seconds in OpenCode 1/Pi and 300 seconds in GA.

The pre-response limit is independent of `max_rate_limit_wait_seconds`: the earlier active limit wins, with the existing quota refusal winning a tie. Setting the quota-wait option to `0` removes only that quota-wait cap, not the fixed pre-response limit. Expiry returns a native, nonretryable HTTP 412 (`FAILED_PRECONDITION`); Pi emits its native terminal error instead of assistant text. If the caller cancels a request, its cancellation outcome is preserved instead of being converted to a timeout refusal.

## Security and redaction

Keep local store generations, pointers, backups, transfer files, native Google auth slots, and vault custody files private. Filesystem permissions are not encryption. None belong in Git or support reports.

Renderer projections exclude refresh/access tokens, project IDs, and fingerprints; account labels and quota state are not credential backups. Killswitch account keys are short deterministic hashes, not raw tokens. Do not log them as a substitute for redaction.

File `debug` logs and raw wire dumps may include headers and request/response bodies. Avoid debug capture for sessions handling personal data, use a private/encrypted `log_dir` when appropriate, and share only redacted errors. `debug_tui` and the runtime log-level filter are independent knobs. See [the logging boundary](COMMON_AUTH_LOGGING.md).

Public Antigravity OAuth client identifiers and shipped headers are inspectable protocol constants, not account credentials. Refresh/access tokens, browser cookies, bearer tokens, and request/response dumps remain excluded from this repository, issues, and chat.

## Advanced token, cache, and selection settings

<details>
<summary><b>Token Management (internal)</b></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `proactive_token_refresh` | `true` | Refresh tokens before expiry |
| `proactive_refresh_buffer_seconds` | `1800` | Refresh 30 min before expiry |
| `proactive_refresh_check_interval_seconds` | `300` | Check interval |

</details>

<details>
<summary><b>Signature Cache (internal)</b></summary>

Used when `keep_thinking: true`. Most users don't need to configure this.

| Option | Default | Description |
|--------|---------|-------------|
| `signature_cache.enabled` | `true` | Enable disk caching |
| `signature_cache.memory_ttl_seconds` | `3600` | In-memory cache TTL (1 hour) |
| `signature_cache.disk_ttl_seconds` | `172800` | Disk cache TTL (48 hours) |
| `signature_cache.write_interval_seconds` | `60` | Background write interval |

</details>

<details>
<summary><b>Health Score Tuning (internal)</b></summary>

Used by `hybrid` strategy. Most users don't need to configure this.

| Option | Default | Description |
|--------|---------|-------------|
| `health_score.initial` | `70` | Starting health score |
| `health_score.success_reward` | `1` | Points added on success |
| `health_score.rate_limit_penalty` | `-10` | Points removed on rate limit |
| `health_score.failure_penalty` | `-20` | Points removed on failure |
| `health_score.recovery_rate_per_hour` | `2` | Points recovered per hour |
| `health_score.min_usable` | `50` | Minimum score to use account |
| `health_score.max_score` | `100` | Maximum health score |

</details>

<details>
<summary><b>Token Bucket Tuning (internal)</b></summary>

Used by `hybrid` strategy. Most users don't need to configure this.

| Option | Default | Description |
|--------|---------|-------------|
| `token_bucket.max_tokens` | `50` | Maximum tokens in bucket |
| `token_bucket.regeneration_rate_per_minute` | `6` | Tokens regenerated per minute |
| `token_bucket.initial_tokens` | `50` | Starting tokens |

</details>
