import {
  boolean,
  defineSettings,
  list,
  number,
  object,
  oneOf,
  record,
  string,
  type ValueDescriptor,
  type ValueOf,
} from '../common-auth-embedded/settings/index.js'

/** The legacy settings migration must report these keys as unmapped, `retired`. */
export const RETIRED_SETTINGS = [
  'tool_id_recovery',
  'max_backoff_seconds',
] as const

function oc<const D extends ValueDescriptor>(
  path: string | readonly string[],
  value: D,
  defaultValue: ValueOf<D>,
  project: 'allowed' | 'user-only' = 'user-only',
) {
  return {
    value,
    default: defaultValue,
    hosts: 'opencode',
    project,
    legacy: [
      { source: 'opencode', path: typeof path === 'string' ? [path] : path },
    ],
  } as const
}

function numeric(name: string, min: number, max: number, defaultValue: number) {
  return oc(name, number({ min, max }), defaultValue)
}

const percent = number({ min: 0, max: 100 })

// Sidebar preferences remain in tui-preferences.jsonc. A future sidebar object
// can be added independently; no setting here permits host or model overrides.
export const ANTIGRAVITY_SETTINGS = defineSettings({
  plugin: 'antigravity-auth',
  settings: {
    quiet_mode: oc('quiet_mode', boolean(), false, 'allowed'),
    toast_scope: oc(
      'toast_scope',
      oneOf(['root_only', 'all']),
      'root_only',
      'allowed',
    ),
    debug: oc('debug', boolean(), false),
    debug_tui: oc('debug_tui', boolean(), false),
    // An empty log directory selects the application's default state directory.
    log_dir: oc('log_dir', string(), ''),
    keep_thinking: oc('keep_thinking', boolean(), false),
    thinking_warmup: oc('thinking_warmup', boolean(), false),
    cache_warmup_on_switch: oc('cache_warmup_on_switch', boolean(), true),
    session_recovery: oc('session_recovery', boolean(), true, 'allowed'),
    auto_resume: oc('auto_resume', boolean(), true),
    resume_text: oc('resume_text', string(), 'continue'),
    signature_cache: oc(
      'signature_cache',
      object({
        enabled: boolean(),
        memory_ttl_seconds: number({ min: 60, max: 86400 }),
        disk_ttl_seconds: number({ min: 3600, max: 604800 }),
        write_interval_seconds: number({ min: 10, max: 600 }),
      }),
      {
        enabled: true,
        memory_ttl_seconds: 3600,
        disk_ttl_seconds: 172800,
        write_interval_seconds: 60,
      },
    ),
    empty_response_max_attempts: numeric(
      'empty_response_max_attempts',
      1,
      10,
      2,
    ),
    empty_response_retry_delay_ms: numeric(
      'empty_response_retry_delay_ms',
      500,
      10000,
      2000,
    ),
    claude_tool_hardening: oc(
      'claude_tool_hardening',
      boolean(),
      true,
      'allowed',
    ),
    claude_prompt_auto_caching: oc(
      'claude_prompt_auto_caching',
      boolean(),
      false,
      'allowed',
    ),
    proactive_token_refresh: oc('proactive_token_refresh', boolean(), true),
    proactive_refresh_buffer_seconds: numeric(
      'proactive_refresh_buffer_seconds',
      60,
      7200,
      1800,
    ),
    proactive_refresh_check_interval_seconds: numeric(
      'proactive_refresh_check_interval_seconds',
      30,
      1800,
      300,
    ),
    max_rate_limit_wait_seconds: numeric(
      'max_rate_limit_wait_seconds',
      0,
      3600,
      300,
    ),
    account_selection_strategy: oc(
      'account_selection_strategy',
      oneOf(['sticky', 'round-robin', 'hybrid']),
      'hybrid',
    ),
    pid_offset_enabled: oc('pid_offset_enabled', boolean(), false),
    switch_on_first_rate_limit: oc(
      'switch_on_first_rate_limit',
      boolean(),
      true,
    ),
    max_account_switches: numeric('max_account_switches', 0, 500, 10),
    scheduling_mode: oc(
      'scheduling_mode',
      oneOf(['cache_first', 'balance', 'performance_first']),
      'cache_first',
    ),
    max_cache_first_wait_seconds: numeric(
      'max_cache_first_wait_seconds',
      5,
      300,
      60,
    ),
    failure_ttl_seconds: numeric('failure_ttl_seconds', 60, 7200, 3600),
    default_retry_after_seconds: numeric(
      'default_retry_after_seconds',
      1,
      300,
      60,
    ),
    request_jitter_max_ms: numeric('request_jitter_max_ms', 0, 5000, 0),
    switch_account_delay_ms: numeric('switch_account_delay_ms', 0, 10000, 500),
    soft_quota_threshold_percent: numeric(
      'soft_quota_threshold_percent',
      1,
      100,
      100,
    ),
    quota_refresh_interval_minutes: numeric(
      'quota_refresh_interval_minutes',
      0,
      120,
      30,
    ),
    soft_quota_cache_ttl: oc(
      'soft_quota_cache_ttl_minutes',
      oneOf(['auto', 'minutes']),
      'auto',
    ),
    // Applies only when soft_quota_cache_ttl is minutes. The dormant default
    // equals auto at the default refresh interval: max(2 * 30, 10) = 60.
    soft_quota_cache_ttl_minutes: numeric(
      'soft_quota_cache_ttl_minutes',
      1,
      120,
      60,
    ),
    proactive_rotation_threshold_percent: numeric(
      'proactive_rotation_threshold_percent',
      0,
      100,
      20,
    ),
    health_score: oc(
      'health_score',
      object({
        initial: percent,
        success_reward: number({ min: 0, max: 10 }),
        rate_limit_penalty: number({ min: -50, max: 0 }),
        failure_penalty: number({ min: -100, max: 0 }),
        recovery_rate_per_hour: number({ min: 0, max: 20 }),
        min_usable: percent,
        max_score: number({ min: 50, max: 100 }),
      }),
      {
        initial: 70,
        success_reward: 1,
        rate_limit_penalty: -10,
        failure_penalty: -20,
        recovery_rate_per_hour: 2,
        min_usable: 50,
        max_score: 100,
      },
    ),
    token_bucket: oc(
      'token_bucket',
      object({
        max_tokens: number({ min: 1, max: 1000 }),
        regeneration_rate_per_minute: number({ min: 0.1, max: 60 }),
        initial_tokens: number({ min: 1, max: 1000 }),
      }),
      {
        max_tokens: 50,
        regeneration_rate_per_minute: 6,
        initial_tokens: 50,
      },
    ),
    background_quota_refresh: oc('background_quota_refresh', boolean(), true),
    background_quota_refresh_interval_minutes: numeric(
      'background_quota_refresh_interval_minutes',
      1,
      60,
      5,
    ),
    auto_update: oc('auto_update', boolean(), true),
    killswitch: oc(
      ['operator', 'killswitch'],
      object({
        enabled: boolean(),
        minimum_remaining_percent: percent,
        accounts: record(percent),
      }),
      { enabled: false, minimum_remaining_percent: 5, accounts: {} },
    ),
    log_level: oc(
      ['operator', 'log_level'],
      oneOf(['error', 'warn', 'info', 'debug', 'trace']),
      'info',
    ),
    account_models: {
      // common-auth's list descriptor cannot require items. compileModelAccess
      // rejects an empty list as an unusable record, never as an absent entry.
      value: record(list(string())),
      default: {},
      hosts: 'both: OpenCode local and vault accounts; Pi vault accounts',
      project: 'user-only',
    },
  },
})
