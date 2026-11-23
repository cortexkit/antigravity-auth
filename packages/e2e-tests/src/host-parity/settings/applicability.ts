import { ANTIGRAVITY_SETTINGS } from '../../../../core/src/settings/definition.ts'
import { type Custody, custodies, type Host } from '../cases.ts'

type Key = keyof typeof ANTIGRAVITY_SETTINGS.settings
const hosts = ['opencode1', 'opencode2', 'pi'] as const satisfies Host[]

type Proof =
  | {
      status: 'applied'
      file: string
      test: string
      binding?: string
      titleFragment?: string
    }
  | {
      status: 'host-limited'
      package: string
      version: string
      file: string
      reason: string
    }
  | {
      status: 'single account by design' | 'not applicable'
      reason: string
      binding: string
    }

const applied = (
  file: string,
  test: string,
  binding?: string,
  titleFragment?: string,
): Proof => ({ status: 'applied', file, test, binding, titleFragment })
const notApplicable = (reason: string, binding: string): Proof => ({
  status: 'not applicable',
  reason,
  binding,
})
const single: Proof = {
  status: 'single account by design',
  reason:
    'Pi binds one account and has no account rotation, pool health, killswitch or soft quota.',
  binding:
    'packages/pi/src/request-pool.ts:48; packages/pi/src/request-settings.ts:93',
}
const hostedCredentials = notApplicable(
  'Vault custody admits the selected route for a send; it does not refresh a local login.',
  'packages/opencode/src/plugin/shared/vault-request-credentials.ts; packages/pi/src/request-engine.ts:245',
)
const v1Only = notApplicable(
  'Pi uses its own extension lifecycle, not the OpenCode 1 recovery and update hooks.',
  'packages/pi/src/index.ts; packages/opencode/src/plugin/index.ts:588',
)
const piStreamOnly = notApplicable(
  'Pi uses streamGenerateContent, not buffered generation.',
  'packages/pi/src/stream.ts',
)
const noOp = notApplicable(
  'Accepted for settings compatibility only; no request engine path reads it.',
  'packages/core/src/settings/definition.ts; packages/core/src/engine/ports.ts',
)
const gaRecovery: Proof = {
  status: 'host-limited',
  package: '@opencode/plugin',
  version: '2.0.22',
  file: 'packages/plugin/src/promise/session.ts',
  reason:
    'The published session hooks do not offer the failed-message repair and prompt recovery hooks used on OpenCode 1.',
}
const gaUpdates: Proof = {
  status: 'host-limited',
  package: '@opencode/plugin',
  version: '2.0.22',
  file: 'packages/plugin/src/promise/plugin.ts',
  reason:
    'The setup context does not offer a plugin-update operation; the host manages updates.',
}

const e2e = 'packages/e2e-tests/src/host-parity/'
const oc = 'packages/opencode/src/plugin/'
const pi = 'packages/pi/src/'
const engine = `${oc}shared/request-services.test.ts`
const event = `${oc}event-handler.test.ts`
const ga = `${oc}ga-location-services.ts`
const v1 = `${oc}index.ts`
const piEngine = `${pi}request-engine.ts:169`
const piWire = `${pi}request-engine.ts:99; ${piEngine}`
const ocLocal = `${oc}fetch-interceptor.ts:323; ${ga}:1676`
const ocExecutor = `${ocLocal}; ${oc}fetch-interceptor.ts:507; ${ga}:1768`
const ocWire = `${oc}fetch-interceptor.ts:257; ${ga}:1644; ${ga}:1676; ${ga}:1768`
const oc1Wire = `${oc}fetch-interceptor.ts:257; ${oc}request.ts:58`
const runtime = `${oc}shared/runtime.ts`
const selector = 'packages/core/src/account-selector.test.ts'
const selectorBinding = `${ocExecutor}; packages/core/src/account-manager.ts:481; ${oc}shared/vault-request-credentials.ts:903`
const executorProof = (test: string, binding = ocExecutor) =>
  applied(`${e2e}settings/executor-settings.test.ts`, test, binding)
