/**
 * Model Resolution with Thinking Tier Support
 * 
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-opus-4-6-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */

import {
  getGemini35FlashAntigravityModel,
  getGemini35FlashGeminiCliFallbackModel,
  getResolverAliasMap,
} from "../model-registry.ts";
import type { ResolvedModel, ThinkingTier, GoogleSearchConfig } from "./types.ts";

export interface ModelResolverOptions {
  cli_first?: boolean;
}

/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export const GEMINI_3_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

/**
 * Model aliases - maps user-friendly names to API model names.
 * 
 * Format:
 * - Gemini 3.x Pro variants: gemini-3.1-pro-{low,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = getResolverAliasMap();
const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i;
const GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i;

// ANTIGRAVITY_ONLY_MODELS removed - all models now default to antigravity

/**
 * Image generation models - always route to Antigravity.
 * These models don't support thinking and require imageConfig.
 */
const IMAGE_GENERATION_MODELS = /image|imagen/i;

// Legacy LEGACY_ANTIGRAVITY_GEMINI3 regex removed - all Gemini models now default to antigravity

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5")
  );
}

function isGemini3ProModel(model: string): boolean {
  return GEMINI_3_PRO_REGEX.test(model);
}

function isGemini3FlashModel(model: string): boolean {
  return GEMINI_3_FLASH_REGEX.test(model);
}

function isGemini35FlashModel(model: string): boolean {
  return /^gemini-3\.5-flash/i.test(model);
}

function resolveGemini35FlashAntigravityModel(tier?: ThinkingTier): string {
  return getGemini35FlashAntigravityModel(tier);
}

function getAgyGemini35FlashThinkingBudget(tier?: ThinkingTier): number {
  switch (tier) {
    case "low":
      return 1000;
    case "high":
      return 10000;
    case "medium":
    default:
      return 4000;
  }
}

function getAgyGemini31ProModel(tier?: ThinkingTier): string {
  return tier === "high" ? "gemini-pro-agent" : "gemini-3.1-pro-low";
}

function getAgyGemini31ProThinkingBudget(tier?: ThinkingTier): number {
  return tier === "high" ? 10001 : 1001;
}

/**
 * Resolves a model name with optional tier suffix and quota prefix to its actual API model name
 * and corresponding thinking configuration.
 *
 * Quota routing:
 * - Default to Antigravity quota unless cli_first is enabled for Gemini models
 * - Fallback to Gemini CLI happens at account rotation level when Antigravity is exhausted
 * - "antigravity-" prefix marks explicit quota (no fallback allowed)
 * - Claude and image models always use Antigravity
 *
 * Examples:
 * - "gemini-2.5-flash" → { quotaPreference: "antigravity" }
 * - "antigravity-gemini-3.1-pro-high" → { quotaPreference: "antigravity", explicitQuota: true } * - "claude-opus-4-6-thinking-medium" → { quotaPreference: "antigravity" }
 *
 * @param requestedModel - The model name from the request
 * @param options - Optional configuration including cli_first preference
 * @returns Resolved model with thinking configuration
 */
