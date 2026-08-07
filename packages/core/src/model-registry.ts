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
export type ModelQuotaGroup = 'gemini' | 'non-gemini'

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
  geminiCliFallbackModel: string
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

const ALL_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  'antigravity-gemini-3.1-pro': defineModel('antigravity-gemini-3.1-pro', {
    name: 'Gemini 3.1 Pro (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    },
  }),
  'antigravity-gemini-3.6-flash': defineModel('antigravity-gemini-3.6-flash', {
    name: 'Gemini 3.6 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: 'low' },
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
      high: { thinkingLevel: 'high' },
    },
  }),
  'antigravity-claude-sonnet-4-6-thinking': defineModel(
    'antigravity-claude-sonnet-4-6-thinking',
    {
      name: 'Claude Sonnet 4.6 Thinking (Antigravity)',
      reasoning: true,
      limit: { context: 250000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { disabled: true },
        high: { disabled: true },
      },
    },
  ),
  'antigravity-claude-opus-4-6-thinking': defineModel(
    'antigravity-claude-opus-4-6-thinking',
    {
      name: 'Claude Opus 4.6 Thinking (Antigravity)',
      reasoning: true,
      limit: { context: 250000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { disabled: true },
        high: { disabled: true },
      },
    },
  ),
  'antigravity-gemini-3.1-flash-image': defineModel(
    'antigravity-gemini-3.1-flash-image',
    {
      name: 'Gemini 3.1 Flash Image (Antigravity)',
      reasoning: false,
      limit: { context: 66000, output: 33000 },
      modalities: {
        input: ['text', 'image'],
        output: ['text', 'image'],
      },
    },
  ),
  'antigravity-gpt-oss-120b-medium': defineModel(
    'antigravity-gpt-oss-120b-medium',
    {
      name: 'GPT-OSS 120B Medium (Antigravity)',
      reasoning: true,
      limit: { context: 131072, output: 32768 },
      modalities: DEFAULT_MODALITIES,
    },
  ),
  'gemini-2.5-flash': defineModel('gemini-2.5-flash', {
    name: 'Gemini 2.5 Flash (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-2.5-pro': defineModel('gemini-2.5-pro', {
    name: 'Gemini 2.5 Pro (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3-flash-preview': defineModel('gemini-3-flash-preview', {
    name: 'Gemini 3 Flash Preview (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3.1-pro-preview': defineModel('gemini-3.1-pro-preview', {
    name: 'Gemini 3.1 Pro Preview (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3.5-flash-preview': defineModel('gemini-3.5-flash-preview', {
    name: 'Gemini 3.5 Flash Preview (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3.1-flash-image': defineModel('gemini-3.1-flash-image', {
    name: 'Gemini 3.1 Flash Image (Gemini CLI)',
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ['text', 'image'],
      output: ['text', 'image'],
    },
  }),
  'gemini-3.1-flash-image-preview': defineModel(
    'gemini-3.1-flash-image-preview',
    {
      name: 'Gemini 3.1 Flash Image Preview (Gemini CLI)',
      reasoning: false,
      limit: { context: 66000, output: 33000 },
      modalities: {
        input: ['text', 'image'],
        output: ['text', 'image'],
      },
    },
  ),
  'gemini-3.1-pro-preview-customtools': defineModel(
    'gemini-3.1-pro-preview-customtools',
    {
      name: 'Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)',
      reasoning: true,
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
    },
  ),
}

const RESOLVER_ALIASES: Record<string, string> = {
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
  geminiCliFallbackModel: 'gemini-3-flash-preview',
}

const GEMINI_36_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.6-flash-medium',
  byTier: {
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high',
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
  'gemini-3.1-flash-image': 'gemini',
  'gpt-oss-120b': 'non-gemini',
  'gpt-oss-120b-medium': 'non-gemini',
}

const ANTIGRAVITY_OPENCODE_MODEL_IDS = [
  'antigravity-gemini-3.6-flash',
  'antigravity-gemini-3.5-flash',
  'antigravity-gemini-3.1-pro',
  'antigravity-claude-sonnet-4-6-thinking',
  'antigravity-claude-opus-4-6-thinking',
  'antigravity-gemini-3.1-flash-image',
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

export function getGemini35FlashGeminiCliFallbackModel(): string {
  return GEMINI_35_FLASH_ROUTES.geminiCliFallbackModel
}

export function getGemini36FlashAntigravityModel(tier?: ThinkingTier): string {
  if (!tier) {
    return GEMINI_36_FLASH_ROUTES.defaultModel
  }
  return (
    GEMINI_36_FLASH_ROUTES.byTier[tier] ?? GEMINI_36_FLASH_ROUTES.defaultModel
  )
}

export function getQuotaGroupForModel(
  modelId: string,
): ModelQuotaGroup | undefined {
  const normalized = modelId.toLowerCase()
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
