import type { ProviderModel } from './model-types.ts'
import type { ThinkingTier } from './transform/types.ts'

export type ModelThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export interface ModelThinkingConfig {
  thinkingBudget: number
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel
  thinkingConfig?: ModelThinkingConfig
  disabled?: boolean
}

export interface ModelLimit {
  context: number
  output: number
}

export type ModelModality = 'text' | 'image' | 'pdf'
export type ModelQuotaGroup = 'gemini' | 'non-gemini' | 'gemini-argon'

export interface ModelModalities {
  input: ModelModality[]
  output: ModelModality[]
}

export interface OpencodeModelDefinition extends ProviderModel {
  id: string
  name: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  limit: ModelLimit
  modalities: ModelModalities
  cost: {
    input: number
    output: number
  }
  options: Record<string, unknown>
  variants?: Record<string, ModelVariant>
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>

interface OpencodeModelDefinitionInput {
  name: string
  reasoning: boolean
  limit: ModelLimit
  modalities: ModelModalities
  variants?: Record<string, ModelVariant>
}

interface AntigravityTieredRouteMetadata {
  defaultModel: string
  byTier: Partial<Record<ThinkingTier, string>>
}

interface GeminiFlashRouteMetadata {
  antigravity: AntigravityTieredRouteMetadata
}

const DEFAULT_MODALITIES: ModelModalities = {
  input: ['text', 'image', 'pdf'],
  output: ['text'],
}

const MODEL_RELEASE_DATE = ''
const DEFAULT_COST = { input: 0, output: 0 }
const DEFAULT_OPTIONS: Record<string, unknown> = {}

function defineModel(
  id: string,
  model: OpencodeModelDefinitionInput,
): OpencodeModelDefinition {
  return {
    id,
    release_date: MODEL_RELEASE_DATE,
    attachment: model.modalities.input.some((modality) => modality !== 'text'),
    temperature: true,
    tool_call: true,
    cost: { ...DEFAULT_COST },
    options: { ...DEFAULT_OPTIONS },
    ...model,
  }
}

export interface AgyNativeModelDefinition {
  displayName: string
  maxTokens?: number
  maxOutputTokens?: number
  model: string
  thinkingBudget?: number
  thinkingLevel?: number
  supportsThinking?: boolean
  supportsAdaptiveThinking?: boolean
  vertexModelId?: string
}

// Keep server wire IDs exact; grouped picker names resolve separately.
export const AGY_NATIVE_MODEL_DEFINITIONS: Readonly<
  Record<string, AgyNativeModelDefinition>
> = {
  'gemini-4-argon-low': {
    displayName: 'Gemini 4 Argon (Low)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M419',
    thinkingLevel: 1,
    thinkingBudget: -1,
    supportsThinking: true,
  },
  'gemini-4-argon-medium': {
    displayName: 'Gemini 4 Argon (Medium)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M418',
    thinkingLevel: 2,
    thinkingBudget: -1,
    supportsThinking: true,
  },
  'gemini-4-argon-high': {
    displayName: 'Gemini 4 Argon (High)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M417',
    thinkingLevel: 3,
    thinkingBudget: -1,
    supportsThinking: true,
  },
  'gemini-3.8-flash-high': {
    displayName: 'Gemini 3.8 Flash (High)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M318',
    thinkingBudget: -1,
    supportsThinking: true,
  },
  'gemini-3.8-flash-medium': {
    displayName: 'Gemini 3.8 Flash (Medium)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M319',
    thinkingBudget: 4000,
    supportsThinking: true,
  },
  'gemini-3.8-flash-low': {
    displayName: 'Gemini 3.8 Flash (Low)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M320',
    thinkingBudget: 1000,
    supportsThinking: true,
  },
  'claude-opus-5-5-low': {
    displayName: 'Claude Opus 5.5 (Low)',
    maxTokens: 1000000,
    maxOutputTokens: 128000,
    model: 'MODEL_PLACEHOLDER_M400',
    thinkingLevel: 1,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    vertexModelId: 'claude-opus-5-5@default',
  },
  'claude-opus-5-5-medium': {
    displayName: 'Claude Opus 5.5 (Medium)',
    maxTokens: 1000000,
    maxOutputTokens: 128000,
    model: 'MODEL_PLACEHOLDER_M401',
    thinkingLevel: 2,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    vertexModelId: 'claude-opus-5-5@default',
  },
  'claude-opus-5-5-high': {
    displayName: 'Claude Opus 5.5 (High)',
    maxTokens: 1000000,
    maxOutputTokens: 128000,
    model: 'MODEL_PLACEHOLDER_M402',
    thinkingLevel: 3,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    vertexModelId: 'claude-opus-5-5@default',
  },
  'claude-sonnet-5-5-low': {
    displayName: 'Claude Sonnet 5.5 (Low)',
    maxTokens: 1000000,
    maxOutputTokens: 128000,
    model: 'MODEL_PLACEHOLDER_M403',
    thinkingLevel: 1,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    vertexModelId: 'claude-sonnet-5-5@default',
  },
  'claude-sonnet-5-5-medium': {
    displayName: 'Claude Sonnet 5.5 (Medium)',
    maxTokens: 1000000,
    maxOutputTokens: 128000,
    model: 'MODEL_PLACEHOLDER_M404',
    thinkingLevel: 2,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    vertexModelId: 'claude-sonnet-5-5@default',
  },
  'claude-sonnet-5-5-high': {
    displayName: 'Claude Sonnet 5.5 (High)',
    maxTokens: 1000000,
    maxOutputTokens: 128000,
    model: 'MODEL_PLACEHOLDER_M405',
    thinkingLevel: 3,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    vertexModelId: 'claude-sonnet-5-5@default',
  },
  'gpt-oss-120b-medium': {
    displayName: 'GPT-OSS 120B (Medium)',
    maxTokens: 131072,
    maxOutputTokens: 32768,
    model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    thinkingBudget: 8192,
    supportsThinking: true,
    vertexModelId: 'openai/gpt-oss-120b-maas',
  },
  'gemini-3.5-flash-extra-low': {
    displayName: 'Gemini 3.5 Flash (Low)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M187',
    thinkingBudget: 1000,
    supportsThinking: true,
  },
  'gemini-3.5-flash-low': {
    displayName: 'Gemini 3.5 Flash (Medium)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M20',
    thinkingBudget: 4000,
    supportsThinking: true,
  },
  'gemini-3-flash-agent': {
    displayName: 'Gemini 3.5 Flash (High)',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    model: 'MODEL_PLACEHOLDER_M84',
    thinkingBudget: -1,
    supportsThinking: true,
  },
  'gemini-3.1-flash-image': {
    displayName: 'Gemini 3.1 Flash Image',
    model: 'MODEL_PLACEHOLDER_M21',
  },
}

export function getAgyNativeModel(
  model: string,
): AgyNativeModelDefinition | undefined {
  return AGY_NATIVE_MODEL_DEFINITIONS[model.toLowerCase()]
}

export const RETIRED_AGY_MODEL_MESSAGE =
  'This Antigravity model is no longer offered. Choose another model.'

/** Withdrawn names remain readable in history, but cannot serve new requests. */
export function isRetiredAgyModel(model: string): boolean {
  const route = model
    .toLowerCase()
    .replace(/^antigravity-/, '')
    .replace(/^gemini-(?=claude-)/, '')
    .replace(/-preview(?:-customtools)?$/, '')
  return (
    (/^claude-(opus|sonnet)-4-6(?:-thinking)?(?:-(?:minimal|low|medium|high))?$/.test(
      route,
    ) ||
      /^gemini-3\.1-pro(?:-(?:low|high))?$/.test(route) ||
      /^gemini-3\.[67]-flash(?:-(?:low|medium|high|tiered))?$/.test(route) ||
      route === 'gemini-pro-agent') &&
    getAgyNativeModel(route) === undefined
  )
}

const ALL_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  'antigravity-gemini-4-argon': defineModel('antigravity-gemini-4-argon', {
    name: 'Gemini 4 Argon (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    },
  }),
  'antigravity-gemini-3.5-flash': defineModel('antigravity-gemini-3.5-flash', {
    name: 'Gemini 3.5 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    },
  }),
  'antigravity-gemini-3.1-flash-image': defineModel(
    'antigravity-gemini-3.1-flash-image',
    {
      name: 'Gemini 3.1 Flash Image (Antigravity)',
      reasoning: false,
      limit: { context: 66000, output: 33000 },
      modalities: { input: ['text', 'image'], output: ['text', 'image'] },
    },
  ),
  'antigravity-gemini-3.8-flash': defineModel('antigravity-gemini-3.8-flash', {
    name: 'Gemini 3.8 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    },
  }),
  'antigravity-claude-sonnet-5-5': defineModel(
    'antigravity-claude-sonnet-5-5',
    {
      name: 'Claude Sonnet 5.5 (Antigravity)',
      reasoning: true,
      limit: { context: 1000000, output: 128000 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { thinkingLevel: 'low' },
        medium: { thinkingLevel: 'medium' },
        high: { thinkingLevel: 'high' },
      },
    },
  ),
  'antigravity-claude-opus-5-5': defineModel('antigravity-claude-opus-5-5', {
    name: 'Claude Opus 5.5 (Antigravity)',
    reasoning: true,
    limit: { context: 1000000, output: 128000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    },
  }),
  'antigravity-gpt-oss-120b-medium': defineModel(
    'antigravity-gpt-oss-120b-medium',
    {
      name: 'GPT-OSS 120B Medium (Antigravity)',
      reasoning: true,
      limit: { context: 131072, output: 32768 },
      modalities: DEFAULT_MODALITIES,
    },
  ),
}

