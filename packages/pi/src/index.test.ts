import { describe, expect, it, vi } from "vitest"

import cortexKitPiAntigravityAuth from "./index.ts"

describe("Pi Antigravity model catalog", () => {
  it("exposes the live GPT-OSS route but not unsupported image-output chat models", () => {
    const registerProvider = vi.fn()
    cortexKitPiAntigravityAuth({ registerProvider } as never)

    expect(registerProvider).toHaveBeenCalledOnce()
    const [, config] = registerProvider.mock.calls[0] as [string, {
      models: Array<{
        id: string
        reasoning: boolean
        contextWindow: number
        maxTokens: number
      }>
    }]
    const modelIds = config.models.map((model) => model.id)

    expect(modelIds).toContain("antigravity-gpt-oss-120b-medium")
    expect(modelIds).not.toContain("antigravity-gemini-3.1-flash-image")
    expect(config.models.find((model) => model.id === "antigravity-gpt-oss-120b-medium")).toMatchObject({
      reasoning: true,
      contextWindow: 131072,
      maxTokens: 32768,
    })
  })
})
