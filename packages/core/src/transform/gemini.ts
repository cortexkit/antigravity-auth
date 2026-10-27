/**
 * Gemini-specific Request Transformations
 *
 * Handles Gemini model-specific request transformations including:
 * - Thinking config (camelCase keys, thinkingLevel for Gemini 3)
 * - Tool normalization (function/custom format)
 * - Schema transformation (JSON Schema -> Gemini Schema format)
 */

import type {
  GoogleSearchConfig,
  RequestPayload,
  ThinkingConfig,
  ThinkingTier,
} from './types.ts'

// Antigravity validates tool parameters against Gemini's protobuf `Schema`, so a
// field outside it fails the whole request with HTTP 400: an unknown keyword such
// as `exclusiveMinimum` is rejected as `Unknown name "exclusiveMinimum"`, and a
// non-string enum value as `TYPE_STRING`. Only fields of Google's documented Schema
// pass (https://ai.google.dev/api/generate-content#Schema), and only those this
// converter has already sent successfully on the Gemini path. Plural `examples` and
// `additionalProperties` are not Schema fields. Claude requests opt into the
// stricter `claudeValidated` adaptation below instead of forwarding the scalar
// constraints and `title`.
const ALLOWED_SCHEMA_FIELDS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'description',
  'format',
  'pattern',
  'title',
  'nullable',
  'propertyOrdering',
  'example',
  'default',
  'enum',
  'anyOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
])

const NUMERIC_SCHEMA_CONSTRAINTS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
])

export interface GeminiSchemaOptions {
  /**
   * AGY's GPT bridge re-encodes protobuf numeric constraints as strings before
   * OpenAI JSON Schema validation. Move them to descriptions instead.
   */
  moveNumericConstraintsToDescription?: boolean
  /** Flatten Claude unions, describe scalar constraints, and omit title in VALIDATED mode. */
  claudeValidated?: boolean
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

const ALLOWED_JSON_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
])

function normalizeNullableTypeArray(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(schema.type)) return schema
  if (
    schema.type.length === 0 ||
    schema.type.some(
      (type) =>
        typeof type !== 'string' ||
        !ALLOWED_JSON_SCHEMA_TYPES.has(type.toLowerCase()),
    )
  ) {
    return schema
  }
  const types = [
    ...new Set(schema.type.map((type: string) => type.toLowerCase())),
  ]
  const nonNull = types.filter((type) => type !== 'null')
  if (nonNull.length > 1) {
    // Leave genuine multi-type unions to the existing provider validation.
    // Throwing here would classify a schema defect as a transport failure and
    // penalize accounts; choosing a branch would silently narrow the tool.
    return schema
  }
  return {
    ...schema,
    type: nonNull[0] ?? 'null',
    ...(nonNull.length === 1 && types.includes('null')
      ? { nullable: true }
      : {}),
  }
}

function sameSchemaValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameSchemaValue(value, right[index]))
    )
  }
  if (!isSchemaObject(left) || !isSchemaObject(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && sameSchemaValue(left[key], right[key]),
    )
  )
}

