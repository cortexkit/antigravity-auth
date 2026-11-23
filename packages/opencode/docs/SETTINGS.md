# Settings by host and credential source

This table covers plugin-owned Antigravity requests. OpenCode 2 requests using native Google credentials are not affected. **OC1** and **OC2** mean OpenCode 1 and 2. **Local** is the OpenCode pool or Pi’s native Google login, **Vault** is an enrolled vault, and **Hosted** is a vault supplied by Thalamus.

**Project** means that OpenCode allows an override from a project file. **User-only** settings can only come from the user file. Pi reads supported settings from the user file and never reads project overrides. See [Configuration](CONFIGURATION.md#plugin-configuration) for locations and defaults.

- **Yes**: a non-default setting has a tested effect when its feature is in use.
- **Host limit**: the pinned host API does not provide the operation.
- **One account**: Pi uses one account at a time, with no pool rotation, health scoring, quota polling, or quota gates.
- **—**: the setting has no effect on this path. For example, buffered empty-response retries do not apply to Pi’s stream, and custody never refreshes a local login. `claude_prompt_auto_caching` is accepted for compatibility but does not change requests.

| Setting | Scope | OC1 Local | OC1 Vault | OC1 Hosted | OC2 Local | OC2 Vault | OC2 Hosted | Pi Local | Pi Vault | Pi Hosted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `quiet_mode` | project | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `toast_scope` | project | Yes | Yes | Yes | Yes | Yes | Yes | — | — | — |
| `debug` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `debug_tui` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | — | — |
| `log_dir` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `keep_thinking` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `thinking_warmup` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `cache_warmup_on_switch` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `session_recovery` | project | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `auto_resume` | user-only | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `resume_text` | user-only | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `signature_cache` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `empty_response_max_attempts` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | — | — |
| `empty_response_retry_delay_ms` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | — | — |
| `claude_tool_hardening` | project | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `claude_prompt_auto_caching` | project | — | — | — | — | — | — | — | — | — |
| `proactive_token_refresh` | user-only | Yes | — | — | Yes | — | — | — | — | — |
| `proactive_refresh_buffer_seconds` | user-only | Yes | — | — | Yes | — | — | — | — | — |
| `proactive_refresh_check_interval_seconds` | user-only | Yes | — | — | Yes | — | — | — | — | — |
| `max_rate_limit_wait_seconds` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `account_selection_strategy` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `pid_offset_enabled` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `switch_on_first_rate_limit` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `max_account_switches` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `scheduling_mode` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `max_cache_first_wait_seconds` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `failure_ttl_seconds` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `default_retry_after_seconds` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `request_jitter_max_ms` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `switch_account_delay_ms` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `soft_quota_threshold_percent` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `quota_refresh_interval_minutes` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `soft_quota_cache_ttl` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `soft_quota_cache_ttl_minutes` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `proactive_rotation_threshold_percent` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `health_score` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `token_bucket` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `background_quota_refresh` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `background_quota_refresh_interval_minutes` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `auto_update` | user-only | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `killswitch` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `log_level` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `account_models` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | Yes | Yes |

## Applicability notes

- **Signature cache on Pi:** `enabled` and `memory_ttl_seconds` govern an in-memory cache. Pi has no disk cache, so the disk TTL and write interval do not apply ([Pi signature binding](../../pi/src/request-engine.ts#L99)).
- **Quota refresh interval in OpenCode vault custody:** `quota_refresh_interval_minutes` determines the automatic soft-quota cache TTL. It does not schedule a local refresh; use the background quota settings for polling ([request engine](../../core/src/engine/request-services.ts#L1742)).

- `toast_scope`: Pi does not supply a parent session for request notices. Source: [`packages/pi/src/request-engine.ts:180`](../../../packages/pi/src/request-engine.ts#L180), [`packages/pi/src/stream.ts:200`](../../../packages/pi/src/stream.ts#L200).
- `debug_tui`: Pi disables injection of TUI debug text into the response. Source: [`packages/pi/src/request-engine.ts:128`](../../../packages/pi/src/request-engine.ts#L128).
- `cache_warmup_on_switch`, `account_selection_strategy`, `pid_offset_enabled`, `switch_on_first_rate_limit`, `max_account_switches`, `scheduling_mode`, `max_cache_first_wait_seconds`, `switch_account_delay_ms`, `soft_quota_threshold_percent`, `quota_refresh_interval_minutes`, `soft_quota_cache_ttl`, `soft_quota_cache_ttl_minutes`, `proactive_rotation_threshold_percent`, `health_score`, `token_bucket`, `background_quota_refresh`, `background_quota_refresh_interval_minutes`, `killswitch`: Pi binds one account and has no account rotation, pool health, killswitch or soft quota. Source: [`packages/pi/src/request-pool.ts:48`](../../../packages/pi/src/request-pool.ts#L48), [`packages/pi/src/request-settings.ts:93`](../../../packages/pi/src/request-settings.ts#L93).
- `session_recovery`, `auto_resume`, `resume_text`: The published session hooks do not offer the failed-message repair and prompt recovery hooks used on OpenCode 1. Source: [`@opencode/plugin@2.0.22: packages/plugin/src/promise/session.ts`](opencode2-ga-2.0.22-contract.md).
- `session_recovery`, `auto_resume`, `resume_text`, `auto_update`: Pi uses its own extension lifecycle, not the OpenCode 1 recovery and update hooks. Source: [`packages/pi/src/index.ts`](../../../packages/pi/src/index.ts), [`packages/opencode/src/plugin/index.ts:588`](../../../packages/opencode/src/plugin/index.ts#L588).
- `empty_response_max_attempts`, `empty_response_retry_delay_ms`: Pi uses streamGenerateContent, not buffered generation. Source: [`packages/pi/src/stream.ts`](../../../packages/pi/src/stream.ts).
- `claude_prompt_auto_caching`: Accepted for settings compatibility only; no request engine path reads it. Source: [`packages/core/src/settings/definition.ts`](../../../packages/core/src/settings/definition.ts), [`packages/core/src/engine/ports.ts`](../../../packages/core/src/engine/ports.ts).
- `proactive_token_refresh`, `proactive_refresh_buffer_seconds`, `proactive_refresh_check_interval_seconds`: Requests authorized by a vault use a vault credential for each send and do not refresh a local login. Source: [`packages/opencode/src/plugin/shared/vault-request-credentials.ts`](../../../packages/opencode/src/plugin/shared/vault-request-credentials.ts), [`packages/pi/src/request-engine.ts:245`](../../../packages/pi/src/request-engine.ts#L245).
- `proactive_token_refresh`: Pi uses the native Google login and has no proactive token queue. Source: [`packages/pi/src/index.ts`](../../../packages/pi/src/index.ts), [`packages/pi/src/request-engine.ts:290`](../../../packages/pi/src/request-engine.ts#L290).
- `proactive_refresh_buffer_seconds`: Pi uses the native Google login and has no proactive token queue. Source: [`packages/pi/src/index.ts`](../../../packages/pi/src/index.ts), [`packages/pi/src/request-engine.ts:290`](../../../packages/pi/src/request-engine.ts#L290).
- `proactive_refresh_check_interval_seconds`: Pi uses the native Google login and has no proactive token queue. Source: [`packages/pi/src/index.ts`](../../../packages/pi/src/index.ts), [`packages/pi/src/request-engine.ts:290`](../../../packages/pi/src/request-engine.ts#L290).
- `auto_update`: The setup context does not offer a plugin-update operation; the host manages updates. Source: [`@opencode/plugin@2.0.22: packages/plugin/src/promise/plugin.ts`](opencode2-ga-2.0.22-contract.md).
- `account_models`: Pi’s native Google login has no vault route ID to match against an account model list. Source: [`packages/pi/src/request-engine.ts:271`](../../../packages/pi/src/request-engine.ts#L271), [`packages/pi/src/vault-source.ts`](../../../packages/pi/src/vault-source.ts).

See [Commands](COMMANDS.md#antigravity-menu) for account and vault actions, and [OpenCode 2](OPENCODE-2.md#ui-and-evidence-limits) for its host limits.
