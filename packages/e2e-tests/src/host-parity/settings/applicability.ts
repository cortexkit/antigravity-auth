import { ANTIGRAVITY_SETTINGS } from '../../../../core/src/settings/definition.ts'
import { type Custody, custodies, type Host } from '../cases.ts'

type Key = keyof typeof ANTIGRAVITY_SETTINGS.settings
export const hosts = ['opencode1', 'opencode2', 'pi'] as const satisfies Host[]

export type Proof =
  | { status: 'applied'; file: string; test: string; binding?: string }
  | {
      status: 'host-limited'
      package: string
      version: string
      file: string
      reason: string
    }
  | { status: 'single account by design' | 'not applicable'; reason: string }
  | { status: null; reason: string }

export const applied = (
  file: string,
  test: string,
  binding?: string,
): Proof => ({ status: 'applied', file, test, binding })
export const pending = (reason: string): Proof => ({ status: null, reason })
const notApplicable = (reason: string): Proof => ({
  status: 'not applicable',
  reason,
})
const single: Proof = {
  status: 'single account by design',
  reason:
    'Host parity specification, non-goals: no account rotation, pool health, killswitch or soft quota on Pi.',
}
const hostedCredentials = notApplicable(
  'accounts-features:D5: custody never opens or refreshes the local login.',
)
const v1Only = notApplicable(
  'Pi uses its own extension lifecycle, not packages/opencode/src/plugin/index.ts (OpenCode 1 recovery or updater).',
)
const piStreamOnly = notApplicable(
  'packages/pi/src/stream.ts uses streamGenerateContent, not buffered generation.',
)
const noOp = notApplicable(
  'request-wire:D9: retained for settings compatibility; no wire effect.',
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
const piEngine = `${pi}request-engine.ts`
const ocLocal = `${oc}fetch-interceptor.ts:323; ${ga}:1676`
const ocExecutor = `${ocLocal}; ${oc}fetch-interceptor.ts:507; ${ga}:1768`
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
    `${piEngine}:194`,
  )