function mergeSchemaAllOf(
  schema: Record<string, unknown>,
  hints: string[],
): Record<string, unknown> {
  if (!Array.isArray(schema.allOf)) return schema
  const { allOf, ...base } = schema
  const branches = [base, ...allOf]
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  const descriptions: string[] = []
  const metadata: Record<string, unknown> = {}
  let unambiguous = allOf.length > 0
  let allBranchesNullable = true
  let hasContributingBranch = false

  for (const rawBranch of branches) {
    if (!isSchemaObject(rawBranch)) {
      unambiguous = false
      break
    }
    const branch = normalizeNullableTypeArray(rawBranch)
    if (
      (branch.type !== undefined &&
        String(branch.type).toUpperCase() !== 'OBJECT') ||
      (branch.properties !== undefined && !isSchemaObject(branch.properties))
    ) {
      unambiguous = false
      break
    }
    const isContributing =
      branch.type !== undefined ||
      branch.nullable !== undefined ||
      branch.properties !== undefined
    if (isContributing) {
      hasContributingBranch = true
      if (branch.nullable !== true) {
        allBranchesNullable = false
      }
    }
    // Metadata comes from the first occurrence; dropped keywords cannot make
    // otherwise compatible object intersections lose their later properties.
    for (const [key, value] of Object.entries(branch)) {
      if (
        !['properties', 'required', 'description', 'nullable'].includes(key) &&
        !Object.hasOwn(metadata, key)
      )
        metadata[key] = value
    }
    if (typeof branch.description === 'string')
      descriptions.push(branch.description)
    for (const [name, property] of Object.entries(branch.properties ?? {})) {
      if (
        Object.hasOwn(properties, name) &&
        !sameSchemaValue(properties[name], property)
      )
        unambiguous = false
      properties[name] = property
    }
    if (Array.isArray(branch.required)) {
      for (const name of branch.required) {
        if (typeof name === 'string') required.add(name)
      }
    }
  }

  if (unambiguous) {
    return {
      ...metadata,
      type: 'object',
      properties,
      ...(hasContributingBranch && allBranchesNullable
        ? { nullable: true }
        : {}),
      ...(required.size ? { required: [...required] } : {}),
      ...(descriptions.length ? { description: descriptions.join(' ') } : {}),
    }
  }

  hints.push(
    'allOf: using the first branch; other intersection constraints omitted.',
  )
  const first = isSchemaObject(allOf[0]) ? allOf[0] : {}
  return {
    ...base,
    ...first,
    ...(base.description ? { description: base.description } : {}),
  }
}

const CLAUDE_VALIDATED_HINT_FIELDS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'default',
])

function flattenClaudeUnion(
  schema: Record<string, unknown>,
  hints: string[],
): Record<string, unknown> {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) return schema
  const { anyOf, ...base } = schema
  const branches = anyOf.filter(isSchemaObject)
  if (!branches.length) return base

  // A union of string constants, such as a tool parameter allowing "text",
  // "markdown" or "html", becomes one STRING enum with every choice. Keeping a
  // single branch would make the tool reject the other values. Other unions keep
  // one branch, preferring object, then array, then a primitive type.
  if (
    branches.length === anyOf.length &&
    branches.every(
      (branch) =>
        Array.isArray(branch.enum) &&
        branch.enum.length > 0 &&
        branch.enum.every((value) => typeof value === 'string') &&
        (branch.type === undefined || branch.type === 'STRING') &&
        !branch.properties &&
        !branch.items,
    )
  ) {
    return {
      ...base,
      type: 'STRING',
      enum: [...new Set(branches.flatMap((branch) => branch.enum as string[]))],
    }
  }

  const typeName = (branch: Record<string, unknown>) =>
    branch.properties
      ? 'object'
      : branch.items
        ? 'array'
        : String(branch.type ?? 'null').toLowerCase()
  const score = (branch: Record<string, unknown>) => {
    const type = typeName(branch)
    return type === 'object'
      ? 3
      : type === 'array'
        ? 2
        : type === 'null'
          ? 0
          : 1
  }
  let selected = branches[0]!
  for (const branch of branches.slice(1)) {
    if (score(branch) > score(selected)) selected = branch
  }
  const result = { ...base, ...selected }
  if (typeof base.description === 'string' && base.description) {
    result.description =
      typeof selected.description === 'string' &&
      selected.description &&
      selected.description !== base.description
        ? `${base.description} (${selected.description})`
        : base.description
  }
  if (branches.length > 1)
    hints.push(`Accepts: ${[...new Set(branches.map(typeName))].join(' | ')}`)
  return result
}

