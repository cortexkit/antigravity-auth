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
 * Hydrogen and Neon have no xhigh. OpenCode 1's bundled @ai-sdk/google accepts only
 * minimal/low/medium/high for thinkingLevel, so an xhigh choice would never
 * reach the plugin and would silently run as high. Both the plugin's config
 * hook and the CLI's config writer use this list.
 */
export function getOpencode1ModelDefinitions(): OpencodeModelDefinitions {
  const models = { ...OPENCODE_MODEL_DEFINITIONS }
  for (const id of [
    'antigravity-gemini-4-hydrogen',
    'antigravity-gemini-4-neon',
  ]) {
    const model = models[id]
    if (!model) continue
    const variants = { ...model.variants }
    delete variants.xhigh
    models[id] = { ...model, variants }
  }
  return models
}
