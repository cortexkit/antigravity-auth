import { describe, expect, it } from "vitest"

import {
  AgySessionRegistry,
  extractOpenCodeSessionIdentity,
} from "./session-context.ts"

describe("OpenCode session identity", () => {
  it("prefers session affinity and captures the exact parent session", () => {
    expect(extractOpenCodeSessionIdentity({
      "X-Session-Id": "session-fallback",
      "x-session-affinity": "session-child",
      "X-Parent-Session-Id": "session-parent",
    })).toEqual({
      sessionId: "session-child",
      parentSessionId: "session-parent",
    })
  })

  it("uses X-Session-Id when affinity is absent", () => {
    expect(extractOpenCodeSessionIdentity({ "X-Session-Id": "session-root" })).toEqual({
      sessionId: "session-root",
      parentSessionId: null,
    })
  })
})

describe("AgySessionRegistry", () => {
  it("keeps request identity stable within a session and isolated across sessions", () => {
    const registry = new AgySessionRegistry("/workspace")

    const first = registry.getOrCreate({ sessionId: "session-a", parentSessionId: null })
    const again = registry.getOrCreate({ sessionId: "session-a", parentSessionId: null })
    const second = registry.getOrCreate({ sessionId: "session-b", parentSessionId: null })

    expect(again).toBe(first)
    expect(second.conversationId).not.toBe(first.conversationId)
    expect(second.trajectoryId).not.toBe(first.trajectoryId)
    expect(second.numericSessionId).toBe(first.numericSessionId)
  })

  it("allocates unique monotonic request timestamps without changing session identity", () => {
    const registry = new AgySessionRegistry("/workspace", { now: () => 100 })
    const identity = { sessionId: "session-a", parentSessionId: null }

    const first = registry.beginRequest(identity)
    const second = registry.beginRequest(identity)

    expect(first.session).toBe(second.session)
    expect(first.timestamp).toBe(100)
    expect(second.timestamp).toBe(101)
  })

  it("registers parent relationships and deletes exact session state", () => {
    const registry = new AgySessionRegistry("/workspace")
    registry.register("session-child", "session-parent")

    expect(registry.getParentSessionId("session-child")).toBe("session-parent")
    expect(registry.size).toBe(1)

    registry.delete("session-child")
    expect(registry.getParentSessionId("session-child")).toBeNull()
    expect(registry.size).toBe(0)
  })

  it("prunes expired state without changing an active session", () => {
    let now = 0
    const registry = new AgySessionRegistry("/workspace", {
      ttlMs: 100,
      now: () => now,
    })
    const active = registry.getOrCreate({ sessionId: "session-active", parentSessionId: null })
    now = 101
    registry.getOrCreate({ sessionId: "session-new", parentSessionId: null })

    expect(registry.size).toBe(1)
    expect(registry.getOrCreate({ sessionId: "session-active", parentSessionId: null })).not.toBe(active)
  })

  it("keeps the registry bounded by evicting least-recently-used sessions", () => {
    let now = 0
    const registry = new AgySessionRegistry("/workspace", {
      maxEntries: 2,
      now: () => now,
    })
    registry.register("session-a")
    now = 1
    registry.register("session-b")
    now = 2
    registry.register("session-c")

    expect(registry.size).toBe(2)
    expect(registry.getParentSessionId("session-a")).toBeNull()
    expect(registry.getOrCreate({ sessionId: "session-b", parentSessionId: null })).toBeDefined()
  })
})