export function toGeminiSchema(
  schema: unknown,
  options: GeminiSchemaOptions = {},
): unknown {
  // Return primitives and arrays as-is
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema
  }

  const numericConstraintHints: string[] = []
  const inputSchema = normalizeNullableTypeArray(
    mergeSchemaAllOf(schema as Record<string, unknown>, numericConstraintHints),
  )
  const schemaType =
    typeof inputSchema.type === 'string'
      ? inputSchema.type.toUpperCase()
      : undefined
  let result: Record<string, unknown> = {}

  // First pass: collect all property names for required validation
  const propertyNames = new Set<string>()
  if (inputSchema.properties && typeof inputSchema.properties === 'object') {
    for (const propName of Object.keys(
      inputSchema.properties as Record<string, unknown>,
    )) {
      propertyNames.add(propName)
    }
  }

  for (const [key, value] of Object.entries(inputSchema)) {
    // Explicit types restrict items to arrays and object fields to objects.
    // Untyped schemas may describe unions, so retain both kinds of fields.
    if (schemaType !== undefined) {
      if (key === 'items' && schemaType !== 'ARRAY') continue
      if (
        schemaType !== 'OBJECT' &&
        ['properties', 'required', 'propertyOrdering'].includes(key)
      )
        continue
    }
    if (options.claudeValidated) {
      if (key === 'title') continue
      if (key === 'additionalProperties' && value === false)
        numericConstraintHints.push('No extra properties allowed')
      if (CLAUDE_VALIDATED_HINT_FIELDS.has(key)) {
        if (value !== undefined && typeof value !== 'object')
          numericConstraintHints.push(`${key}: ${value}`)
        continue
      }
    }
    if (key === 'const') {
      if (typeof value === 'string') result.enum = [value]
      else numericConstraintHints.push(`Must be ${describeValue(value)}.`)
      continue
    }

    if (NUMERIC_SCHEMA_CONSTRAINTS.has(key)) {
      const exclusive = key === 'exclusiveMinimum' || key === 'exclusiveMaximum'
      if (
        exclusive &&
        !options.moveNumericConstraintsToDescription &&
        String(inputSchema.type).toUpperCase() === 'INTEGER' &&
        typeof value === 'number' &&
        Number.isFinite(value)
      ) {
        const lower = key === 'exclusiveMinimum'
        const bound = lower ? Math.floor(value) + 1 : Math.ceil(value) - 1
        const inclusiveKey = lower ? 'minimum' : 'maximum'
        const existing = inputSchema[inclusiveKey]
        if (Number.isSafeInteger(bound)) {
          result[inclusiveKey] =
            typeof existing === 'number'
              ? lower
                ? Math.max(existing, bound)
                : Math.min(existing, bound)
              : bound
          continue
        }
      }
      if (
        options.moveNumericConstraintsToDescription ||
        exclusive ||
        key === 'multipleOf'
      ) {
        if (['string', 'number', 'boolean'].includes(typeof value))
          numericConstraintHints.push(`${key}: ${value}`)
        continue
      }
    }

    if (key === 'oneOf' && Array.isArray(value)) {
      // Retain an existing anyOf rather than overwriting a separate union.
      if (!Array.isArray(inputSchema.anyOf))
        result.anyOf = value.map((item) => toGeminiSchema(item, options))
      else
        numericConstraintHints.push(
          'oneOf: additional union constraints omitted.',
        )
      continue
    }

    if (!ALLOWED_SCHEMA_FIELDS.has(key)) continue

    if (key === 'type' && typeof value === 'string') {
      // Convert type to uppercase for Gemini API
      result[key] = value.toUpperCase()
    } else if (
      key === 'properties' &&
      typeof value === 'object' &&
      value !== null
    ) {
      // Recursively transform nested property schemas
      const props: Record<string, unknown> = {}
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = toGeminiSchema(propSchema, options)
      }
      result[key] = props
    } else if (key === 'items' && typeof value === 'object') {
      // Transform array items schema
      result[key] = toGeminiSchema(value, options)
    } else if (key === 'anyOf' && Array.isArray(value)) {
      // Transform union type schemas
      result[key] = value.map((item) => toGeminiSchema(item, options))
    } else if (key === 'enum' && Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) {
        if (typeof inputSchema.const !== 'string') result.enum = value
      } else {
        numericConstraintHints.push(
          `Allowed values: ${value.map(describeValue).join(', ')}.`,
        )
      }
    } else if (key === 'required' && Array.isArray(value)) {
      // Filter required array to only include properties that exist
      // This fixes: "parameters.required[X]: property is not defined"
      if (propertyNames.size > 0) {
        const validRequired = value.filter(
          (prop) => typeof prop === 'string' && propertyNames.has(prop),
        )
        if (validRequired.length > 0) {
          result[key] = validRequired
        }
        // If no valid required properties, omit the required field entirely
      } else {
        // If there are no properties, keep required as-is (might be a schema without properties)
        result[key] = value
      }
    } else if (
      (key === 'minimum' || key === 'maximum') &&
      typeof result[key] === 'number' &&
      typeof value === 'number'
    ) {
      result[key] =
        key === 'minimum'
          ? Math.max(result[key], value)
          : Math.min(result[key], value)
    } else {
      result[key] = value
    }
  }

  if (options.claudeValidated) {
    result = flattenClaudeUnion(result, numericConstraintHints)
    if (isSchemaObject(result.properties) && Array.isArray(result.required)) {
      const properties = result.properties
      const required = result.required.filter(
        (name) => typeof name === 'string' && Object.hasOwn(properties, name),
      )
      if (required.length) result.required = required
      else delete result.required
    }
  }

  if (numericConstraintHints.length > 0) {
    const hint = numericConstraintHints.join(', ')
    result.description =
      typeof result.description === 'string' && result.description
        ? `${result.description} (${hint})`
        : hint
  }

  // Issue #80: Ensure array schemas have an 'items' field
  // Gemini API requires: "parameters.properties[X].items: missing field"
  if (result.type === 'ARRAY' && !result.items) {
    result.items = { type: 'STRING' }
  }

  return result
}

