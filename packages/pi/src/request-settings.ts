import type {
  SettingsHandle,
  ValueOf,
} from '@cortexkit/antigravity-auth-core/common-auth/settings'
import type { RequestConfig } from '@cortexkit/antigravity-auth-core/engine'
import { ANTIGRAVITY_SETTINGS } from '@cortexkit/antigravity-auth-core/settings'

const definition = ANTIGRAVITY_SETTINGS.settings
const keys = [
  'quiet_mode',
  'toast_scope',
  'debug',
  'log_dir',
  'log_level',
  'keep_thinking',
  'thinking_warmup',
  'signature_cache',
  'claude_tool_hardening',
  'claude_prompt_auto_caching',
  'max_rate_limit_wait_seconds',
  'default_retry_after_seconds',
  'request_jitter_max_ms',
  'failure_ttl_seconds',
] as const

type Key = (typeof keys)[number]
export type PiRequestSettings = {
  [K in Key]: ValueOf<(typeof definition)[K]['value']>
}

export const defaultPiRequestSettings = Object.fromEntries(
  keys.map((key) => [key, definition[key].default]),
) as PiRequestSettings

export async function readPiRequestSettings(
  handle: SettingsHandle<typeof definition>,
  file: string,
  previous: PiRequestSettings,
): Promise<PiRequestSettings> {
  const report = handle.report()
  const next = { ...previous }
  const read = async <K extends Key>(key: K) => {
    if (
      report.some(
        (entry) =>
          entry.file.kind === 'user' &&
          entry.file.path === file &&
          [
            'unreadable',
            'unparseable',
            'invalid-value',
            'duplicate-key',
            'invalid-schema-version',
            'newer-version-key-ignored',
          ].includes(entry.reason) &&
          (entry.keyPath.length === 0 || entry.keyPath[0] === key),
      )
    )
      return
    next[key] = await handle.get(key, { host: 'pi' })
  }
  await Promise.all(keys.map(read))
  return next
}

export function piEngineConfig(
  settings: () => PiRequestSettings,
): RequestConfig {
  return {
    get quiet_mode() {
      return settings().quiet_mode
    },
    get toast_scope() {
      return settings().toast_scope
    },
    get thinking_warmup() {
      return settings().thinking_warmup
    },
    get claude_tool_hardening() {
      return settings().claude_tool_hardening
    },
    get claude_prompt_auto_caching() {
      return settings().claude_prompt_auto_caching
    },
    get max_rate_limit_wait_seconds() {
      return settings().max_rate_limit_wait_seconds
    },
    get default_retry_after_seconds() {
      return settings().default_retry_after_seconds
    },
    get request_jitter_max_ms() {
      return settings().request_jitter_max_ms
    },
    get failure_ttl_seconds() {
      return settings().failure_ttl_seconds
    },
    // Selection is fixed. These settings are meaningful only when the engine
    // can distribute requests across a pool.
    quota_refresh_interval_minutes: 0,
    soft_quota_cache_ttl_minutes: 'auto',
    soft_quota_threshold_percent: 100,
    account_selection_strategy: 'sticky',
    pid_offset_enabled: false,
    cache_warmup_on_switch: false,
    scheduling_mode: 'balance',
    max_cache_first_wait_seconds: 0,
    switch_on_first_rate_limit: false,
    switch_account_delay_ms: 0,
    proactive_rotation_threshold_percent: 0,
  }
}
