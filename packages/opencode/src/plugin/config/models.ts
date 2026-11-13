import {
  OPENCODE_MODEL_DEFINITIONS,
  type OpencodeModelDefinitions,
} from '../model-registry'

export type {
  ModelLimit,
  ModelModalities,
  ModelModality,
  ModelThinkingConfig,
  ModelThinkingLevel,
  ModelVariant,
  OpencodeModelDefinition,
  OpencodeModelDefinitions,
} from '../model-registry'
export {
  getAntigravityOpencodeModelIds,
  getPublicModelDefinitions,
  OPENCODE_MODEL_DEFINITIONS,
} from '../model-registry'

/**
 * The model catalog as OpenCode 1 offers it: the shared registry, except that
 * Hydrogen has no xhigh. OpenCode 1's bundled @ai-sdk/google accepts only
 * minimal/low/medium/high for thinkingLevel, so an xhigh choice would never
 * reach the plugin and would silently run as high. Both the plugin's config
 * hook and the CLI's config writer use this list.
 */
export function getOpencode1ModelDefinitions(): OpencodeModelDefinitions {
  const models = { ...OPENCODE_MODEL_DEFINITIONS }
  const hydrogen = models['antigravity-gemini-4-hydrogen']
  if (hydrogen) {
    const variants = { ...hydrogen.variants }
    delete variants.xhigh
    models[hydrogen.id] = { ...hydrogen, variants }
  }
  return models
}