const requestProof = (test: string, binding: string) =>
  applied(`${e2e}settings/request-settings.test.ts`, test, binding)
const v1Debug = (test: string) =>
  applied(`${oc}debug.test.ts`, test, `${v1}:225`)
const v1Event = (test: string) => applied(event, test, `${v1}:596`)
const gaNotice = (test: string) =>
  applied(`${e2e}settings/opencode2-notices.test.ts`, test)
const piDiagnostic = (custody: 'local' | 'vault') =>
  applied(
    `${pi}stream.test.ts`,
    custody === 'local'
      ? 'keeps credentials out of Pi transport refusals and masks the plugin diagnostic'
      : 'uses the genuinely served opaque vault token at the Pi transport boundary',
    `${pi}request-engine.ts:194`,
    custody === 'local'
      ? 'refusals and masks the plugin diagnostic'
      : 'uses the genuinely served opaque vault token at the Pi',
  )
const requestSettings = (host: Host, test: string, binding: string) =>
  applied(
    `${e2e}settings/request-settings.test.ts`,
    `${host} ${test}`,
    binding,
    test,
  )

const modelPolicy = `${oc}shared/model-access-requests.test.ts`
const ocLocalModels = applied(
  modelPolicy,
  'skips an account whose list forbids the model and serves from the allowed one',
  ocLocal,
)
const ocVaultModels = applied(
  modelPolicy,
  'keys vault lists by the roster route id, never the account identity',
  ocExecutor,
)
const piVaultModels = applied(
  `${pi}model-access.test.ts`,
  'refuses a model the vault account does not list before anything is sent, and serves a listed one',
  `${pi}vault-source.ts`,
)
const defaultRetry = executorProof(
  'a configured retry fallback sets the next eligible time when Google supplies no delay',
)
const failureTtl = executorProof(
  'confirmed failures on both account stores expire on the configured TTL',
  selectorBinding,
)
const kinds = (local: Proof, vault: Proof = local, host: Proof = vault) => ({
  local,
  vault,
  host,
})
type HostProof = Proof | ReturnType<typeof kinds>
const each = (opencode1: HostProof, opencode2: HostProof, pi: HostProof) => ({
  opencode1,
  opencode2,
  pi,
})
const pool = (oc1: HostProof, oc2 = oc1) => each(oc1, oc2, single)
const localRefresh = (oc1: Proof, oc2: Proof) =>
  each(
    kinds(oc1, hostedCredentials),
    kinds(oc2, hostedCredentials),
    kinds(
      notApplicable(
        'Pi uses the native Google login and has no proactive token queue.',
        `${pi}index.ts; ${pi}request-engine.ts:290`,
      ),
      hostedCredentials,
    ),
  )

const jitter = 'applies request jitter before the first physical send'
const hardening =
  'disables the Claude tool instruction without removing the tool'
const buffered = applied(
  `${e2e}settings/buffered-settings.test.ts`,
  'buffered empty replies use the configured attempt count and delay',
  ocExecutor,
)
const wait = applied(
  engine,
  'a long individual quota reset does not extend the caller wait budget',
  ocExecutor,
)
const rateWait = requestProof(
  'Pi uses the configured wait budget and fallback when a quota reply lacks timing',
  piEngine,
)
const ocNotices = executorProof(
  'quiet mode and root-only scope suppress shared engine notices',
  `${ocExecutor}; ${oc}fetch-interceptor.ts:269; ${ga}:1722`,
)
const oc1Thinking = executorProof(
  'the OpenCode 1 wire obeys thinking warmup and Claude tool hardening settings',
  oc1Wire,
)
const warmup =
  'emits a thinking warmup only when preservation and warmup are both enabled'
