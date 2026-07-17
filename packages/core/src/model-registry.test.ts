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
      "antigravity-gpt-oss-120b-medium",
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
    expect(getGemini35FlashAntigravityModel("low")).toBe("gemini-3.5-flash-extra-low")
    expect(getGemini35FlashGeminiCliFallbackModel()).toBe("gemini-3-flash-preview")
  })

  it("keeps resolver aliases for supported agy CLI variants", () => {
    const aliases = getResolverAliasMap()

    expect(aliases["gemini-3.5-flash-medium"]).toBe("gemini-3.5-flash")
    expect(aliases["gemini-claude-opus-4-6-thinking-medium"]).toBe("claude-opus-4-6-thinking")
    expect(aliases["gemini-claude-sonnet-4-6-thinking-high"]).toBe("claude-sonnet-4-6")
    expect(aliases["gpt-oss-120b"]).toBe("gpt-oss-120b-medium")
  })

  it("matches the live GPT-OSS capability metadata", () => {
    expect(getPublicModelDefinitions()["antigravity-gpt-oss-120b-medium"]).toMatchObject({
      reasoning: true,
      limit: { context: 131072, output: 32768 },
    })
  })

  it("advertises image output only on the image route", () => {
    expect(getPublicModelDefinitions()["antigravity-gemini-3.1-flash-image"]).toMatchObject({
      reasoning: false,
      modalities: {
        input: ["text", "image"],
        output: ["text", "image"],
      },
    })
  })
})
