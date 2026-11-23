import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Static import-graph guards for the shared request engine.
 *
 * The core request executor is shared by both server adapters; nothing it loads,
 * including type-only imports, may pull in the OpenCode host SDK, a host
 * client binding, the sidebar file, account storage adapters or the
 * OpenCode 1 interceptor.
 */

const pluginDir = resolve(import.meta.dir, '..')
const srcDir = resolve(pluginDir, '..')
const coreSrc = resolve(srcDir, '../../core/src')
const engineDir = join(coreSrc, 'engine')
const ROOT = join(engineDir, 'request-services.ts')

// One static import/export statement per match. The clause cannot contain
// quotes, parentheses, `=` or `;`, so a match never runs on from an unrelated
// `export function` or `export const` into a later statement's specifier.
const IMPORT_PATTERN =
  /^\s*(import|export)\s+(type\s+)?(?:([^'";()=]*?)\s+from\s+)?['"]([^'"]+)['"]/gm

interface Edge {
  from: string
  to: string
  /** True when every edge on the path so far is `import type`/`export type`. */
  typeOnly: boolean
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (/\.(ts|js)$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return null
}

/** Whether an import clause only names types (`import type` or all `type x`). */
function isTypeOnly(keyword: string | undefined, clause: string | undefined) {
  if (keyword) return true
  if (!clause) return false
  const braces = clause.match(/^\{([\s\S]*)\}$/)
  if (!braces?.[1]) return false
  const names = braces[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return names.length > 0 && names.every((name) => name.startsWith('type '))
}

/**
 * Walks every static import from `root`. A file reached only through
 * type-only edges is recorded as such; one value edge anywhere makes it a
 * value dependency.
 */
function walkGraph(root: string) {
  const valueFiles = new Set<string>()
  const typeFiles = new Set<string>()
  const external: Edge[] = []
  const edges: Edge[] = []
  const visit = (file: string, typeOnly: boolean) => {
    if (
      typeOnly
        ? typeFiles.has(file) || valueFiles.has(file)
        : valueFiles.has(file)
    ) {
      return
    }
    if (typeOnly) typeFiles.add(file)
    else {
      valueFiles.add(file)
      typeFiles.delete(file)
    }
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)) {
      const spec = match[4] ?? ''
      const edgeTypeOnly = typeOnly || isTypeOnly(match[2], match[3]?.trim())
      if (!spec.startsWith('.')) {
        external.push({ from: file, to: spec, typeOnly: edgeTypeOnly })
        continue
      }
      const target = resolveRelative(file, spec)
      if (!target) continue
      edges.push({ from: file, to: target, typeOnly: edgeTypeOnly })
      visit(target, edgeTypeOnly)
    }
  }
  visit(root, false)
  return { valueFiles, typeFiles, external, edges }
}

const rel = (file: string) => relative(srcDir, file)

/** OpenCode 1 host bindings and account adapters the engine must not load. */
const FORBIDDEN_FILES = [
  'plugin/types.ts',
  'plugin/fetch-interceptor.ts',
  'plugin/dependencies.ts',
  'plugin/index.ts',
  'plugin/auth-loader.ts',
  'plugin/accounts.ts',
  'plugin/account-access.ts',
  'plugin/token.ts',
  'plugin/project.ts',
  'plugin/quota.ts',
  'plugin/rotation.ts',
  'plugin/server.ts',
  'sidebar-state.ts',
]

describe('shared request engine import graph', () => {
  const graph = walkGraph(ROOT)

  it('loads no host SDK, host client binding, sidebar file or account adapter at runtime', () => {
    const forbiddenValues = [...graph.valueFiles]
      .map(rel)
      .filter((file) => FORBIDDEN_FILES.includes(file))
    const sdkValueImports = graph.external
      .filter((edge) => !edge.typeOnly && edge.to.startsWith('@opencode-ai/'))
      .map((edge) => `${rel(edge.from)} -> ${edge.to}`)

    expect(graph.valueFiles.has(join(engineDir, 'fetch-routing.ts'))).toBe(true)
    expect(forbiddenValues).toEqual([])
    expect(sdkValueImports).toEqual([])
  })

  it('does not reach OpenCode files even through type imports', () => {
    const forbiddenEdges = graph.edges
      .filter((edge) => edge.to.startsWith(`${srcDir}/`))
      .map((edge) => `${rel(edge.from)} -> ${rel(edge.to)}`)
    const sdkFromAllowedFiles = graph.external
      .filter((edge) => edge.to.startsWith('@opencode-ai/'))
      .map((edge) => rel(edge.from))
      .filter((file) => !FORBIDDEN_FILES.includes(file))

    expect([...new Set(forbiddenEdges)].sort()).toEqual([])
    expect(sdkFromAllowedFiles).toEqual([])
  })

  it('imports exactly its declared collaborators and no module-level OpenCode 1 binding', () => {
    // Every runtime value the engine imports (or re-exports) is a pure
    // function, constant or class; stateful collaborators arrive through
    // RequestServicesDeps. A new import must be added here deliberately.
    const source = readFileSync(ROOT, 'utf8')
    const imports: Record<string, string[]> = {}
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const spec = match[4] ?? ''
      const names = (match[3] ?? '')
        .replace(/[{}]/g, '')
        .split(',')
        .map((name) => name.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .map((name) => (match[2] ? `type ${name}` : name))
      imports[spec] = [...(imports[spec] ?? []), ...names].sort()
    }

    expect(imports).toEqual({
      'node:crypto': ['createHash', 'randomUUID'],
      '../agy-transport.ts': ['AgyResponseHeaderTimeoutError'],
      '../index.ts': [
        'HostRefusalError',
        'MAX_UNCONFIRMED_RATE_LIMIT_RETRIES',
        'PRE_RESPONSE_DEADLINE_MS',
        'PreResponseDeadline',
        'PreResponseTimeoutError',
        'VAULT_ACCOUNT_REMEDY',
        'accessTokenExpired',
        'calculateBackoffMs',
        'computeSoftQuotaCacheTtlMs',
        'getPublicModelDefinitions',
        'getQuotaKey',
        'getResolverAliasMap',
        'isClaudeThinkingModel',
        'isImageGenerationModel',
        'isRetiredAgyModel',
        'isUpstreamFailure',
        'markUpstreamFailure',
        'parseRateLimitReason',
        'parseRefreshParts',
        'preserveResponseMetadata',
        'quotaAccountIdentity',
        'quotaExhaustedUntil',
        'redactCredentialError',
        'redactCredentialResponse',
        'redactCredentialText',
        'resolveQuotaGroup',
        'systemInstructionHasHarnessIdentity',
        'type AccountManager as CoreAccountManager',
        'type AgyTransportOptions',
        'type Fingerprint',
        'type HealthScoreTracker',
        'type ManagedAccount',
        'type OAuthAuthDetails',
        'type PreResponseClock',
        'type ProjectContextResult',
        'type QuotaGroup',
        'type QuotaGroupSummary',
        'type QuotaManager',
        'type TokenBucketTracker',
        'type VaultConditionInput',
        'type VaultConditionOutcome',
        'unconfirmedRateLimitDelayMs',
      ],
      '../constants.ts': [
        'ANTIGRAVITY_ENDPOINT_DAILY',
        'ANTIGRAVITY_ENDPOINT_FALLBACKS',
      ],
      '../model-access.ts': ['type ModelAccessPolicy'],
      './errors.ts': ['AntigravityKillswitchError'],
      './fetch/retry-state.ts': [
        'createRetryState',
        'type RateLimitBackoffResult',
        'type RetryState',
      ],
      './fetch/warmup.ts': ['createWarmupState', 'type WarmupState'],
      './fetch-routing.ts': [
        'MAX_TOTAL_CAPACITY_RETRIES',
        'extractModelFromUrl',
        'getModelFamilyFromUrl',
        'isCapacityRetryBudgetExhausted',
        'toUrlString',
        'toWarmupStreamUrl',
      ],
      './killswitch.ts': ['evaluateKillswitchForAccount', 'throwIfAllKilled'],
      './ports.ts': [
        'type RequestConfig',
        'type RequestDebug',
        'type RequestDump',
        'type RequestLogger',
        'type RequestOperatorSettings',
        'type RequestSessionIdentity',
        'type RequestSessions',
      ],
      './request.ts': ['type PrepareRequestOptions', 'type RequestWire'],
      './refusals.ts': [
        'EngineRefusalError',
        'engineRefusalResponse',
        'rememberResponseRefusal',
        'responseRefusal',
      ],
      './request-helpers.ts': [
        'createSyntheticTextResponse',
        'isEmptyResponseBody',
      ],
      './retry-metadata.ts': [
        'createNativeGoogleErrorResponse as nativeErrorResponse',
        'extractAntigravityError',
        'extractRateLimitErrorInfoReason',
        'resolveRetryMetadata',
      ],
      './after-handoff.ts': [
        'createAfterHandoff',
        'type RegisterResponseHandoff',
      ],
      './local-grant.ts': [
        'LocalGrantSupersededError',
        'isLocalGrantError',
        'type CapturedLocalGrant',
      ],
      './request-cancellation.ts': [
        'attachResponseCleanup',
        'createRequestCancellation',
        'getResponseCleanup',
        'retainResponseLifetime',
      ],
      './routing-port.ts': [
        'type BillingRequestKind',
        'type RequestRouting',
        'type RoutingCandidate',
        'type RoutingExhaustion',
        'type RoutingIdentity',
        'type RoutingRefusal',
      ],
      './vault-billing.ts': ['VaultBillingAttempt'],
      './vault-routing.ts': [
        'observeVaultServed',
        'observeVaultUpstream',
        'reportVaultExhaustion',
        'type VaultExhaustionProof',
      ],
    })
  })

  it('keeps the core root from loading the engine', () => {
    const core = walkGraph(join(coreSrc, 'index.ts'))
    const engineImports = [...core.valueFiles].filter((file) =>
      file.startsWith(`${engineDir}/`),
    )
    expect(engineImports).toEqual([])
  })

  it('keeps content endpoint failover in the request engine and quota on daily', () => {
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
        if (
          readFileSync(path, 'utf8').includes('ANTIGRAVITY_ENDPOINT_FALLBACKS')
        ) {
          importers.push(rel(path))
        }
      }
    }
    walk(srcDir)
    walk(engineDir)

    expect(importers.sort()).toEqual([rel(ROOT)])
    expect(readFileSync(join(srcDir, 'plugin/quota.ts'), 'utf8')).toContain(
      'ANTIGRAVITY_QUOTA_ENDPOINT',
    )
  })
})