const oc2Debug = requestProof(
  'OpenCode 2 writes request diagnostics only when enabled and in the location log directory',
  `${runtime}:467; ${ga}:1645`,
)
const oc2Thinking = applied(
  `${e2e}opencode2/location.test.ts`,
  'OpenCode 2 shows thinking once in each location even when host session ids collide',
  `${runtime}:477; ${ga}:1644`,
)
const piDebug = requestProof(
  'Pi settings independently gate the debug file and debug-level request records',
  `${pi}request-engine.ts:79; ${pi}request-engine.ts:194`,
)
const queueTiming = applied(
  `${oc}refresh-queue.test.ts`,
  'uses the configured refresh buffer and schedules checks at the configured interval',
  `${oc}auth-loader.ts:418; ${runtime}:594`,
)
const scheduling = executorProof(
  'first classified limit switches or retries according to the scheduling settings',
)
const switchBudget = executorProof(
  'the configured account-switch cap and delay control sends after confirmed limits',
)
const quotaThreshold = executorProof(
  'the soft quota threshold and automatic or explicit TTL determine which account sends',
  selectorBinding,
)
const localQuotaCadence = executorProof(
  'the local quota refresh interval enables or skips an advisory refresh after a send',
  `${oc}fetch-interceptor.ts:317; ${ga}:1690`,
)
const oc1Poller = (test: string, titleFragment?: string) =>
  applied(
    `${oc}background-quota-refresh.test.ts`,
    test,
    `${v1}:519; ${v1}:550`,
    titleFragment,
  )
const oc2Runtime = (test: string, binding: string) =>
  applied(`${oc}shared/runtime.test.ts`, test, binding)
const vaultTrackers = executorProof(
  'vault routes use configured tracker scores and token balances on a successful dispatch',
  `${v1}:338; ${oc}fetch-interceptor.ts:502; ${ga}:2010; ${ga}:1781`,
)
const poller = (test: string) =>
  applied(`${oc}ga-shared-vault-custody.test.ts`, test, `${ga}:2404`)