/**
 * Check if a model is a Gemini model (not Claude).
 */
export function isGeminiModel(model: string): boolean {
  const lower = model.toLowerCase()
  return lower.includes('gemini') && !lower.includes('claude')
}

/**
 * Check if a model is Gemini 3 (uses thinkingLevel string).
 */
export function isGemini3Model(model: string): boolean {
  return model.toLowerCase().includes('gemini-3')
}

/**
 * Check if a model is Gemini 2.5 (uses numeric thinkingBudget).
 */
export function isGemini25Model(model: string): boolean {
  return model.toLowerCase().includes('gemini-2.5')
}

/**
 * Check if a model is an image generation model.
 * Image models don't support thinking and require imageConfig.
 */
export function isImageGenerationModel(model: string): boolean {
  const lower = model.toLowerCase()
  return lower.includes('image') || lower.includes('imagen')
}

/**
 * Build Gemini 3 thinking config with thinkingLevel string.
 */
export function buildGemini3ThinkingConfig(
  includeThoughts: boolean,
  thinkingLevel: ThinkingTier,
): ThinkingConfig {
  return {
    includeThoughts,
    thinkingLevel,
  }
}

/**
 * Build Gemini 2.5 thinking config with numeric thinkingBudget.
 */
export function buildGemini25ThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    includeThoughts,
    ...(typeof thinkingBudget === 'number' && thinkingBudget > 0
      ? { thinkingBudget }
      : {}),
  }
}

/**
 * Image generation config for Gemini image models.
 *
 * Supported aspect ratios: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
 */
export interface ImageConfig {
  aspectRatio?: string
}

/**
 * Valid aspect ratios for image generation.
 */
const VALID_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
]

/**
 * Build image generation config for Gemini image models.
 *
 * Configuration is read from environment variables:
 * - OPENCODE_IMAGE_ASPECT_RATIO: Aspect ratio (e.g., "16:9", "4:3")
 *
 * Defaults to 1:1 aspect ratio if not specified.
 *
 * Note: Resolution setting is not currently supported by the Antigravity API.
 */
export function buildImageGenerationConfig(): ImageConfig {
  // Read aspect ratio from environment or default to 1:1
  const aspectRatio = process.env.OPENCODE_IMAGE_ASPECT_RATIO || '1:1'

  if (VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    return { aspectRatio }
  }

  console.warn(
    `[gemini] Invalid aspect ratio "${aspectRatio}". Using default "1:1". Valid values: ${VALID_ASPECT_RATIOS.join(', ')}`,
  )

  // Default to 1:1 square aspect ratio
  return { aspectRatio: '1:1' }
}

