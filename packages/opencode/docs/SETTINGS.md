# Settings by host and credential source

This table covers plugin-owned Antigravity requests. OpenCode 2 requests using native Google credentials are not affected. **OC1** and **OC2** mean OpenCode 1 and 2. **Local** is the OpenCode pool or Pi’s native Google login, **Vault** is an enrolled vault, and **Hosted** is a vault supplied by Thalamus.

**Project** means that OpenCode allows an override from a project file. **User-only** settings can only come from the user file. Pi reads supported settings from the user file and never reads project overrides. See [Configuration](CONFIGURATION.md#plugin-configuration) for locations and defaults.

- **Yes**: a non-default setting has a tested effect when its feature is in use.
- **Host limit**: the OpenCode 2.0.22 plugin API does not provide the needed repair/resume or plugin-update operation.
- **One account**: Pi uses one account at a time, with no pool rotation, health scoring, quota polling, or quota gates.
- **—**: the setting has no effect on this path. For example, buffered empty-response retries do not apply to Pi’s stream, and custody never refreshes a local login. `claude_prompt_auto_caching` is accepted for compatibility but does not change requests.
- **Unverified**: no non-default effect is claimed for this host and credential source.

| Setting | Scope | OC1 Local | OC1 Vault | OC1 Hosted | OC2 Local | OC2 Vault | OC2 Hosted | Pi Local | Pi Vault | Pi Hosted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `quiet_mode` | project | Unverified | Unverified | Unverified | Unverified | Yes | Yes | Unverified | Unverified | Unverified |
| `toast_scope` | project | Yes | Yes | Yes | Unverified | Yes | Yes | — | — | — |
| `debug` | user-only | Yes | Yes | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `debug_tui` | user-only | Yes | Yes | Yes | Unverified | Unverified | Unverified | — | — | — |
| `log_dir` | user-only | Yes | Yes | Yes | Unverified | Unverified | Unverified | Yes | Yes | Yes |
| `keep_thinking` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Yes | Yes | Yes |
| `thinking_warmup` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Yes | Yes | Yes |
| `cache_warmup_on_switch` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `session_recovery` | project | Unverified | Unverified | Unverified | Host limit | Host limit | Host limit | — | — | — |
| `auto_resume` | user-only | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `resume_text` | user-only | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `signature_cache` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `empty_response_max_attempts` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | — | — |
| `empty_response_retry_delay_ms` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | — | — |
| `claude_tool_hardening` | project | Unverified | Unverified | Unverified | Yes | Yes | Yes | Yes | Yes | Yes |
| `claude_prompt_auto_caching` | project | — | — | — | — | — | — | — | — | — |
| `proactive_token_refresh` | user-only | Unverified | — | — | Unverified | — | — | — | — | — |
| `proactive_refresh_buffer_seconds` | user-only | Unverified | — | — | Unverified | — | — | — | — | — |
| `proactive_refresh_check_interval_seconds` | user-only | Unverified | — | — | Unverified | — | — | — | — | — |
| `max_rate_limit_wait_seconds` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Unverified | Unverified | Unverified |
| `account_selection_strategy` | user-only | Yes | Unverified | Unverified | Yes | Unverified | Unverified | One account | One account | One account |
| `pid_offset_enabled` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `switch_on_first_rate_limit` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `max_account_switches` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `scheduling_mode` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `max_cache_first_wait_seconds` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `failure_ttl_seconds` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `default_retry_after_seconds` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `request_jitter_max_ms` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `switch_account_delay_ms` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `soft_quota_threshold_percent` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `quota_refresh_interval_minutes` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `soft_quota_cache_ttl` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `soft_quota_cache_ttl_minutes` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `proactive_rotation_threshold_percent` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | One account | One account | One account |
| `health_score` | user-only | Yes | Unverified | Unverified | Yes | Unverified | Unverified | One account | One account | One account |
| `token_bucket` | user-only | Yes | Unverified | Unverified | Yes | Unverified | Unverified | One account | One account | One account |
| `background_quota_refresh` | user-only | Unverified | Unverified | Unverified | Unverified | Yes | Yes | One account | One account | One account |
| `background_quota_refresh_interval_minutes` | user-only | Unverified | Unverified | Unverified | Unverified | Yes | Yes | One account | One account | One account |
| `auto_update` | user-only | Yes | Yes | Yes | Host limit | Host limit | Host limit | — | — | — |
| `killswitch` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | One account | One account | One account |
| `log_level` | user-only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `account_models` | user-only | Yes | Yes | Yes | Yes | Yes | Yes | — | Yes | Yes |

See [Commands](COMMANDS.md#antigravity-menu) for account and vault actions, and [OpenCode 2](OPENCODE-2.md#ui-and-evidence-limits) for its host limits.