const RESOLVER_ALIASES: Record<string, string> = {
  'gemini-4-argon-low': 'gemini-4-argon',
  'gemini-4-argon-medium': 'gemini-4-argon',
  'gemini-4-argon-high': 'gemini-4-argon',
  'gemini-3.1-pro-low': 'gemini-3.1-pro',
  'gemini-3.1-pro-high': 'gemini-3.1-pro',
  'gemini-3-flash-low': 'gemini-3-flash',
  'gemini-3-flash-medium': 'gemini-3-flash',
  'gemini-3-flash-high': 'gemini-3-flash',
  'gemini-3.5-flash-low': 'gemini-3.5-flash',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash',
  'gemini-3.5-flash-high': 'gemini-3.5-flash',
  'gemini-3.6-flash-low': 'gemini-3.6-flash',
  'gemini-3.6-flash-medium': 'gemini-3.6-flash',
  'gemini-3.6-flash-high': 'gemini-3.6-flash',
  'gemini-3.7-flash-low': 'gemini-3.7-flash',
  'gemini-3.7-flash-medium': 'gemini-3.7-flash',
  'gemini-3.7-flash-high': 'gemini-3.7-flash',
  'gemini-3.8-flash-low': 'gemini-3.8-flash',
  'gemini-3.8-flash-medium': 'gemini-3.8-flash',
  'gemini-3.8-flash-high': 'gemini-3.8-flash',
  // Historical parsing does not authorize serving: admission rejects retired routes.
  'gemini-claude-opus-4-6-thinking-low': 'claude-opus-4-6-thinking',
  'gemini-claude-opus-4-6-thinking-medium': 'claude-opus-4-6-thinking',
  'gemini-claude-opus-4-6-thinking-high': 'claude-opus-4-6-thinking',
  'gemini-claude-sonnet-4-6-thinking-low': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6-thinking-medium': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6-thinking-high': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-low': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-medium': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-high': 'claude-sonnet-4-6',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
}

