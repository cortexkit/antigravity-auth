import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./agy-transport.ts", () => ({
  fetchWithAgyCliTransport: vi.fn(),
}))

import { ANTIGRAVITY_ENDPOINT_PROD } from "./constants.ts"
import { fetchWithAgyCliTransport } from "./agy-transport.ts"
import {
  clearProvisionFailedKeys,
  ensureProjectContext,
  invalidateProjectContextCache,
  loadManagedProject,
  onboardManagedProject,
} from "./project.ts"

function mockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe("project bootstrap", () => {
  beforeEach(() => {
    invalidateProjectContextCache()
    clearProvisionFailedKeys()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    invalidateProjectContextCache()
    clearProvisionFailedKeys()
  })

  it("loads managed project with captured agy CLI loadCodeAssist fingerprint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse({ cloudaicompanionProject: "proj" }))
    vi.mocked(fetchWithAgyCliTransport).mockImplementation(fetchSpy)

    const result = await loadManagedProject("token", "ignored-project")

    expect(result?.cloudaicompanionProject).toBe("proj")
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    const body = JSON.parse(init.body as string)

    expect(headers).toEqual({
      "User-Agent": expect.stringMatching(
        /^antigravity\/cli\/1\.1\.3 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/,
      ),
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
    })
    expect(headers["X-Goog-Api-Client"]).toBeUndefined()
    expect(headers["Client-Metadata"]).toBeUndefined()
    expect(body).toEqual({ metadata: { ideType: "ANTIGRAVITY" } })
  })

  it("onboards with minimal tier body on prod first", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse({
      done: true,
      response: { cloudaicompanionProject: { id: "managed-project" } },
    }))
    vi.mocked(fetchWithAgyCliTransport).mockImplementation(fetchSpy)

    const result = await onboardManagedProject("token", "free-tier", "legacy-project")

    expect(result).toBe("managed-project")
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)

    expect(url).toBe(`${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:onboardUser`)
    expect(body).toEqual({ tierId: "free-tier" })
  })

  it("does not retry managed-project provisioning after a cached failure expires", async () => {
    let now = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("loadCodeAssist")) {
        return mockResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] })
      }
      return new Response("busy", { status: 503, statusText: "Service Unavailable" })
    })
    vi.mocked(fetchWithAgyCliTransport).mockImplementation(fetchSpy)

    const auth = {
      type: "oauth" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: now + 60_000,
    }

    const first = await ensureProjectContext(auth)
    const callsAfterFirstResolve = fetchSpy.mock.calls.length
    now += 31 * 60 * 1000

    const second = await ensureProjectContext(auth)

    expect(first.effectiveProjectId).toBe(second.effectiveProjectId)
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirstResolve)
  })
})
