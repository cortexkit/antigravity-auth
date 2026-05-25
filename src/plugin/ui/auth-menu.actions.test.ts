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