/**
 * Normalize tools for Gemini models.
 * Ensures tools have proper function-style format.
 *
 * @returns Debug info about tool normalization
 */
export function normalizeGeminiTools(
  payload: RequestPayload,
  schemaOptions: GeminiSchemaOptions = {},
): { toolDebugMissing: number; toolDebugSummaries: string[] } {
  let toolDebugMissing = 0
  const toolDebugSummaries: string[] = []

  if (!Array.isArray(payload.tools)) {
    return { toolDebugMissing, toolDebugSummaries }
  }

  payload.tools = (payload.tools as unknown[]).map(
    (tool: unknown, toolIndex: number) => {
      const t = tool as Record<string, unknown>

      // Skip normalization for Google Search tools (both old and new API)
      if (t.googleSearch || t.googleSearchRetrieval) {
        return t
      }

      if (Array.isArray(t.functionDeclarations)) {
        return {
          ...t,
          functionDeclarations: t.functionDeclarations.map((declaration) => {
            const normalized = { ...(declaration as Record<string, unknown>) }
            const rawSchema = normalized.parameters ??
              normalized.parametersJsonSchema ?? {
                type: 'OBJECT',
                properties: {},
              }
            normalized.parameters = toGeminiSchema(rawSchema, schemaOptions)
            delete normalized.parametersJsonSchema
            return normalized
          }),
        }
      }

      const newTool = { ...t }

      const schemaCandidates = [
        (newTool.function as Record<string, unknown> | undefined)?.input_schema,
        (newTool.function as Record<string, unknown> | undefined)?.parameters,
        (newTool.function as Record<string, unknown> | undefined)?.inputSchema,
        (newTool.custom as Record<string, unknown> | undefined)?.input_schema,
        (newTool.custom as Record<string, unknown> | undefined)?.parameters,
        newTool.parameters,
        newTool.input_schema,
        newTool.inputSchema,
      ].filter(Boolean)

      const placeholderSchema: Record<string, unknown> = {
        type: 'OBJECT',
        properties: {
          _placeholder: {
            type: 'BOOLEAN',
            description: 'Placeholder. Always pass true.',
          },
        },
        required: ['_placeholder'],
      }

      let schema = schemaCandidates[0] as Record<string, unknown> | undefined
      const schemaObjectOk =
        schema && typeof schema === 'object' && !Array.isArray(schema)
      if (!schemaObjectOk) {
        schema = placeholderSchema
        toolDebugMissing += 1
      } else {
        // Transform existing schema to Gemini-compatible format
        schema = toGeminiSchema(schema, schemaOptions) as Record<
          string,
          unknown
        >
      }

      const nameCandidate =
        newTool.name ||
        (newTool.function as Record<string, unknown> | undefined)?.name ||
        (newTool.custom as Record<string, unknown> | undefined)?.name ||
        `tool-${toolIndex}`

      // Always update function.input_schema with transformed schema
      if (newTool.function && schema) {
        ;(newTool.function as Record<string, unknown>).input_schema = schema
      }

      // Always update custom.input_schema with transformed schema
      if (newTool.custom && schema) {
        ;(newTool.custom as Record<string, unknown>).input_schema = schema
      }

      // Create custom from function if missing
      if (!newTool.custom && newTool.function) {
        const fn = newTool.function as Record<string, unknown>
        newTool.custom = {
          name: fn.name || nameCandidate,
          description: fn.description,
          input_schema: schema,
        }
      }

      // Create custom if both missing
      if (!newTool.custom && !newTool.function) {
        newTool.custom = {
          name: nameCandidate,
          description: newTool.description,
          input_schema: schema,
        }

        if (
          !newTool.parameters &&
          !newTool.input_schema &&
          !newTool.inputSchema
        ) {
          newTool.parameters = schema
        }
      }

      if (
        newTool.custom &&
        !(newTool.custom as Record<string, unknown>).input_schema
      ) {
        ;(newTool.custom as Record<string, unknown>).input_schema = {
          type: 'OBJECT',
          properties: {},
        }
        toolDebugMissing += 1
      }

      toolDebugSummaries.push(
        `idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!(newTool.custom as Record<string, unknown> | undefined)?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!(newTool.function as Record<string, unknown> | undefined)?.input_schema}`,
      )

      // Strip custom wrappers for Gemini; only function-style is accepted.
      if (newTool.custom) {
        delete newTool.custom
      }

      return newTool
    },
  )

  return { toolDebugMissing, toolDebugSummaries }
}

