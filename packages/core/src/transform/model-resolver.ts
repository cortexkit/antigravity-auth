/**
 * Model Resolution with Thinking Tier Support
 *
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-opus-4-6-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */

import {
  getAgyNativeModel,
  getGemini35FlashAntigravityModel,
  getGemini36FlashAntigravityModel,
  getGemini37FlashAntigravityModel,
  getGemini38FlashAntigravityModel,
  getGeminiArgonAntigravityModel,
  getGeminiCarbonAntigravityModel,
  getGeminiHydrogenAntigravityModel,
  getResolverAliasMap,
  isGeminiArgonModel,
  isGeminiCarbonModel,
  isGeminiHydrogenModel,
} from '../model-registry.ts'
import type {
  GoogleSearchConfig,
  ResolvedModel,
  ThinkingTier,
} from './types.ts'

/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  'gemini-2.5-pro': { low: 8192, medium: 16384, high: 32768 },
  'gemini-2.5-flash': { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export const GEMINI_3_THINKING_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
] as const

/**
 * Model aliases - maps user-friendly names to API model names.
 *
 * Format:
 * - Gemini 3.x Pro variants: gemini-3.1-pro-{low,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = getResolverAliasMap()
const TIER_REGEX = /-(minimal|low|medium|high)$/
const HYDROGEN_TIER_REGEX = /-(low|medium|high|xhigh)$/i
const QUOTA_PREFIX_REGEX = /^antigravity-/i
const GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i
const GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i

/**
 * Image generation models - always route to Antigravity.
 * These models don't support thinking and require imageConfig.
 */
const IMAGE_GENERATION_MODELS = /image|imagen/i

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase()
  return (
    isGeminiArgonModel(lower) ||
    isGeminiCarbonModel(lower) ||
    lower.includes('gemini-3') ||
    lower.includes('gemini-2.5') ||
    (lower.includes('claude') &&
      (lower.includes('thinking') || /^claude-(opus|sonnet)-5-5/.test(lower)))
  )
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(
  model: string,
): Exclude<ThinkingTier, 'xhigh'> | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined
  }
  const tierMatch = model.match(TIER_REGEX)
  return tierMatch?.[1] as Exclude<ThinkingTier, 'xhigh'> | undefined
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes('claude')) {
    return 'claude'
  }
  if (model.includes('gemini-2.5-pro')) {
    return 'gemini-2.5-pro'
  }
  if (model.includes('gemini-2.5-flash')) {
    return 'gemini-2.5-flash'
  }
  return 'default'
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase()
  return (
    lower.includes('thinking') ||
    lower.includes('gemini-3') ||
    lower.includes('gemini-2.5')
  )
}

function isGemini3ProModel(model: string): boolean {
  return GEMINI_3_PRO_REGEX.test(model)
}

function isGemini3FlashModel(model: string): boolean {
  return GEMINI_3_FLASH_REGEX.test(model)
}

function isGemini35FlashModel(model: string): boolean {
  return /^gemini-3\.5-flash/i.test(model)
}

function resolveGemini35FlashAntigravityModel(tier?: ThinkingTier): string {
  return getGemini35FlashAntigravityModel(tier)
}

function getAgyGeminiFlashThinkingBudget(
  tier?: ThinkingTier,
  highBudget = -1,
): number {
  switch (tier) {
    case 'low':
      return 1000
    case 'high':
      return highBudget
    default:
      return 4000
  }
}

function getAgyGemini31ProModel(tier?: ThinkingTier): string {
  return tier === 'high' ? 'gemini-3.1-pro-high' : 'gemini-3.1-pro-low'
}

function getAgyGemini31ProThinkingBudget(tier?: ThinkingTier): number {
  return tier === 'high' ? 10001 : 1001
}

/**
 * Resolve a public model name and optional thinking tier to an Antigravity route.
 */
