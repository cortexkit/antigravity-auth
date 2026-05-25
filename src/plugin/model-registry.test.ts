import { describe, expect, it } from "vitest"

import {
  getGemini35FlashAntigravityModel,
  getGemini35FlashGeminiCliFallbackModel,
  getPublicModelDefinitions,
  getResolverAliasMap,
} from "./model-registry.ts"

const REQUIRED_PUBLIC_MODEL_FIELDS = [
  "id",
  "name",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "limit",
  "cost",
  "options",
] as const

describe("model registry", () => {
  it("is the source of truth for the current public OpenCode model catalog", () => {
    const definitions = getPublicModelDefinitions()
    const modelNames = Object.keys(definitions).sort()

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-sonnet-4-6-thinking",
      "antigravity-gemini-3.1-flash-image",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3.5-flash",
      "antigravity-gpt-oss-120b",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-image-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ])

    for (const definition of Object.values(definitions)) {
      for (const field of REQUIRED_PUBLIC_MODEL_FIELDS) {
        expect(definition).toHaveProperty(field)
      }
    }
  })

  it("preserves live Gemini 3.5 Flash route mappings", () => {
    expect(getGemini35FlashAntigravityModel()).toBe("gemini-3-flash-agent")
    expect(getGemini35FlashAntigravityModel("high")).toBe("gemini-3-flash-agent")
    expect(getGemini35FlashAntigravityModel("medium")).toBe("gemini-3.5-flash-low")
    expect(getGemini35FlashAntigravityModel("low")).toBe("gemini-3.5-flash-low")
    expect(getGemini35FlashGeminiCliFallbackModel()).toBe("gemini-3-flash-preview")
  })

  it("keeps resolver aliases for GPT-OSS medium and Claude thinking variants", () => {
    const aliases = getResolverAliasMap()

    expect(aliases["gemini-3.5-flash-medium"]).toBe("gemini-3.5-flash")
    expect(aliases["gemini-claude-opus-4-6-thinking-medium"]).toBe("claude-opus-4-6-thinking")
    expect(aliases["gemini-claude-sonnet-4-6-thinking-high"]).toBe("claude-sonnet-4-6-thinking")

    const gptOss = getPublicModelDefinitions()["antigravity-gpt-oss-120b"]
    expect(gptOss?.variants).toEqual({ medium: {} })
  })
})