/**
 * Apply all Gemini-specific transformations to a request payload.
 */
export interface GeminiTransformOptions {
  /** The effective model name (resolved) */
  model: string
  /** Tier-based thinking budget (from model suffix, for Gemini 2.5) */
  tierThinkingBudget?: number
  /** Tier-based thinking level (from model suffix, for Gemini 3) */
  tierThinkingLevel?: ThinkingTier
  /** Normalized thinking config from user settings */
  normalizedThinking?: { includeThoughts?: boolean; thinkingBudget?: number }
  /** Google Search configuration */
  googleSearch?: GoogleSearchConfig
}

export interface GeminiTransformResult {
  toolDebugMissing: number
  toolDebugSummaries: string[]
  /** Number of function declarations after wrapping */
  wrappedFunctionCount: number
  /** Number of passthrough tools (googleSearch, googleSearchRetrieval, codeExecution) */
  passthroughToolCount: number
}

/**
 * Apply all Gemini-specific transformations.
 */
export function applyGeminiTransforms(
  payload: RequestPayload,
  options: GeminiTransformOptions,
): GeminiTransformResult {
  const {
    model,
    tierThinkingBudget,
    tierThinkingLevel,
    normalizedThinking,
    googleSearch,
  } = options

  // 1. Apply thinking config if needed
  if (normalizedThinking) {
    let thinkingConfig: ThinkingConfig

    if (tierThinkingLevel && isGemini3Model(model)) {
      // Gemini 3 uses thinkingLevel string
      thinkingConfig = buildGemini3ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        tierThinkingLevel,
      )
    } else {
      // Gemini 2.5 and others use numeric budget
      const thinkingBudget =
        tierThinkingBudget ?? normalizedThinking.thinkingBudget
      thinkingConfig = buildGemini25ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        thinkingBudget,
      )
    }

    const generationConfig = (payload.generationConfig ?? {}) as Record<
      string,
      unknown
    >
    generationConfig.thinkingConfig = thinkingConfig
    payload.generationConfig = generationConfig
  }

  // 2. Apply Google Search (Grounding) if enabled
  // Uses the new googleSearch API for Gemini 2.0+ / Gemini 3 models
  // Note: The old googleSearchRetrieval with dynamicRetrievalConfig is deprecated
  // The new API doesn't support threshold - the model decides when to search automatically
  if (googleSearch && googleSearch.mode === 'auto') {
    const tools = (payload.tools as unknown[]) || []
    if (!payload.tools) {
      payload.tools = tools
    }
    // Add Google Search tool using new API format for Gemini 2.0+
    // See: https://ai.google.dev/gemini-api/docs/grounding
    ;(payload.tools as any[]).push({
      googleSearch: {},
    })
  }

  // 3. Normalize tools
  const result = normalizeGeminiTools(payload, {
    moveNumericConstraintsToDescription: model
      .toLowerCase()
      .startsWith('gpt-oss-'),
  })

  // 4. Wrap tools in functionDeclarations format (fixes #203, #206)
  // Antigravity strict protobuf validation rejects wrapper-level 'parameters' field
  // Must be: [{ functionDeclarations: [{ name, description, parameters }] }]
  const wrapResult = wrapToolsAsFunctionDeclarations(payload)

  return {
    ...result,
    wrappedFunctionCount: wrapResult.wrappedFunctionCount,
    passthroughToolCount: wrapResult.passthroughToolCount,
  }
}

export interface WrapToolsResult {
  wrappedFunctionCount: number
  passthroughToolCount: number
}