const GEMINI_35_FLASH_ROUTES: GeminiFlashRouteMetadata = {
  antigravity: {
    defaultModel: 'gemini-3-flash-agent',
    byTier: {
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
    },
  },
}

const GEMINI_36_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.6-flash-medium',
  byTier: {
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high',
  },
}

const GEMINI_37_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.7-flash-medium',
  byTier: {
    low: 'gemini-3.7-flash-low',
    medium: 'gemini-3.7-flash-medium',
    high: 'gemini-3.7-flash-high',
  },
}

const GEMINI_38_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.8-flash-medium',
  byTier: {
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  },
}

const QUOTA_GROUP_BY_MODEL_ID: Record<string, ModelQuotaGroup> = {
  'claude-opus-4-6-thinking': 'non-gemini',
  'claude-opus-4-6': 'non-gemini',
  'claude-sonnet-4-6-thinking': 'non-gemini',
  'claude-sonnet-4-6': 'non-gemini',
  'gemini-pro-agent': 'gemini',
  'gemini-3.1-pro': 'gemini',
  'gemini-3.1-pro-low': 'gemini',
  'gemini-3.1-pro-high': 'gemini',
  'gemini-3-flash': 'gemini',
  'gemini-3-flash-agent': 'gemini',
  'gemini-3.5-flash-low': 'gemini',
  'gemini-3.5-flash-extra-low': 'gemini',
  'gemini-3.6-flash-low': 'gemini',
  'gemini-3.6-flash-medium': 'gemini',
  'gemini-3.6-flash-high': 'gemini',
  'gemini-3.6-flash-tiered': 'gemini',
  'gemini-3.7-flash-low': 'gemini',
  'gemini-3.7-flash-medium': 'gemini',
  'gemini-3.7-flash-high': 'gemini',
  'gemini-3.7-flash-tiered': 'gemini',
  'gemini-3.8-flash-low': 'gemini',
  'gemini-3.8-flash-medium': 'gemini',
  'gemini-3.8-flash-high': 'gemini',
  'gemini-3.8-flash-tiered': 'gemini',
  'gemini-3.1-flash-image': 'gemini',
  'gpt-oss-120b': 'non-gemini',
  'gpt-oss-120b-medium': 'non-gemini',
}

