/**
 * Transform Module Index
 *
 * Re-exports transform functions and types for request transformation.
 */

export type { ClaudeTransformOptions, ClaudeTransformResult } from './claude.ts'
// Claude transforms
export {
  appendClaudeThinkingHint,
  applyClaudeTransforms,
  buildClaudeThinkingConfig,
  CLAUDE_INTERLEAVED_THINKING_HINT,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  computeClaudeMaxOutputTokens,
  configureClaudeToolConfig,
  ensureClaudeMaxOutputTokens,
  isClaudeModel,
  isClaudeThinkingModel,
  normalizeClaudeTools,
} from './claude.ts'
export type { SanitizerOptions } from './cross-model-sanitizer.ts'
// Cross-model sanitization
export {
  getModelFamily as getCrossModelFamily,
  sanitizeCrossModelPayload,
  sanitizeCrossModelPayloadInPlace,
  stripClaudeThinkingFields,
  stripGeminiThinkingMetadata,
} from './cross-model-sanitizer.ts'
export type {
  GeminiTransformOptions,
  GeminiTransformResult,
  ImageConfig,
} from './gemini.ts'

// Gemini transforms
export {
  applyGeminiTransforms,
  buildGemini3ThinkingConfig,
  buildGemini25ThinkingConfig,
  buildImageGenerationConfig,
  isGemini3Model,
  isGemini25Model,
  isGeminiModel,
  isImageGenerationModel,
  normalizeGeminiTools,
  toGeminiSchema,
} from './gemini.ts'
export type { VariantConfig } from './model-resolver.ts'
// Model resolution
export {
  GEMINI_3_THINKING_LEVELS,
  getModelFamily,
  MODEL_ALIASES,
  resolveModelForHeaderStyle,
  resolveModelWithTier,
  resolveModelWithVariant,
  THINKING_TIER_BUDGETS,
} from './model-resolver.ts'
// Types
export type {
  GoogleSearchConfig,
  ModelFamily,
  RequestPayload,
  ResolvedModel,
  ThinkingConfig,
  ThinkingTier,
  TransformContext,
  TransformDebugInfo,
  TransformResult,
} from './types.ts'
