# Accounts, routing, and quota

Local OpenCode 1 and OpenCode 2 share an initialized/migrated account repository at the resolved account path. Projects do not create independent pools. Pi local mode uses a single native Google login instead; see [Pi](../../pi/README.md).

## Add and manage accounts

Initialize a fresh pool or complete [offline migration](MIGRATION.md) before CLI/OpenCode 1 login. Standalone `antigravity-auth login` starts or replaces the pool rather than adding accounts; local OpenCode setup login and the host account menu add accounts instead. See [commands](COMMANDS.md#standalone-cli). OpenCode 2's [pool browser method](OPENCODE-2.md#pool-browser-login) can initialize a truly fresh store but refuses a pending migration. Use the [login route for your OpenCode version](COMMANDS.md#host-login-routes) or `/antigravity` → Sign in to add local accounts. Use Accounts to enable/disable, remove, or reauthorize them; a disabled account remains visible but is excluded from rotation. Duplicate identities are not additional pool accounts: use reauthorization to replace an existing account's credentials.

Use `/antigravity` → Quota or `antigravity-auth quota [--refresh] [--json]` for readings. The old standalone quota script no longer ships. The account menu checks the freshly read local/vault enrollment choice before applying an action; local logins are unavailable while the vault is in use. [Vault mode](VAULT.md) uses approved vault-served accounts with no local fallback.

## Account storage

`antigravity-accounts.json.store.pointer.json` selects the active `antigravity-accounts.json.store.<id>.generation/` containing `config.json` and `state.json`. After the [account-store move](CONFIGURATION.md#when-the-account-store-moves), both live in the runtime folder under the state home, with a forwarding pointer and the old generation kept in OpenCode's config folder. Never delete that forwarding pointer: it keeps older versions from starting with no accounts. The legacy import/export path is `~/.config/opencode/antigravity-accounts.json`, overridden by `OPENCODE_CONFIG_DIR`. Legacy JSON is migration input or successful rollback output, **not** the active writer target.

Local account data includes refresh credentials, email, enabled/access state, optional project context, fingerprint history, cooldowns, health, and cached quota. Credentials are plaintext in owner-only files/directories; permissions are not encryption. Protect pointers, generations, journals, backups, and transfer files. Never publish account contents, tokens, project IDs, or fingerprints in reports. Terminal account/quota views are redacted separately and are not credential backups; see [OpenCode 1's sidebar privacy boundary](sidebar-contract.md#location-and-privacy) and [OpenCode 2's UI](OPENCODE-2.md#ui-and-evidence-limits).

Do not delete account files as a reset for `invalid_grant`, rate limits, or a failed migration. Stop the host, inspect the store/source refusal, then use account removal/reauthorization or provider re-login once the active source is healthy. A migrated pool is not transferable by copying only the old JSON or manually splicing generations; see [migration and rollback](MIGRATION.md).

## Account selection

Set `account_selection_strategy` in `antigravity.json`:

| Strategy | Behavior |
| --- | --- |
| `sticky` | Keep the current account while it is eligible, then advance |
| `hybrid` (default) | Token bucket, health score, and least-recently-used freshness |
| `round-robin` | Advance the account cursor when selecting an account |

All strategies first reuse a usable existing session pin. The sticky path applies `pid_offset_enabled` once per model family to offset the initial account index by process ID; it does not give every session a unique account. `max_account_switches` (default `10`) bounds the number of accounts tried per request. `switch_on_first_rate_limit` (default on) chooses rotation on the first 429 rather than one same-account retry. `default_retry_after_seconds` and `max_backoff_seconds` default to `60`; `request_jitter_max_ms` can spread simultaneous requests. See [configuration](CONFIGURATION.md#account-rotation).

## Antigravity routing

Google [ended Gemini CLI service for free individual users and Google AI Pro/Ultra subscribers on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/). Plugin-owned requests use Antigravity; old `cli_first`, `quota_fallback`, `quota_style_fallback`, and `operator.routing` settings are ignored. Ordinary real-key/native-login requests in OpenCode 2 remain [unowned passthrough](OPENCODE-2.md#request-ownership-marker-only-support-boundary).

Antigravity content sends use its User-Agent without `X-Goog-Api-Client` or `Client-Metadata`. Rate limits are scoped to account, model family, and model; the plugin no longer switches to the retired Gemini CLI request/quota path. Antigravity endpoint fallback (daily → production), account rotation, and cooldown policies remain. `/antigravity` → Routing shows the effective selection strategy and configuration key without runtime actions.

## Quota refresh and soft thresholds

Each cached quota entry carries `{ remainingFraction, resetTime }` per quota group (`claude`, `gemini-pro`, `gemini-flash`, `gpt-oss`). Gemini 4 Argon's remaining quota and reset time are reported per model. [Whether Argon uses the same weekly quota allowance as other models, and which allowance, is unverified](MODEL-VARIANTS.md#gemini).

- **Refresh:** the quota manager refreshes opportunistically after successful requests according to `quota_refresh_interval_minutes` (default `30`, `0` disables that cadence).
- **TTL:** `soft_quota_cache_ttl_minutes = "auto"` resolves to `max(2 × refresh_interval, 10)` minutes.
- **Soft threshold:** `soft_quota_threshold_percent` (default `80`) skips accounts at or above the usage threshold as if rate-limited; `100` disables this filter.
- **Stale/missing fail-open:** readings older than TTL, or never refreshed, are unknown and allowed through the soft check so cold starts cannot deadlock.
- **All exhausted:** wait for eligible quota/reset/cooldown. `max_rate_limit_wait_seconds` (default `300`, `0` removes the cap) is one cumulative budget for a continuous period with no eligible account, shared by rate-limit and soft-quota waits. Each sleep is capped at the remaining budget; selecting an eligible account resets it. A proposed wait above the full cap still fails fast, and an exhausted budget ends with a native error rather than inventing success.
- **Proactive rotation:** below `proactive_rotation_threshold_percent` remaining (default `20`), the next request selects a warm-cache account.

## Operator killswitch

`/antigravity` → Limits configures OpenCode's operator exclusion layer:

- `operator.killswitch.enabled` defaults to `false`.
- `minimum_remaining_percent` defaults to `5`; accounts whose fresh cached remaining quota is below the floor are excluded. Quota equal to the floor is allowed.
- `accounts` supplies per-account floors, keyed by `sha256(refreshToken).slice(0,12)`, not raw credentials. Raw tokens must not appear in config, sidebar, RPC, or apply responses.
- Stale/missing cache fails open (default freshness TTL `5min`) so a cold start can obtain a real reading.
- If every account is excluded, `AntigravityKillswitchError` carries a per-account summary rather than a synthetic success body.

Exclusion and soft-quota checks precede token-bucket/health selection. Pi vault mode does not implement these OpenCode operator controls. See [commands](COMMANDS.md) and [credential safety](CONFIGURATION.md#security-and-redaction).
