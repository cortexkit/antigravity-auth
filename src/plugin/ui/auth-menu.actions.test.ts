import { beforeEach, describe, expect, it, vi } from "vitest"

const selectMock = vi.fn()

vi.mock("./select", () => ({
  select: selectMock,
}))

vi.mock("./confirm", () => ({
  confirm: vi.fn(),
}))

describe("showAuthMenu actions", () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it("exposes auth doctor as a top-level action", async () => {
    selectMock.mockResolvedValue({ type: "cancel" })
    const { showAuthMenu } = await import("./auth-menu.ts")

    await showAuthMenu([])

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: { type: string } }>
    expect(items).toContainEqual(expect.objectContaining({
      label: "Auth doctor",
      value: { type: "doctor" },
    }))
  })

  it("exposes repair auth as a top-level action", async () => {
    selectMock.mockResolvedValue({ type: "cancel" })
    const { showAuthMenu } = await import("./auth-menu.ts")

    await showAuthMenu([])

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: { type: string } }>
    expect(items).toContainEqual(expect.objectContaining({
      label: "Repair auth",
      value: { type: "repair" },
    }))
  })

  it("exposes auth current as a top-level action", async () => {
    selectMock.mockResolvedValue({ type: "cancel" })
    const { showAuthMenu } = await import("./auth-menu.ts")

    await showAuthMenu([])

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: { type: string } }>
    expect(items).toContainEqual(expect.objectContaining({
      label: "Auth current",
      value: { type: "current" },
    }))
  })

  it("repair auth action returns correct type when selected", async () => {
    selectMock.mockResolvedValue({ type: "repair" })
    const { showAuthMenu } = await import("./auth-menu.ts")

    const result = await showAuthMenu([])
    expect(result).toEqual({ type: "repair" })
  })

  it("auth current action returns correct type when selected", async () => {
    selectMock.mockResolvedValue({ type: "current" })
    const { showAuthMenu } = await import("./auth-menu.ts")

    const result = await showAuthMenu([])
    expect(result).toEqual({ type: "current" })
  })

  it("shows cached quota summary in account hints", async () => {
    selectMock.mockResolvedValue({ type: "cancel" })
    const { showAuthMenu } = await import("./auth-menu.ts")

    await showAuthMenu([{
      email: "quota@example.com",
      index: 0,
      quotaSummary: "Claude 80%, Gemini Flash 42%",
    }])

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; hint?: string }>
    expect(items).toContainEqual(expect.objectContaining({
      label: expect.stringContaining("quota@example.com"),
      hint: "Claude 80%, Gemini Flash 42%",
    }))
  })
})

describe("showAccountDetails fingerprint restore", () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it("shows restore fingerprint option when history exists", async () => {
    selectMock.mockResolvedValue("back")
    const { showAccountDetails } = await import("./auth-menu.ts")

    await showAccountDetails({
      email: "test@example.com",
      index: 0,
      fingerprintHistory: [
        { deviceId: "abcd1234efgh", userAgent: "ua1", timestamp: Date.now() - 86400000, reason: "regenerated" },
      ],
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: string }>
    const restoreItem = items.find(item => item.value === "restore-fingerprint")
    expect(restoreItem).toBeDefined()
    expect(restoreItem!.label).toContain("Restore fingerprint")
    expect(restoreItem!.label).toContain("1 saved")
  })

  it("hides restore fingerprint option when no history", async () => {
    selectMock.mockResolvedValue("back")
    const { showAccountDetails } = await import("./auth-menu.ts")

    await showAccountDetails({
      email: "test@example.com",
      index: 0,
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: string }>
    const restoreItem = items.find(item => item.value === "restore-fingerprint")
    expect(restoreItem).toBeUndefined()
  })

  it("hides restore fingerprint option when history is empty", async () => {
    selectMock.mockResolvedValue("back")
    const { showAccountDetails } = await import("./auth-menu.ts")

    await showAccountDetails({
      email: "test@example.com",
      index: 0,
      fingerprintHistory: [],
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: string }>
    const restoreItem = items.find(item => item.value === "restore-fingerprint")
    expect(restoreItem).toBeUndefined()
  })
})

describe("showFingerprintHistory", () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it("displays fingerprint history entries with truncated device IDs", async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import("./auth-menu.ts")

    await showFingerprintHistory([
      { deviceId: "abcdef1234567890", userAgent: "ua1", timestamp: Date.now() - 86400000, reason: "regenerated" },
      { deviceId: "12345678abcdefgh", userAgent: "ua2", timestamp: Date.now() - 172800000, reason: "initial" },
    ], "test@example.com")

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: number | null }>
    const entryItems = items.filter(item => typeof item.value === "number")
    expect(entryItems).toHaveLength(2)
    expect(entryItems[0]!.label).toContain("abcdef12")
    expect(entryItems[0]!.label).toContain("[regenerated]")
    expect(entryItems[1]!.label).toContain("12345678")
    expect(entryItems[1]!.label).toContain("[initial]")
  })

  it("returns selected history index", async () => {
    selectMock.mockResolvedValue(1)
    const { showFingerprintHistory } = await import("./auth-menu.ts")

    const result = await showFingerprintHistory([
      { deviceId: "abcdef1234567890", userAgent: "ua1", timestamp: Date.now(), reason: "regenerated" },
      { deviceId: "12345678abcdefgh", userAgent: "ua2", timestamp: Date.now(), reason: "initial" },
    ], "test@example.com")

    expect(result).toBe(1)
  })

  it("returns null when user cancels (selects back)", async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import("./auth-menu.ts")

    const result = await showFingerprintHistory([
      { deviceId: "abcdef1234567890", userAgent: "ua1", timestamp: Date.now(), reason: "regenerated" },
    ], "test@example.com")

    expect(result).toBeNull()
  })

  it("returns null when select returns undefined (ESC)", async () => {
    selectMock.mockResolvedValue(undefined)
    const { showFingerprintHistory } = await import("./auth-menu.ts")

    const result = await showFingerprintHistory([
      { deviceId: "abcdef1234567890", userAgent: "ua1", timestamp: Date.now(), reason: "regenerated" },
    ], "test@example.com")

    expect(result).toBeNull()
  })

  it("includes back option and heading in menu", async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import("./auth-menu.ts")

    await showFingerprintHistory([
      { deviceId: "abcdef1234567890", userAgent: "ua1", timestamp: Date.now(), reason: "regenerated" },
    ], "test@example.com")

    const items = selectMock.mock.calls[0]?.[0] as Array<{ label: string; value: number | null; kind?: string }>
    expect(items[0]).toEqual(expect.objectContaining({ label: "Back", value: null }))
    const heading = items.find(i => i.kind === "heading")
    expect(heading).toBeDefined()
    expect(heading!.label).toBe("Fingerprint history")
  })

  it("passes account label in menu message", async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import("./auth-menu.ts")

    await showFingerprintHistory([
      { deviceId: "abcdef1234567890", userAgent: "ua1", timestamp: Date.now(), reason: "regenerated" },
    ], "alice@example.com")

    const options = selectMock.mock.calls[0]?.[1] as { message: string }
    expect(options.message).toContain("alice@example.com")
  })
})
