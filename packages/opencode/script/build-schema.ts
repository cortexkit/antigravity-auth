import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityConfigSchema } from '../src/plugin/config/schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputPath = join(__dirname, '../assets/antigravity.schema.json')

// Use zod v4's built-in toJSONSchema method
const rawSchema = AntigravityConfigSchema.toJSONSchema({
  unrepresentable: 'any',
  override: (_ctx) => undefined, // Use default handling
}) as Record<string, unknown>

// Remove the "required" array since all fields have defaults and are optional
// This preserves backwards compatibility with the draft-07 schema behavior
delete rawSchema.required

const optionDescriptions: Record<string, string> = {
  quiet_mode:
    'Suppress most toast notifications (rate limit, account switching). Recovery toasts always shown.',
  debug: 'Enable debug logging to file.',
  log_dir: 'Custom directory for debug logs.',
  keep_thinking:
    'Preserve thinking blocks for Claude models using signature caching. May cause signature errors.',
  session_recovery:
    'Enable automatic session recovery from tool_result_missing errors.',
  auto_resume: 'Automatically send resume prompt after successful recovery.',
  resume_text: 'Custom text to send when auto-resuming after recovery.',
  empty_response_max_attempts:
    'Maximum retry attempts when Antigravity returns an empty response (no candidates).',
  empty_response_retry_delay_ms:
    'Delay in milliseconds between empty response retries.',
  tool_id_recovery:
    'Enable tool ID orphan recovery. Matches mismatched tool responses by function name or creates placeholders.',
  claude_tool_hardening:
    'Enable tool hallucination prevention for Claude models. Injects parameter signatures and strict usage rules.',
  claude_prompt_auto_caching:
    'Enable Claude prompt auto-caching by adding top-level cache_control when absent.',
  proactive_token_refresh:
    'Enable proactive background token refresh before expiry, ensuring requests never block.',
  proactive_refresh_buffer_seconds:
    'Seconds before token expiry to trigger proactive refresh.',
  proactive_refresh_check_interval_seconds:
    'Interval between proactive refresh checks in seconds.',
  auto_update: 'Enable automatic plugin updates.',
  quota_fallback:
    'Deprecated: accepted for backward compatibility but ignored at runtime. Gemini fallback between Antigravity and Gemini CLI is always enabled.',
  cli_first:
    'Prefer gemini-cli routing before Antigravity for Gemini models. When false (default), Antigravity is tried first and gemini-cli is fallback.',
  toast_scope:
    "Controls which sessions show toast notifications. 'root_only' (default) shows in root session only, 'all' shows in all sessions.",
  scheduling_mode:
    "Rate limit scheduling strategy. 'cache_first' (default) waits for cooldowns, 'balance' distributes across accounts, 'performance_first' picks fastest available.",
  max_cache_first_wait_seconds:
    'Maximum seconds to wait for a rate-limited account in cache_first mode before switching.',
  failure_ttl_seconds:
    'Time in seconds before a failed account is eligible for retry.',
  request_jitter_max_ms:
    'Maximum random jitter in milliseconds added to outgoing requests to avoid thundering herd.',
  soft_quota_threshold_percent:
    'Percentage of quota usage that triggers soft quota warnings and preemptive account switching.',
  quota_refresh_interval_minutes:
    'Interval in minutes between quota usage checks. Set to 0 to disable periodic checks.',
  soft_quota_cache_ttl_minutes:
    "TTL for cached soft quota data. 'auto' (default) calculates from refresh interval, or set a fixed number of minutes.",
  operator:
    'Runtime operator-controlled settings (mutable from /antigravity-* slash commands). Persists across restarts.',
}

const operatorRoutingDescriptions: Record<string, string> = {
  cli_first:
    'Override cli_first routing flag live (read by the fetch interceptor per request).',
  quota_style_fallback: 'Override quota_style_fallback routing flag live.',
}

const operatorKillswitchDescriptions: Record<string, string> = {
  enabled:
    'Enable the quota killswitch. Accounts whose freshest cached quota is below the threshold are excluded before dispatch.',
  minimum_remaining_percent:
    'Global threshold in percent (0-100). Accounts with freshest cached quota remaining at or below this value are excluded.',
  accounts:
    'Per-account overrides keyed by sha256(refreshToken).slice(0,12). No raw OAuth tokens are ever written.',
}

const operatorDescriptions: Record<string, string> = {
  log_level:
    'Runtime log level filter. Reads take effect immediately; persisted across restarts.',
}

const signatureCacheDescriptions: Record<string, string> = {
  enabled: 'Enable disk caching of thinking block signatures.',
  memory_ttl_seconds: 'In-memory TTL in seconds.',
  disk_ttl_seconds: 'Disk TTL in seconds.',
  write_interval_seconds: 'Background write interval in seconds.',
}

function addDescriptions(schema: Record<string, unknown>): void {
  const props = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined
  if (!props) return

  for (const [key, prop] of Object.entries(props)) {
    if (optionDescriptions[key]) {
      prop.description = optionDescriptions[key]
    }

    if (key === 'signature_cache' && prop.properties) {
      const cacheProps = prop.properties as Record<
        string,
        Record<string, unknown>
      >
      for (const [cacheKey, cacheProp] of Object.entries(cacheProps)) {
        if (signatureCacheDescriptions[cacheKey]) {
          cacheProp.description = signatureCacheDescriptions[cacheKey]
        }
      }
      prop.description =
        'Signature cache configuration for persisting thinking block signatures. Only used when keep_thinking is enabled.'
    }

    if (key === 'operator' && prop.properties) {
      const opProps = prop.properties as Record<string, Record<string, unknown>>
      for (const [opKey, opProp] of Object.entries(opProps)) {
        if (operatorDescriptions[opKey]) {
          opProp.description = operatorDescriptions[opKey]
        }
      }
      if (opProps.routing?.properties) {
        const routingProps = opProps.routing.properties as Record<
          string,
          Record<string, unknown>
        >
        for (const [rKey, rProp] of Object.entries(routingProps)) {
          if (operatorRoutingDescriptions[rKey]) {
            rProp.description = operatorRoutingDescriptions[rKey]
          }
        }
        opProps.routing.description =
          'Routing overrides applied live by the fetch interceptor.'
      }
      if (opProps.killswitch?.properties) {
        const ksProps = opProps.killswitch.properties as Record<
          string,
          Record<string, unknown>
        >
        for (const [kKey, kProp] of Object.entries(ksProps)) {
          if (operatorKillswitchDescriptions[kKey]) {
            kProp.description = operatorKillswitchDescriptions[kKey]
          }
        }
        opProps.killswitch.description =
          'Quota killswitch — drops candidates below the threshold before dispatch.'
      }
    }
  }
}

const definitions = rawSchema.definitions as
  | Record<string, Record<string, unknown>>
  | undefined
if (definitions?.AntigravityConfig) {
  addDescriptions(definitions.AntigravityConfig)
} else {
  addDescriptions(rawSchema)
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(rawSchema, null, 2)}\n`)

console.log(`Schema written to ${outputPath}`)
