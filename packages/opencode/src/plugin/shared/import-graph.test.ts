import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Static import-graph guards for the shared request engine.
 *
 * The GA location reaches `shared/request-services.ts`; nothing it loads,
 * including type-only imports, may pull in the OpenCode host SDK, a host
 * client binding, the sidebar file, account storage adapters or the
 * OpenCode 1 interceptor.
 */

const pluginDir = resolve(import.meta.dir, '..')
const srcDir = resolve(pluginDir, '..')
const ROOT = join(pluginDir, 'shared', 'request-services.ts')

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

/**
 * Type-only edges into a forbidden file that exist today and have a named
 * owner outside this engine. `request.ts` takes `detectErrorType` from the
 * session-recovery module, whose own `PluginClient` parameter types reach
 * `types.ts`; that module's owner moves the classifier to a neutral module.
 * Anything else that reaches a forbidden file fails.
 */
const KNOWN_TYPE_ONLY_EDGES = ['plugin/recovery.ts -> plugin/types.ts']

describe('shared request engine import graph', () => {
  const graph = walkGraph(ROOT)

  it('loads no host SDK, host client binding, sidebar file or account adapter at runtime', () => {
    const forbiddenValues = [...graph.valueFiles]
      .map(rel)
      .filter((file) => FORBIDDEN_FILES.includes(file))
    const sdkValueImports = graph.external
      .filter((edge) => !edge.typeOnly && edge.to.startsWith('@opencode-ai/'))
      .map((edge) => `${rel(edge.from)} -> ${edge.to}`)

    expect(graph.valueFiles.has(join(pluginDir, 'fetch-routing.ts'))).toBe(true)
    expect(forbiddenValues).toEqual([])
    expect(sdkValueImports).toEqual([])
  })

  it('reaches a forbidden file through types only on the recorded edges', () => {
    const forbiddenEdges = graph.edges
      .filter((edge) => FORBIDDEN_FILES.includes(rel(edge.to)))
      .map((edge) => `${rel(edge.from)} -> ${rel(edge.to)}`)
    const sdkFromAllowedFiles = graph.external
      .filter((edge) => edge.to.startsWith('@opencode-ai/'))
      .map((edge) => rel(edge.from))
      .filter((file) => !FORBIDDEN_FILES.includes(file))

    expect([...new Set(forbiddenEdges)].sort()).toEqual(KNOWN_TYPE_ONLY_EDGES)
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
      '@cortexkit/antigravity-auth-core': [
        'accessTokenExpired',
        'calculateBackoffMs',
        'computeSoftQuotaCacheTtlMs',
        'getPublicModelDefinitions',
        'getResolverAliasMap',
        'isImageGenerationModel',
        'parseRateLimitReason',
        'resolveQuotaGroup',
        'type AccountManager as CoreAccountManager',
        'type AgyTransportOptions',
        'type Fingerprint',
        'type HealthScoreTracker',
        'type ManagedAccount',
        'type OAuthAuthDetails',
        'type ProjectContextResult',
        'type QuotaGroup',
        'type QuotaGroupSummary',
        'type QuotaManager',
        'type TokenBucketTracker',
      ],
      '../../constants': ['ANTIGRAVITY_ENDPOINT_FALLBACKS', 'type HeaderStyle'],
      '../config': ['type AntigravityConfig'],
      '../debug': ['type LocationDebug'],
      '../errors': ['AntigravityKillswitchError'],
      '../fetch/retry-state': [
        'createRetryState',
        'type RateLimitBackoffResult',
        'type RetryState',
      ],
      '../fetch/warmup': ['createWarmupState', 'type WarmupState'],
      '../fetch-routing': [
        'MAX_TOTAL_CAPACITY_RETRIES',
        'extractModelFromUrl',
        'getModelFamilyFromUrl',
        'isCapacityRetryBudgetExhausted',
        'resolveHeaderRoutingDecision',
        'resolveQuotaFallbackHeaderStyle',
        'toUrlString',
        'toWarmupStreamUrl',
      ],
      '../gemini-dump': ['noteGeminiDumpResponse', 'type GeminiDumpState'],
      '../killswitch': ['evaluateKillswitchForAccount', 'throwIfAllKilled'],
      '../logger': ['type Logger'],
      '../operator-settings': ['type OperatorSettingsController'],
      '../request': [
        'type PrepareRequestOptions',
        'type buildThinkingWarmupBody',
        'type getImageModelLocalTitle',
        'type getLastCacheStats',
        'type prepareAntigravityRequest',
        'type transformAntigravityResponse',
      ],
      '../request-helpers': [
        'createNativeGoogleErrorResponse',
        'createSyntheticTextResponse',
        'isEmptyResponseBody',
      ],
      '../session-context': [
        'extractOpenCodeSessionIdentity',
        'type AgySessionRegistry',
        'type OpenCodeSessionIdentity',
      ],
      './local-grant': [
        'LocalGrantSupersededError',
        'isLocalGrantError',
        'type CapturedLocalGrant',
      ],
    })
  })

  it('keeps the Antigravity endpoint fallback list imported only by the engine and quota', () => {
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

    expect(importers.sort()).toEqual([
      'plugin/quota.ts',
      'plugin/shared/request-services.ts',
    ])
  })
})