const matrix = {
  quiet_mode: each(
    ocNotices,
    kinds(
      ocNotices,
      gaNotice(
        'OpenCode 2 quiet_mode suppresses the engine verification notice in its session queue',
      ),
    ),
    requestProof(
      'Pi quiet mode suppresses the rate-limit notice without changing the refusal',
      `${pi}request-engine.ts:205`,
    ),
  ),
  toast_scope: each(
    v1Event('suppresses recovery toasts for child sessions in root-only scope'),
    kinds(
      ocNotices,
      gaNotice(
        'OpenCode 2 toast_scope root_only suppresses the engine notice for a host child session',
      ),
    ),
    notApplicable(
      'Pi does not supply a parent session for request notices.',
      `${pi}request-engine.ts:180; ${pi}stream.ts:200`,
    ),
  ),
  debug: each(
    v1Debug('keeps file debug enabled without TUI when only debug is true'),
    oc2Debug,
    piDebug,
  ),
  debug_tui: each(
    v1Debug('keeps debug_tui independent from debug in config'),
    oc2Thinking,
    notApplicable(
      'Pi disables injection of TUI debug text into the response.',
      `${pi}request-engine.ts:128`,
    ),
  ),
  log_dir: each(
    v1Debug('the config log_dir wins over the default folder'),
    oc2Debug,
    kinds(piDiagnostic('local'), piDiagnostic('vault')),
  ),
  keep_thinking: each(
    oc1Thinking,
    requestSettings('opencode2', warmup, ocWire),
    applied(
      `${e2e}pi/ports.test.ts`,
      'keep_thinking enables Claude warmup bytes without calling the Pi hooks for the warmup',
      piWire,
    ),
  ),
  thinking_warmup: each(
    oc1Thinking,
    requestSettings('opencode2', warmup, ocWire),
    requestSettings('pi', warmup, piWire),
  ),
  cache_warmup_on_switch: pool(
    executorProof(
      'disabling cache warmup skips the probe without preventing account switching',
    ),
  ),
  session_recovery: each(
    v1Event(
      'does not install the session recovery hook when session recovery is disabled',
    ),
    gaRecovery,
    v1Only,
  ),
  auto_resume: each(
    v1Event(
      'does not resume when recovery is skipped, fails, or auto-resume is disabled',
    ),
    gaRecovery,
    v1Only,
  ),
  resume_text: each(
    v1Event('recovers a session error, resumes it, and shows a success toast'),
    gaRecovery,
    v1Only,
  ),
  signature_cache: each(
    applied(
      `${oc}cache.test.ts`,
      'returns no disk cache when the signature cache is disabled',
      `${v1}:266; ${oc}request.ts:63`,
    ),
    oc2Thinking,
    requestProof(
      'Pi reuses a signed thought only while its signature cache is enabled',
      piWire,
    ),
  ),
  empty_response_max_attempts: each(buffered, buffered, piStreamOnly),
  empty_response_retry_delay_ms: each(buffered, buffered, piStreamOnly),
  claude_tool_hardening: each(
    oc1Thinking,
    requestSettings('opencode2', hardening, ocWire),
    requestSettings('pi', hardening, piWire),
  ),
  claude_prompt_auto_caching: each(noOp, noOp, noOp),
  proactive_token_refresh: localRefresh(
    applied(
      `${oc}auth-loader.test.ts`,
      'OpenCode 1 binds a repository without starting a disabled proactive refresh queue',
      `${oc}auth-loader.ts:418`,
    ),
    oc2Runtime(
      'starts no refresh queue when proactive refresh is off',
      `${runtime}:587; ${ga}:1675`,
    ),
  ),
  proactive_refresh_buffer_seconds: localRefresh(queueTiming, queueTiming),
  proactive_refresh_check_interval_seconds: localRefresh(
    queueTiming,
    queueTiming,
  ),
  max_rate_limit_wait_seconds: each(wait, wait, rateWait),
  account_selection_strategy: pool(
    kinds(
      applied(
        `${oc}accounts.test.ts`,
        'rotates to next account on each call',
        ocLocal,
      ),
      applied(
        selector,
        'a bare selector over credential-free rows reproduces them too',
        selectorBinding,
      ),
    ),
  ),
  pid_offset_enabled: pool(
    kinds(
      applied(
        selector,
        'the pool-file manager reproduces the recorded outputs',
        selectorBinding,
      ),
      applied(
        selector,
        'a bare selector over credential-free rows reproduces them too',
        selectorBinding,
      ),
    ),
  ),
  switch_on_first_rate_limit: pool(scheduling),
  max_account_switches: pool(switchBudget),
  scheduling_mode: pool(scheduling),
  max_cache_first_wait_seconds: pool(scheduling),
  failure_ttl_seconds: each(
    failureTtl,
    failureTtl,
    applied(
      `${pi}request-pool.test.ts`,
      'Pi resets the confirmed quota backoff ladder after the configured failure TTL',
      `${piEngine}; ${pi}request-engine.ts:172; ${pi}request-settings.ts:90`,
    ),
  ),
  default_retry_after_seconds: each(defaultRetry, defaultRetry, rateWait),
  request_jitter_max_ms: each(
    requestSettings('opencode2', jitter, ocExecutor),
    requestSettings('opencode2', jitter, ocExecutor),
    requestSettings('pi', jitter, piEngine),
  ),
  switch_account_delay_ms: pool(switchBudget),
  soft_quota_threshold_percent: pool(quotaThreshold),
  quota_refresh_interval_minutes: each(
    kinds(localQuotaCadence, quotaThreshold),
    kinds(localQuotaCadence, quotaThreshold),
    single,
  ),
  soft_quota_cache_ttl: pool(quotaThreshold),
  soft_quota_cache_ttl_minutes: pool(quotaThreshold),
  proactive_rotation_threshold_percent: pool(
    executorProof(
      'a non-default proactive rotation threshold changes the account on the next turn',
      selectorBinding,
    ),
  ),
  health_score: each(
    kinds(
      applied(
        `${oc}auth-loader.test.ts`,
        'OpenCode 1 applies tracker settings to repository managers on load and reload',
      ),
      vaultTrackers,
    ),
    kinds(
      applied(
        `${e2e}opencode2/location.test.ts`,
        'OpenCode 2 repository account manager uses configured health scores and token buckets',
      ),
      vaultTrackers,
    ),
    single,
  ),
  token_bucket: each(
    kinds(
      applied(
        `${oc}auth-loader.test.ts`,
        'OpenCode 1 applies tracker settings to repository managers on load and reload',
      ),
      vaultTrackers,
    ),
    kinds(
      applied(
        `${e2e}opencode2/location.test.ts`,
        'OpenCode 2 repository account manager uses configured health scores and token buckets',
      ),
      vaultTrackers,
    ),
    single,
  ),
  background_quota_refresh: each(
    kinds(
      oc1Poller(
        'background_quota_refresh: false → NO poller instance is constructed',
      ),
      oc1Poller(
        'composes a vault producer under the same config flag and awaits disposal',
      ),
    ),
    kinds(
      oc2Runtime(
        'builds each location from its own configuration and fresh defaults',
        `${runtime}:539`,
      ),
      poller(
        'starts no producer while every location has background refresh off, and still checks on demand',
      ),
    ),
    single,
  ),
  background_quota_refresh_interval_minutes: each(
    kinds(
      oc1Poller(
        'background_quota_refresh: true → exactly one poller is constructed and its dispose is registered',
      ),
      oc1Poller(
        'composes a vault producer under the same config flag and awaits disposal',
      ),
    ),
    kinds(
      oc2Runtime(
        'schedules local quota checks at the configured non-default interval',
        `${runtime}:539`,
      ),
      poller(
        'runs at the shortest enabled interval and stops when no enabled location remains',
      ),
    ),
    single,
  ),
  auto_update: each(
    applied(
      `${oc}../hooks/auto-update-checker/index.test.ts`,
      'shows notification but does not update when autoUpdate is false',
      `${v1}:592-597`,
    ),
    gaUpdates,
    v1Only,
  ),
  killswitch: each(
    kinds(
      applied(
        engine,
        'refuses with a native 412 once a fresh reading is below the floor',
        ocLocal,
      ),
      applied(
        engine,
        'routing candidates exclude the operator killswitch mask',
        ocExecutor,
      ),
    ),
    kinds(
      applied(
        engine,
        'refuses with a native 412 once a fresh reading is below the floor',
        ocLocal,
      ),
      applied(
        engine,
        'routing candidates exclude the operator killswitch mask',
        ocExecutor,
      ),
    ),
    single,
  ),
  log_level: each(
    requestProof(
      'OpenCode 1 log level filters the host log without losing warnings',
      `${v1}:577`,
    ),
    oc2Runtime(
      'location log level filters debug records without losing warnings',
      `${runtime}:470`,
    ),
    piDebug,
  ),
  account_models: each(
    kinds(ocLocalModels, ocVaultModels),
    kinds(ocLocalModels, ocVaultModels),
    kinds(
      notApplicable(
        'Pi uses the native Google slot without a vault route ID for the policy.',
        `${pi}request-engine.ts:271; ${pi}vault-source.ts`,
      ),
      piVaultModels,
    ),
  ),
} satisfies Record<Key, ReturnType<typeof each>>

export const rows = (Object.keys(matrix) as Key[]).flatMap((key) =>
  hosts.flatMap((host) =>
    custodies.map((custody: Custody) => {
      const entry = matrix[key][host]
      return {
        key,
        host,
        custody,
        scope:
          ANTIGRAVITY_SETTINGS.settings[key].project === 'allowed'
            ? 'project'
            : 'user-only',
        proof: 'status' in entry ? entry : entry[custody],
      } as const
    }),
  ),
)