/**
 * Wrap tools array in Gemini's required functionDeclarations format.
 *
 * Gemini/Antigravity API expects:
 *   { tools: [{ functionDeclarations: [{ name, description, parameters }] }] }
 *
 * NOT:
 *   { tools: [{ function: {...}, parameters: {...} }] }
 *
 * The wrapper-level 'parameters' field causes:
 *   "Unknown name 'parameters' at 'request.tools[0]'"
 */
/**
 * Detect if a tool is a web search tool in any of the supported formats:
 * - Claude/Anthropic: { type: "web_search_20250305" } or { name: "web_search" }
 * - Gemini native: { googleSearch: {} } or { googleSearchRetrieval: {} }
 */
function isWebSearchTool(tool: Record<string, unknown>): boolean {
  // 1. Gemini native format
  if (tool.googleSearch || tool.googleSearchRetrieval) {
    return true
  }

  // 2. Claude/Anthropic format: { type: "web_search_20250305" }
  if (tool.type === 'web_search_20250305') {
    return true
  }

  // 3. Simple name-based format: { name: "web_search" | "google_search" }
  const name = tool.name as string | undefined
  if (name === 'web_search' || name === 'google_search') {
    return true
  }

  return false
}

export function wrapToolsAsFunctionDeclarations(
  payload: RequestPayload,
): WrapToolsResult {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return { wrappedFunctionCount: 0, passthroughToolCount: 0 }
  }

  const functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }> = []

  const passthroughTools: unknown[] = []
  let hasWebSearchTool = false

  for (const tool of payload.tools as Array<Record<string, unknown>>) {
    // Handle passthrough tools (Google Search and Code Execution)
    if (tool.googleSearch || tool.googleSearchRetrieval || tool.codeExecution) {
      passthroughTools.push(tool)
      continue
    }

    // Detect and convert web search tools to Gemini format
    if (isWebSearchTool(tool)) {
      hasWebSearchTool = true
      continue // Will be added as { googleSearch: {} } at the end
    }

    if (tool.functionDeclarations) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const decl of tool.functionDeclarations as Array<
          Record<string, unknown>
        >) {
          functionDeclarations.push({
            name: String(decl.name || `tool-${functionDeclarations.length}`),
            description: String(decl.description || ''),
            parameters: (decl.parameters as Record<string, unknown>) || {
              type: 'OBJECT',
              properties: {},
            },
          })
        }
      }
      continue
    }

    const fn = tool.function as Record<string, unknown> | undefined
    const custom = tool.custom as Record<string, unknown> | undefined

    const name = String(
      tool.name ||
        fn?.name ||
        custom?.name ||
        `tool-${functionDeclarations.length}`,
    )

    const description = String(
      tool.description || fn?.description || custom?.description || '',
    )

    const schema = (fn?.input_schema ||
      fn?.parameters ||
      fn?.inputSchema ||
      custom?.input_schema ||
      custom?.parameters ||
      tool.parameters ||
      tool.input_schema ||
      tool.inputSchema || { type: 'OBJECT', properties: {} }) as Record<
      string,
      unknown
    >

    functionDeclarations.push({
      name,
      description,
      parameters: schema,
    })
  }

  const finalTools: unknown[] = []

  if (functionDeclarations.length > 0) {
    finalTools.push({ functionDeclarations })
  }

  finalTools.push(...passthroughTools)

  // Add googleSearch tool if a web search tool was detected
  // Note: googleSearch cannot be combined with functionDeclarations in the same request
  // If there are function declarations, we skip adding googleSearch (Gemini API limitation)
  if (hasWebSearchTool && functionDeclarations.length === 0) {
    finalTools.push({ googleSearch: {} })
  } else if (hasWebSearchTool && functionDeclarations.length > 0) {
    // Log warning: web search requested but can't be used with functions
    console.warn(
      '[gemini] web_search tool detected but cannot be combined with function declarations. ' +
        'Use the explicit google_search() tool call instead.',
    )
  }

  payload.tools = finalTools

  return {
    wrappedFunctionCount: functionDeclarations.length,
    passthroughToolCount:
      passthroughTools.length +
      (hasWebSearchTool && functionDeclarations.length === 0 ? 1 : 0),
  }
}
