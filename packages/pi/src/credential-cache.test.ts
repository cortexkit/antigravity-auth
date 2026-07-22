import { describe, expect, it } from "bun:test"

import { getPackedRefresh, rememberPackedRefresh } from "./credential-cache.ts"

describe("credential cache", () => {
  it("recovers the packed refresh by access token", () => {
    rememberPackedRefresh("access-1", "refresh-1|proj-1|managed-1")
    expect(getPackedRefresh("access-1")).toBe("refresh-1|proj-1|managed-1")
  })

  it("returns undefined for an unknown access token", () => {
    expect(getPackedRefresh("never-seen")).toBeUndefined()
  })

  it("ignores empty access tokens", () => {
    rememberPackedRefresh("", "refresh-x")
    expect(getPackedRefresh("")).toBeUndefined()
  })

  it("evicts the oldest entry beyond the cap", () => {
    for (let i = 0; i < 6; i++) {
      rememberPackedRefresh(`acc-${i}`, `refresh-${i}`)
    }
    // cap is 4 — the two oldest should be gone, newest retained
    expect(getPackedRefresh("acc-0")).toBeUndefined()
    expect(getPackedRefresh("acc-1")).toBeUndefined()
    expect(getPackedRefresh("acc-5")).toBe("refresh-5")
  })
})