export function resolveModelWithTier(requestedModel: string, options: ModelResolverOptions = {}): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  const baseName = tier ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;

  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
  const isClaudeModel = modelWithoutQuota.toLowerCase().includes("claude");
  
  // All models default to Antigravity quota unless cli_first is enabled
  // Fallback to gemini-cli happens at the account rotation level when Antigravity is exhausted
  const preferGeminiCli = options.cli_first === true && !isAntigravity && !isImageModel && !isClaudeModel;
  const quotaPreference = preferGeminiCli ? "gemini-cli" as const : "antigravity" as const;
  const explicitQuota = isAntigravity || isImageModel;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  // For older Antigravity Gemini 3 models without explicit tier, append the
  // tier to the model id. Gemini 3.5 Flash is different: live Antigravity
  // exposes high as `gemini-3-flash-agent` and medium/low as
  // `gemini-3.5-flash-low`.
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota);
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota);
  const isGemini31Pro = /^gemini-3\.1-pro/i.test(baseName);
  const isGemini35Flash = /^gemini-3\.5-flash/i.test(baseName);
  const isGptOss120b = /^gpt-oss-120b(?:-medium)?$/i.test(baseName);

  if (isGemini31Pro && quotaPreference === "antigravity") {
    return {
      actualModel: getAgyGemini31ProModel(tier),
      thinkingBudget: getAgyGemini31ProThinkingBudget(tier),
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  if (isGemini35Flash && quotaPreference === "antigravity") {
    return {
      actualModel: resolveGemini35FlashAntigravityModel(tier ?? "medium"),
      thinkingBudget: getAgyGemini35FlashThinkingBudget(tier),
      tier: tier ?? "medium",
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  if (isGptOss120b && quotaPreference === "antigravity") {
    return {
      actualModel: "gpt-oss-120b-medium",
      thinkingBudget: 8192,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }
  
  let antigravityModel = modelWithoutQuota;
  if (skipAlias) {
    if ((isGemini3Pro || isGemini3Flash) && !tier && !isImageModel) {
      const defaultTier = isGemini3Pro ? "low" : "medium";
      antigravityModel = `${modelWithoutQuota}-${defaultTier}`;
    }
    // When tier is present, modelWithoutQuota already contains the tier suffix
    // (e.g., "gemini-3.5-flash-high") — no modification needed
  }
  const actualModel = skipAlias
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  const resolvedModel = actualModel;

  const isThinking = isThinkingCapableModel(resolvedModel);

  // Image generation models don't support thinking - return early without thinking config
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  // Check if this is a Gemini 3 model (works for both aliased and skipAlias paths)
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const lowerModelWithoutQuota = modelWithoutQuota.toLowerCase();
  const isClaudeThinking =
    (resolvedModel.toLowerCase().includes("claude") && resolvedModel.toLowerCase().includes("thinking")) ||
    (lowerModelWithoutQuota.includes("claude") && lowerModelWithoutQuota.includes("thinking")) ||
    lowerModelWithoutQuota === "gemini-claude-sonnet-4-6";

  if (!tier) {
    // Gemini 3 models without explicit tier get a default thinkingLevel
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: isGemini35Flash ? "medium" : "low",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    // agy CLI sends a compact 1024-token budget for Claude thinking models.
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: 1024,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }    return { actualModel: resolvedModel, isThinkingModel: isThinking, quotaPreference, explicitQuota };
  }

  // Gemini 3 models with tier always get thinkingLevel set
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  if (isClaudeThinking) {
    return {
      actualModel: resolvedModel,
      thinkingBudget: 1024,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const thinkingBudget = budgets[tier];

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
  thinkingBudget?: number;
  googleSearch?: GoogleSearchConfig;
}

/**
 * Maps a thinking budget to Gemini 3 thinking level.
 * ≤8192 → low, ≤16384 → medium, >16384 → high
 */
function budgetToGemini3Level(budget: number): "low" | "medium" | "high" {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Resolves model name for a specific headerStyle (quota fallback support).
 * Transforms model names when switching between gemini-cli and antigravity quotas.
 * 
 * Issue #103: When quota fallback occurs, model names need to be transformed:
 * - gemini-3-flash-preview (gemini-cli) → gemini-3-flash (antigravity)
 * - gemini-3-flash (antigravity) → gemini-3-flash-preview (gemini-cli) */
export function resolveModelForHeaderStyle(
  requestedModel: string,
  headerStyle: "antigravity" | "gemini-cli"
): ResolvedModel {
  const lower = requestedModel.toLowerCase();
  const isGemini3 = lower.includes("gemini-3");
  
  if (!isGemini3) {
    return resolveModelWithTier(requestedModel);
  }

  if (headerStyle === "antigravity") {
    let transformedModel = requestedModel
      .replace(/-preview-customtools$/i, "")
      .replace(/-preview$/i, "")
      .replace(/^antigravity-/i, "");
    
    const isGemini3Pro = isGemini3ProModel(transformedModel);
    const isGemini3Flash = isGemini3FlashModel(transformedModel);
    const hasTierSuffix = /-(minimal|low|medium|high)$/i.test(transformedModel);
    const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel);
    const isGemini35Flash = isGemini35FlashModel(transformedModel.replace(TIER_REGEX, ""));
    
    // Don't add tier suffix to image models - they don't support thinking
    if ((isGemini3Pro || isGemini3Flash) && !isGemini35Flash && !hasTierSuffix && !isImageModel) {
      const defaultTier = isGemini3Pro ? "low" : "medium";
      transformedModel = `${transformedModel}-${defaultTier}`;
    }    
    const prefixedModel = `antigravity-${transformedModel}`;
    return resolveModelWithTier(prefixedModel);
  }
  
  if (headerStyle === "gemini-cli") {
    const requestedTier = extractThinkingTierFromModel(requestedModel.replace(/^antigravity-/i, ""));
    let transformedModel = requestedModel
      .replace(/^antigravity-/i, "")
      .replace(/-(minimal|low|medium|high)$/i, "");

    const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
    // Gemini Code Assist still exposes Gemini 3.5 Flash through the
    // gemini-3-flash-preview bucket; retrieveUserQuota does not list a
    // gemini-3.5-flash bucket for the gemini-cli header path.
    const isGemini35Flash = isGemini35FlashModel(transformedModel);
    if (isGemini35Flash) {
      transformedModel = getGemini35FlashGeminiCliFallbackModel();
    } else if (!hasPreviewSuffix) {
      transformedModel = `${transformedModel}-preview`;
    }

    const resolved = resolveModelWithTier(transformedModel, { cli_first: true });
    return {
      ...resolved,
      thinkingLevel: requestedTier ?? resolved.thinkingLevel,
      tier: requestedTier ?? resolved.tier,
      quotaPreference: "gemini-cli",
    };
  }

  return resolveModelWithTier(requestedModel);
}

/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export function resolveModelWithVariant(
  requestedModel: string,
  variantConfig?: VariantConfig
): ResolvedModel {
  const base = resolveModelWithTier(requestedModel);

  if (!variantConfig) {
    return base;
  }

  // Apply Google Search config if present
  if (variantConfig.googleSearch) {
    base.googleSearch = variantConfig.googleSearch;
    base.configSource = "variant";
  }

  if (!variantConfig.thinkingBudget) {
    return base;
  }

  const budget = variantConfig.thinkingBudget;
  const isGemini3 = base.actualModel.toLowerCase().includes("gemini-3");

  if (isGemini3) {
    const level = budgetToGemini3Level(budget);
    const requestedBase = requestedModel
      .replace(/^antigravity-/i, "")
      .replace(TIER_REGEX, "");
    const isGemini35FlashAlias = isGemini35FlashModel(requestedBase) ||
      base.actualModel === "gemini-3-flash-agent" ||
      base.actualModel === "gemini-3.5-flash-low";
    const isAntigravityGemini3WithTier = base.quotaPreference === "antigravity" &&
      (isGemini3ProModel(base.actualModel) || isGemini3FlashModel(base.actualModel));

    let actualModel = base.actualModel;
    if (isGemini35FlashAlias) {
      actualModel = resolveGemini35FlashAntigravityModel(level);
    } else if (isAntigravityGemini3WithTier) {
      const baseModel = base.actualModel.replace(/-(low|medium|high)$/, "");
      actualModel = `${baseModel}-${level}`;
    }
    return {
      ...base,
      actualModel,
      thinkingLevel: level,
      thinkingBudget: undefined,
      configSource: "variant",
    };
  }

  return {
    ...base,
    thinkingBudget: budget,
    configSource: "variant",
  };
}
