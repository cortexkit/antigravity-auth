import {
  getAgyNativeModel,
  isGeminiArgonModel,
  isGeminiCarbonModel,
  isGeminiHydrogenModel,
} from '../model-registry.ts'

const ADAPTIVE_LEVELS: Readonly<Record<number, string>> = {
  1: 'LOW',
  2: 'MEDIUM',
  3: 'HIGH',
}

/** Apply native defaults without increasing an explicit caller output cap. */
export function applyAgyNativeGenerationConfig(
  wireModel: string,
  generationConfig: Record<string, unknown>,
): void {
  const native = getAgyNativeModel(wireModel)
  if (!native) return

  const output = generationConfig.max_output_tokens ?? native.maxOutputTokens
  if (generationConfig.maxOutputTokens === undefined && output !== undefined) {
    generationConfig.maxOutputTokens = output
  }
  delete generationConfig.max_output_tokens

  if (isGeminiHydrogenModel(wireModel)) {
    const tier = wireModel.toLowerCase().split('-').at(-1)
    // The native CLI sends the numeric value 100 for XHigh, not a string.
    // LOW is captured too; MEDIUM/HIGH are inferred from the routes and Carbon.
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel:
        tier === 'xhigh'
          ? 100
          : tier === 'low'
            ? 'LOW'
            : tier === 'medium'
              ? 'MEDIUM'
              : 'HIGH',
    }
  } else if (
    (isGeminiArgonModel(wireModel) || isGeminiCarbonModel(wireModel)) &&
    native.thinkingLevel !== undefined
  ) {
    // Native Argon Low (CLI 1.3.5) and Carbon Low (CLI 1.5.5) captures observe
    // LOW without thinkingBudget. Carbon MEDIUM/HIGH are inferred from its
    // server-map routes following Argon's tier mapping, not captured traffic;
    // Argon MEDIUM/HIGH are inferred from the server catalog's numeric efforts.
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: ADAPTIVE_LEVELS[native.thinkingLevel],
    }
  } else if (
    native.supportsAdaptiveThinking &&
    native.thinkingLevel !== undefined
  ) {
    // LOW matches test-fixtures/agy-cli-1.3.3/native-opus-low.json.
    // Other efforts use schema-derived-thinking.json in that directory;
    // the adaptive config retains its zero budget and explicit effort.
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: 0,
      thinkingLevel: ADAPTIVE_LEVELS[native.thinkingLevel],
    }
  }
}