export function resolveModelWithTier(requestedModel: string): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel)
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, '')

  // Keep the fourth effort specific to Hydrogen; older families retain their tiers.
  if (isGeminiHydrogenModel(modelWithoutQuota)) {
    const tier = modelWithoutQuota
      .toLowerCase()
      .match(HYDROGEN_TIER_REGEX)?.[1] as ThinkingTier | undefined
    return {
      actualModel: getGeminiHydrogenAntigravityModel(tier),
      thinkingLevel: tier ?? 'high',
      tier: tier ?? 'high',
      isThinkingModel: true,
    }
  }

  const tier = extractThinkingTierFromModel(modelWithoutQuota)
  const baseName = tier
    ? modelWithoutQuota.replace(TIER_REGEX, '')
    : modelWithoutQuota

  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota)
  const isArgon = isGeminiArgonModel(modelWithoutQuota)
  const isCarbon = isGeminiCarbonModel(modelWithoutQuota)

  if (isArgon || isCarbon) {
    return {
      actualModel: isCarbon
        ? getGeminiCarbonAntigravityModel(tier)
        : getGeminiArgonAntigravityModel(tier),
      thinkingLevel: tier ?? 'medium',
      tier: tier ?? 'medium',
      isThinkingModel: true,
    }
  }

  // Match server IDs before interpreting a suffix as a host variant option;
  // the suffix can belong to the wire ID itself, as with GPT-OSS medium.
  const native = getAgyNativeModel(modelWithoutQuota)
  // The historical public Gemini 3.5 tier suffix names an effort, not the server's
  // differently named wire route (public low maps to wire extra-low).
  const groupedGemini35Tier =
    isAntigravity &&
    /^gemini-3\.5-flash-(low|medium|high)$/i.test(modelWithoutQuota)
  if (native && !groupedGemini35Tier) {
    return {
      actualModel: modelWithoutQuota,
      thinkingBudget: native.supportsAdaptiveThinking
        ? 0
        : native.thinkingBudget,
      isThinkingModel: native.supportsThinking ?? false,
      ...(isImageModel ? { isImageModel: true } : {}),
      tier,
    }
  }
  if (/^claude-(opus|sonnet)-5-5$/i.test(modelWithoutQuota)) {
    return {
      actualModel: `${modelWithoutQuota}-low`,
      thinkingBudget: 0,
      isThinkingModel: true,
      tier: 'low',
    }
  }

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith('gemini-3')
  const skipAlias = isAntigravity && isGemini3

  // For older Antigravity Gemini 3 models without explicit tier, append the
  // tier to the model id. Gemini 3.5, 3.6, 3.7, and 3.8 Flash use captured
  // route maps with numeric thinking budgets, including retired history.
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota)
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota)
  const isGemini31Pro = /^gemini-3\.1-pro/i.test(baseName)
  const isGemini35Flash = /^gemini-3\.5-flash/i.test(baseName)
  const isGemini36Flash = /^gemini-3\.6-flash/i.test(baseName)
  const isGemini37Flash = /^gemini-3\.7-flash/i.test(baseName)
  const isGemini38Flash = /^gemini-3\.8-flash/i.test(baseName)
  const isGptOss120b = /^gpt-oss-120b(?:-medium)?$/i.test(baseName)

  if (isGemini31Pro) {
    return {
      actualModel: getAgyGemini31ProModel(tier),
      thinkingBudget: getAgyGemini31ProThinkingBudget(tier),
      tier,
      isThinkingModel: true,
    }
  }

  if (isGemini35Flash) {
    return {
      actualModel: resolveGemini35FlashAntigravityModel(tier ?? 'medium'),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier),
      tier: tier ?? 'medium',
      isThinkingModel: true,
    }
  }

  if (isGemini36Flash) {
    return {
      actualModel: getGemini36FlashAntigravityModel(tier ?? 'medium'),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier, -1),
      tier: tier ?? 'medium',
      isThinkingModel: true,
    }
  }

  if (isGemini37Flash) {
    return {
      actualModel: getGemini37FlashAntigravityModel(tier ?? 'medium'),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier, -1),
      tier: tier ?? 'medium',
      isThinkingModel: true,
    }
  }

  if (isGemini38Flash) {
    return {
      actualModel: getGemini38FlashAntigravityModel(tier ?? 'medium'),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier, -1),
      tier: tier ?? 'medium',
      isThinkingModel: true,
    }
  }

  if (isGptOss120b) {
    return {
      actualModel: 'gpt-oss-120b-medium',
      thinkingBudget: 8192,
      isThinkingModel: true,
    }
  }

  let antigravityModel = modelWithoutQuota
  if (skipAlias) {
    if ((isGemini3Pro || isGemini3Flash) && !tier && !isImageModel) {
      const defaultTier = isGemini3Pro ? 'low' : 'medium'
      antigravityModel = `${modelWithoutQuota}-${defaultTier}`
    }
    // When tier is present, modelWithoutQuota already contains the tier suffix
    // (e.g., "gemini-3.5-flash-high") — no modification needed
  }
  const actualModel = skipAlias
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName

  const resolvedModel = actualModel

  const isThinking = isThinkingCapableModel(resolvedModel)

  // Image generation models don't support thinking - return early without thinking config
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
    }
  }

  // Check if this is a Gemini 3 model (works for both aliased and skipAlias paths)
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes('gemini-3')
  const lowerModelWithoutQuota = modelWithoutQuota.toLowerCase()
  const isClaudeThinking =
    (resolvedModel.toLowerCase().includes('claude') &&
      resolvedModel.toLowerCase().includes('thinking')) ||
    (lowerModelWithoutQuota.includes('claude') &&
      lowerModelWithoutQuota.includes('thinking')) ||
    lowerModelWithoutQuota === 'gemini-claude-sonnet-4-6'

  if (!tier) {
    // Gemini 3 models without explicit tier get a default thinkingLevel
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: isGemini35Flash ? 'medium' : 'low',
        isThinkingModel: true,
      }
    }
    // agy CLI sends a compact 1024-token budget for Claude thinking models.
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: 1024,
        isThinkingModel: true,
      }
    }
    return {
      actualModel: resolvedModel,
      isThinkingModel: isThinking,
    }
  }

  // Gemini 3 models with tier always get thinkingLevel set
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
    }
  }

  if (isClaudeThinking) {
    return {
      actualModel: resolvedModel,
      thinkingBudget: 1024,
      tier,
      isThinkingModel: true,
    }
  }

  const budgetFamily = getBudgetFamily(resolvedModel)
  const budgets = THINKING_TIER_BUDGETS[budgetFamily]
  const thinkingBudget = budgets[tier]

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
  }
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(
  model: string,
): 'claude' | 'gemini-flash' | 'gemini-pro' {
  const lower = model.toLowerCase()
  if (lower.includes('claude')) {
    return 'claude'
  }
  if (lower.includes('flash')) {
    return 'gemini-flash'
  }
  return 'gemini-pro'
}