const requestSettings = (host: Host, test: string, binding: string) =>
  applied(`${e2e}settings/request-settings.test.ts`, `${host} ${test}`, binding)

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
const defaultRetry = pending(
  'The existing fallback-delay proof uses the default of 60 seconds.',
)
const failureTtl = pending(
  'No non-default failure-count reset proof for the account manager.',
)
const kinds = (local: Proof, vault: Proof = local, host: Proof = vault) => ({
  local,
  vault,
  host,
})
const each = (
  opencode1: Proof | ReturnType<typeof kinds>,
  opencode2: Proof | ReturnType<typeof kinds>,
  pi: Proof | ReturnType<typeof kinds>,
) => ({ opencode1, opencode2, pi })
const pool = (oc1: Proof, oc2 = oc1) => each(oc1, oc2, single)
const localRefresh = (oc1: Proof, oc2: Proof) =>
  each(
    kinds(oc1, hostedCredentials),
    kinds(oc2, hostedCredentials),
    kinds(
      notApplicable(
        'packages/pi/src/index.ts uses native OAuth on-demand refresh rather than a proactive queue.',
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
const rateWait = pending(
  'Needs a non-default cumulative wait with the Pi fixed-account port.',
)
const backgroundEnabled = pending(
  'Needs a test of starting or suppressing the background quota producer for this source.',
)
const backgroundInterval = pending(
  'Needs a non-default polling cadence proof for this source.',
)
const poller = (test: string) =>
  applied(`${oc}ga-shared-vault-custody.test.ts`, test, `${ga}:2404`)

const matrix = {
  quiet_mode: each(
    pending('Needs a test suppressing a request notice on OpenCode 1.'),
    kinds(
      pending('The notice proof runs on the vault pipeline.'),
      gaNotice(
        'OpenCode 2 quiet_mode suppresses the engine verification notice in its session queue',
      ),
    ),
    pending('Needs a non-default setting test on the Pi request notice sink.'),
  ),
  toast_scope: each(
    v1Event('suppresses recovery toasts for child sessions in root-only scope'),
    kinds(
      pending('The notice proof runs on the vault pipeline.'),
      gaNotice(
        'OpenCode 2 toast_scope root_only suppresses the engine notice for a host child session',
      ),
    ),
    notApplicable(
      'packages/pi/src/request-engine.ts binds readSession to noSession, so notices have no child-session classification.',
    ),
  ),
  debug: each(
    v1Debug('keeps file debug enabled without TUI when only debug is true'),
    pending('Needs a non-default location debug test.'),
    pending('Needs a test of enabling pi-antigravity-debug.log.'),
  ),
  debug_tui: each(
    v1Debug('keeps debug_tui independent from debug in config'),
    pending('Needs a non-default location TUI diagnostic test.'),
    notApplicable(
      'packages/pi/src/request-diagnostics.ts does not inject TUI debug text.',
    ),
  ),
  log_dir: each(
    v1Debug('the config log_dir wins over the default folder'),
    pending('Needs a test of non-default location log output.'),
    kinds(piDiagnostic('local'), piDiagnostic('vault')),
  ),
  keep_thinking: each(
    pending(
      'Needs a test showing configured Claude thinking or a warmup on OpenCode 1.',
    ),
    pending(
      'Needs a test showing configured Claude thinking or a warmup on OpenCode 2.',
    ),
    applied(
      `${e2e}pi/ports.test.ts`,
      'keep_thinking enables Claude warmup bytes without calling the Pi hooks for the warmup',
      piEngine,
    ),
  ),
  thinking_warmup: each(
    pending('Needs a test toggling the optional warmup on OpenCode 1.'),
    pending('Needs a test toggling the optional warmup on OpenCode 2.'),
    applied(
      `${e2e}engine/warmup.test.ts`,
      'Pi does not count an auxiliary HTTP 422 without a terminal as a successful warmup',
      piEngine,
    ),
  ),
  cache_warmup_on_switch: pool(
    pending(
      'Needs a test suppressing the cache probe despite a real account switch.',
    ),
  ),
  session_recovery: each(
    pending('Existing recovery tests do not exercise session_recovery=false.'),
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
    pending('Needs a non-default setting test of signature cache behavior.'),
    pending('Needs a non-default setting test of the bound location cache.'),
    pending('Needs a non-default setting test of the Pi signature cache.'),
  ),
  empty_response_max_attempts: each(buffered, buffered, piStreamOnly),
  empty_response_retry_delay_ms: each(buffered, buffered, piStreamOnly),
  claude_tool_hardening: each(
    pending(
      'Needs a non-default setting test on the raw OpenCode 1 request path.',
    ),
    requestSettings('opencode2', hardening, ocExecutor),
    requestSettings('pi', hardening, piEngine),
  ),
  claude_prompt_auto_caching: each(noOp, noOp, noOp),
  proactive_token_refresh: localRefresh(
    pending(
      'Existing proactive refresh test uses the default enabled value; needs a non-default disable proof.',
    ),
    pending('Needs a non-default disable proof on the location refresh queue.'),
  ),
  proactive_refresh_buffer_seconds: localRefresh(
    pending('Needs a non-default refresh buffer proof.'),
    pending('Needs a non-default refresh buffer proof.'),
  ),
  proactive_refresh_check_interval_seconds: localRefresh(
    pending('Needs a non-default refresh check cadence proof.'),
    pending('Needs a non-default refresh check cadence proof.'),
  ),
  max_rate_limit_wait_seconds: each(wait, wait, rateWait),
  account_selection_strategy: pool(
    applied(
      engine,
      'concurrent cold round-robin sessions reserve the selector placement before slow advice',
      ocExecutor,
    ),
  ),
  pid_offset_enabled: pool(
    pending(
      'Needs a test of the enabled PID offset on the selected OpenCode pool.',
    ),
  ),
  switch_on_first_rate_limit: pool(
    pending(
      'Needs a non-default setting proof with a second eligible account.',
    ),
  ),
  max_account_switches: pool(
    pending('Needs a non-default account-switch cap proof.'),
  ),
  scheduling_mode: pool(
    pending(
      'Needs to isolate the non-default scheduling mode from the wait reason.',
    ),
  ),
  max_cache_first_wait_seconds: pool(
    pending('Needs to isolate a changed cache-first wait cap.'),
  ),
  failure_ttl_seconds: each(
    failureTtl,
    failureTtl,
    pending(
      'packages/pi/src/request-settings.ts passes the TTL to the engine, but packages/pi/src/request-pool.ts:75-79 ignores the TTL argument.',
    ),
  ),
  default_retry_after_seconds: each(defaultRetry, defaultRetry, defaultRetry),
  request_jitter_max_ms: each(
    requestSettings('opencode2', jitter, ocExecutor),
    requestSettings('opencode2', jitter, ocExecutor),
    requestSettings('pi', jitter, piEngine),
  ),
  switch_account_delay_ms: pool(
    pending(
      'Needs a test observing a non-default delay during an account switch.',
    ),
  ),
  soft_quota_threshold_percent: pool(
    pending('Needs a non-default threshold proof for the OpenCode selector.'),
  ),
  quota_refresh_interval_minutes: each(
    kinds(
      applied(
        engine,
        'disposal drains successful-send quota after-work without delaying the reply',
        ocLocal,
      ),
      pending(
        'App-level quota polling and the engine cadence are separate; needs a custody selector proof.',
      ),
    ),
    kinds(
      applied(
        engine,
        'disposal drains successful-send quota after-work without delaying the reply',
        ocLocal,
      ),
      pending(
        'App-level quota polling and the engine cadence are separate; needs a custody selector proof.',
      ),
    ),
    single,
  ),
  soft_quota_cache_ttl: pool(
    pending(
      'Needs to observe fresh vs stale eligibility after switching TTL mode.',
    ),
  ),
  soft_quota_cache_ttl_minutes: pool(
    pending(
      'Needs a proof that an explicit TTL changes fresh vs stale eligibility.',
    ),
  ),
  proactive_rotation_threshold_percent: pool(
    pending(
      'Needs a non-default rotation threshold proof with an eligible alternative.',
    ),
  ),
  health_score: each(
    kinds(
      applied(
        `${oc}auth-loader.test.ts`,
        'OpenCode 1 applies tracker settings to repository managers on load and reload',
      ),
      pending('Needs a non-default vault selector tracker test.'),
    ),
    kinds(
      applied(
        `${e2e}opencode2/location.test.ts`,
        'OpenCode 2 repository account manager uses configured health scores and token buckets',
      ),
      pending('Needs a non-default vault selector tracker test.'),
    ),
    single,
  ),
  token_bucket: each(
    kinds(
      applied(
        `${oc}auth-loader.test.ts`,
        'OpenCode 1 applies tracker settings to repository managers on load and reload',
      ),
      pending('Needs a non-default vault selector tracker test.'),
    ),
    kinds(
      applied(
        `${e2e}opencode2/location.test.ts`,
        'OpenCode 2 repository account manager uses configured health scores and token buckets',
      ),
      pending('Needs a non-default vault selector tracker test.'),
    ),
    single,
  ),
  background_quota_refresh: each(
    backgroundEnabled,
    kinds(
      backgroundEnabled,
      poller(
        'starts no producer while every location has background refresh off, and still checks on demand',
      ),
    ),
    single,
  ),
  background_quota_refresh_interval_minutes: each(
    backgroundInterval,
    kinds(
      backgroundInterval,
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
    pending('Needs a non-default logging filter proof on OpenCode 1.'),
    pending('Needs a non-default logging filter proof on OpenCode 2.'),
    pending(
      'Needs to show a record admitted by debug level that info would suppress.',
    ),
  ),
  account_models: each(
    kinds(ocLocalModels, ocVaultModels),
    kinds(ocLocalModels, ocVaultModels),
    kinds(
      notApplicable(
        'packages/pi/src/request-engine.ts uses the native Google slot without a vault route ID for the policy.',
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
