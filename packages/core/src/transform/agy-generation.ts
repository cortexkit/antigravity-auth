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
  options: { thinkingBudget?: number; preserveThinkingBudget?: boolean } = {},
): void {
  const native = getAgyNativeModel(wireModel)
  if (!native) return

  const output = generationConfig.max_output_tokens ?? native.maxOutputTokens
  if (generationConfig.maxOutputTokens === undefined && output !== undefined) {
    generationConfig.maxOutputTokens = output
  }
  delete generationConfig.max_output_tokens

  const capturedTier =
    /^(?:gemini-3\.8-flash|claude-(?:sonnet|opus)-5-5)-(low|medium|high)$/i.exec(
      wireModel,
    )?.[1]
  if (capturedTier) {
    const thinking = generationConfig.thinkingConfig as
      | { thinkingBudget?: unknown }
      | undefined
    // Builders can distinguish an explicit caller budget from a numeric
    // resolver default. Direct raw configs preserve their explicit budget.
    const budget =
      options.thinkingBudget ??
      (options.preserveThinkingBudget === false
        ? undefined
        : thinking?.thinkingBudget)
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      ...(typeof budget === 'number'
        ? { thinkingBudget: budget }
        : { thinkingLevel: capturedTier.toUpperCase() }),
    }
  } else if (isGeminiHydrogenModel(wireModel)) {
    const tier = wireModel.toLowerCase().split('-').at(-1)
    // The native CLI sends the numeric value 100 for XHigh, not a string.
    // The CLI capture shows LOW; MEDIUM and HIGH follow Carbon's mapping. A live
    // probe on 13 Nov saw all four values accepted, with thinking depth rising
    // from LOW to XHigh (the server does not name the tier it served).
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