/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
  thinkingBudget?: number
  thinkingLevel?: ThinkingTier
  googleSearch?: GoogleSearchConfig
}

/**
 * Maps a thinking budget to Gemini 3 thinking level.
 * ≤8192 → low, ≤16384 → medium, >16384 → high
 */
function budgetToGemini3Level(budget: number): 'low' | 'medium' | 'high' {
  if (budget <= 8192) return 'low'
  if (budget <= 16384) return 'medium'
  return 'high'
}

/** Resolve preview aliases and public tier names to Antigravity wire IDs. */
export function resolveAntigravityModel(requestedModel: string): ResolvedModel {
  if (!requestedModel.toLowerCase().includes('gemini-3')) {
    return resolveModelWithTier(requestedModel)
  }
  let transformedModel = requestedModel
    .replace(/-preview-customtools$/i, '')
    .replace(/-preview$/i, '')
    .replace(/^antigravity-/i, '')

  const isGemini3Pro = isGemini3ProModel(transformedModel)
  const isGemini3Flash = isGemini3FlashModel(transformedModel)
  const hasTierSuffix = /-(minimal|low|medium|high)$/i.test(transformedModel)
  const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel)
  const isGemini35Flash = isGemini35FlashModel(
    transformedModel.replace(TIER_REGEX, ''),
  )

  // Don't add tier suffix to image models - they don't support thinking
  if (
    (isGemini3Pro || isGemini3Flash) &&
    !isGemini35Flash &&
    !hasTierSuffix &&
    !isImageModel
  ) {
    const defaultTier = isGemini3Pro ? 'low' : 'medium'
    transformedModel = `${transformedModel}-${defaultTier}`
  }
  const prefixedModel = `antigravity-${transformedModel}`
  return resolveModelWithTier(prefixedModel)
}

/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export function resolveModelWithVariant(
  requestedModel: string,
  variantConfig?: VariantConfig,
): ResolvedModel {
  const base = resolveModelWithTier(requestedModel)

  if (!variantConfig) {
    return base
  }

  if (
    isGeminiArgonModel(base.actualModel) ||
    isGeminiCarbonModel(base.actualModel) ||
    isGeminiHydrogenModel(base.actualModel) ||
    getAgyNativeModel(base.actualModel)?.supportsAdaptiveThinking
  ) {
    if (!variantConfig.thinkingLevel) return base
    const family = base.actualModel.replace(
      isGeminiHydrogenModel(base.actualModel)
        ? HYDROGEN_TIER_REGEX
        : TIER_REGEX,
      '',
    )
    return {
      ...resolveModelWithTier(`${family}-${variantConfig.thinkingLevel}`),
      googleSearch: variantConfig.googleSearch,
      configSource: 'variant',
    }
  }

  // Apply Google Search config if present
  if (variantConfig.googleSearch) {
    base.googleSearch = variantConfig.googleSearch
    base.configSource = 'variant'
  }

  if (!variantConfig.thinkingBudget) {
    return base
  }

  const budget = variantConfig.thinkingBudget
  const isGemini3 = base.actualModel.toLowerCase().includes('gemini-3')

  if (isGemini3) {
    const level = budgetToGemini3Level(budget)
    const requestedBase = requestedModel
      .replace(/^antigravity-/i, '')
      .replace(TIER_REGEX, '')
    const isGemini35FlashAlias =
      // Historical effort parsing only; request admission rejects this family.
      isGemini35FlashModel(requestedBase) ||
      base.actualModel === 'gemini-3-flash-agent' ||
      base.actualModel === 'gemini-3.5-flash-low'
    const isAntigravityGemini3WithTier =
      isGemini3ProModel(base.actualModel) ||
      isGemini3FlashModel(base.actualModel)

    let actualModel = base.actualModel
    if (isGemini35FlashAlias) {
      actualModel = resolveGemini35FlashAntigravityModel(level)
    } else if (isAntigravityGemini3WithTier) {
      const baseModel = base.actualModel.replace(/-(low|medium|high)$/, '')
      actualModel = `${baseModel}-${level}`
    }
    return {
      ...base,
      actualModel,
      thinkingLevel: level,
      thinkingBudget: undefined,
      configSource: 'variant',
    }
  }

  return {
    ...base,
    thinkingBudget: budget,
    configSource: 'variant',
  }
}
