import {
  getAntigravityOpencodeModelIds,
  getResolverAliasMap,
} from './model-registry.ts'
import { resolveModelWithTier } from './transform/model-resolver.ts'

/** Local row ids and vault roster routeIds are opaque, host-local keys. */
export type AccountModels = Readonly<Record<string, readonly string[]>>

export interface ModelAccessIssue {
  readonly reason:
    | 'unusable-setting'
    | 'invalid-list'
    | 'empty-list'
    | 'unknown-model'
    | 'unknown-only'
  readonly accountKey?: string
  readonly modelId?: string
}

export interface ModelAccessPolicy {
  /** Whether the supplied setting is usable, not whether a fallback was usable. */
  readonly valid: boolean
  readonly issues: readonly ModelAccessIssue[]
  allows(accountKey: string | undefined, requestModel: string): boolean
}

export interface ModelAccessOptions {
  /** Set when the settings reader reports failure, even if it returned defaults. */
  readonly unusable?: boolean
  /** Last applied runtime state; callers own persistence, not this pure policy. */
  readonly lastApplied?: unknown
}

/** Normalize public ids with the resolver's tier recognition and registry aliases. */
export function canonicalModelId(id: string): string {
  const model = id.toLowerCase().replace(/^antigravity-/, '')
  const tier = resolveModelWithTier(model).tier
  const base = tier ? model.replace(new RegExp(`-${tier}$`), '') : model
  const aliases = getResolverAliasMap()
  return Object.hasOwn(aliases, base) ? aliases[base]! : base
}

const KNOWN_MODELS = new Set(
  getAntigravityOpencodeModelIds().map(canonicalModelId),
)

function isAccountModels(
  value: unknown,
  issues: ModelAccessIssue[],
): value is AccountModels {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    issues.push({ reason: 'unusable-setting' })
    return false
  }
  let valid = true
  for (const [accountKey, models] of Object.entries(value)) {
    if (
      !Array.isArray(models) ||
      models.some((model) => typeof model !== 'string')
    ) {
      issues.push({ accountKey, reason: 'invalid-list' })
      valid = false
    } else if (models.length === 0) {
      issues.push({ accountKey, reason: 'empty-list' })
      valid = false
    }
  }
  return valid
}

/**
 * Compile a static mask for an already alias-resolved request model. Invalid
 * records are rejected whole: skipping an entry would remove its restrictions.
 * With no usable last-applied value, even an unknown account key may have had
 * restrictions, so every account is denied until the setting can be applied.
 */
export function compileModelAccess(
  accountModels: unknown,
  options: ModelAccessOptions = {},
): ModelAccessPolicy {
  const issues: ModelAccessIssue[] = []
  const valid = isAccountModels(accountModels, issues) && !options.unusable
  if (options.unusable) issues.push({ reason: 'unusable-setting' })
  let applied: AccountModels
  if (valid) {
    applied = accountModels as AccountModels
  } else if (isAccountModels(options.lastApplied, [])) {
    applied = options.lastApplied
  } else {
    return { valid: false, issues, allows: () => false }
  }

  const allowed = new Map<string, Set<string>>()
  for (const [accountKey, models] of Object.entries(applied)) {
    const known = new Set<string>()
    for (const modelId of models) {
      const canonical = canonicalModelId(modelId)
      if (KNOWN_MODELS.has(canonical)) known.add(canonical)
      else issues.push({ accountKey, modelId, reason: 'unknown-model' })
    }
    if (known.size === 0) issues.push({ accountKey, reason: 'unknown-only' })
    allowed.set(accountKey, known)
  }
  return {
    valid,
    issues,
    allows(accountKey, requestModel) {
      const models =
        accountKey === undefined ? undefined : allowed.get(accountKey)
      return models === undefined || models.has(canonicalModelId(requestModel))
    },
  }
}