const ANTIGRAVITY_OPENCODE_MODEL_IDS = [
  'antigravity-gemini-4-argon',
  'antigravity-gemini-3.8-flash',
  'antigravity-gemini-3.5-flash',
  'antigravity-gemini-3.1-flash-image',
  'antigravity-claude-sonnet-5-5',
  'antigravity-claude-opus-5-5',
  'antigravity-gpt-oss-120b-medium',
] as const

function pickModelDefinitions(
  ids: readonly string[],
): OpencodeModelDefinitions {
  return Object.fromEntries(ids.map((id) => [id, ALL_MODEL_DEFINITIONS[id]!]))
}

export const OPENCODE_MODEL_DEFINITIONS = pickModelDefinitions(
  ANTIGRAVITY_OPENCODE_MODEL_IDS,
)

export function getPublicModelDefinitions(): OpencodeModelDefinitions {
  return OPENCODE_MODEL_DEFINITIONS
}

export function getAntigravityOpencodeModelIds(): string[] {
  return [...ANTIGRAVITY_OPENCODE_MODEL_IDS]
}

export function getResolverAliasMap(): Record<string, string> {
  return RESOLVER_ALIASES
}

export function getGemini35FlashAntigravityModel(tier?: ThinkingTier): string {
  if (!tier) {
    return GEMINI_35_FLASH_ROUTES.antigravity.defaultModel
  }
  return (
    GEMINI_35_FLASH_ROUTES.antigravity.byTier[tier] ??
    GEMINI_35_FLASH_ROUTES.antigravity.defaultModel
  )
}

function getTieredAntigravityModel(
  routes: AntigravityTieredRouteMetadata,
  tier?: ThinkingTier,
): string {
  return tier
    ? (routes.byTier[tier] ?? routes.defaultModel)
    : routes.defaultModel
}

export function getGemini36FlashAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_36_FLASH_ROUTES, tier)
}

export function getGemini37FlashAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_37_FLASH_ROUTES, tier)
}

export function getGemini38FlashAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_38_FLASH_ROUTES, tier)
}

export function getQuotaGroupForModel(
  modelId: string,
  hasArgonPool = false,
): ModelQuotaGroup | undefined {
  const normalized = modelId.toLowerCase()
  // Argon per-model quota is retained separately: the model alone does not
  // identify an Argon weekly pool, so without evidence that this account
  // reports one the model stays ungrouped and callers fall back to the
  // ordinary Gemini pool (see the fixture README).
  if (isGeminiArgonModel(normalized))
    return hasArgonPool ? 'gemini-argon' : undefined
  return (
    QUOTA_GROUP_BY_MODEL_ID[normalized] ??
    // Check Claude / GPT-OSS substrings BEFORE the `gemini` substring so
    // a `gemini-claude-*` alias (which is a Claude route exposed under
    // a `gemini-` namespace) attributes to the non-gemini pool rather
    // than the gemini pool. Substring matching is required because the
    // alias IDs start with `gemini-` but contain `claude`.
    (normalized.includes('claude') || normalized.includes('gpt-oss')
      ? 'non-gemini'
      : normalized.startsWith('gemini') || normalized.startsWith('tab_')
        ? 'gemini'
        : undefined)
  )
}

/** Recognize Argon selectors so family-specific wire and quota policy is consistent. */
export function isGeminiArgonModel(model: string): boolean {
  return /^(?:antigravity-)?gemini-4-argon(?:-(?:low|medium|high))?$/.test(
    model.toLowerCase(),
  )
}

export function getGeminiArgonAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(
    {
      defaultModel: 'gemini-4-argon-medium',
      byTier: {
        low: 'gemini-4-argon-low',
        medium: 'gemini-4-argon-medium',
        high: 'gemini-4-argon-high',
      },
    },
    tier,
  )
}
