import { describe, expect, it } from "vitest"

import { classifyQuotaGroup } from "./quota.ts"

describe("classifyQuotaGroup", () => {
  it("uses live Antigravity model ids for quota groups", () => {
    expect(classifyQuotaGroup("gemini-3-flash-agent", "Gemini 3.5 Flash (High)")).toBe("gemini-flash")
    expect(classifyQuotaGroup("gemini-3.5-flash-low", "Gemini 3.5 Flash (Low)")).toBe("gemini-flash")
    expect(classifyQuotaGroup("gemini-pro-agent", "Gemini 3.1 Pro")).toBe("gemini-pro")
    expect(classifyQuotaGroup("claude-sonnet-4-6", "Claude Sonnet 4.6")).toBe("claude")
  })

  it("ignores unsupported non-quota models", () => {
    expect(classifyQuotaGroup("gpt-oss-120b-medium", "GPT-OSS 120B")).toBeNull()
  })
})
