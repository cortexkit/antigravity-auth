import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * Regression tests for the version fallback mechanism.
 *
 * Issue #468: On WSL2/AlmaLinux with strict firewall rules, both the
 * auto-updater API and changelog fetch fail. The plugin then uses the
 * hardcoded fallback version in User-Agent headers. If the fallback is
 * too old, the backend rejects requests for newer models (e.g., Gemini 3.1 Pro)
 * with "not available on this version".
 *
 * These tests verify the fallback is current and that the
 * network-failure path correctly uses it.
 */

beforeEach(async () => {
  // `versionLocked` is module-level singleton state — reset between tests
  // so the "first call locks" semantics can be exercised per scenario.
  const { __resetAntigravityVersionForTesting } = await import("../constants.ts")
  __resetAntigravityVersionForTesting()
})

afterEach(() => {
  globalThis.unstubAllGlobals()
})

describe("ANTIGRAVITY_VERSION_FALLBACK", () => {
  it("defaults to the exported fallback constant", async () => {
    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("is at least 1.18.0 to support Gemini 3.1 Pro", async () => {
    const { getAntigravityVersion } = await import("../constants.ts")
    const [major, minor] = getAntigravityVersion().split(".").map(Number)
    expect(major).toBeGreaterThanOrEqual(1)
    if (major === 1) expect(minor).toBeGreaterThanOrEqual(18)
  })
})

describe("setAntigravityVersion", () => {
  it("updates the version on first call", async () => {
    const { getAntigravityVersion, setAntigravityVersion } = await import("../constants.ts")
    setAntigravityVersion("2.0.0")
    expect(getAntigravityVersion()).toBe("2.0.0")
  })

  it("locks after first call — subsequent calls are ignored", async () => {
    const { getAntigravityVersion, setAntigravityVersion } = await import("../constants.ts")
    setAntigravityVersion("2.0.0")
    setAntigravityVersion("3.0.0")
    expect(getAntigravityVersion()).toBe("2.0.0")
  })
})

describe("initAntigravityVersion — network failure path", () => {
  it("falls back to hardcoded version when both fetches throw", async () => {
    globalThis.stubbed("fetch", mock().mockRejectedValue(new Error("network unreachable")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("falls back to hardcoded version when both fetches return non-ok", async () => {
    globalThis.stubbed(
      "fetch",
      mock().mockResolvedValue({ ok: false, status: 503, text: async () => "" }),
    )

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("uses API version when auto-updater responds", async () => {
    globalThis.stubbed(
      "fetch",
      mock().mockResolvedValue({ ok: true, text: async () => "1.19.0" }),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    const resolution = await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.19.0")
    expect(resolution).toEqual({ version: "1.19.0", source: "api" })
  })

  it("exposes the last runtime version resolution for diagnostics", async () => {
    globalThis.stubbed("fetch", mock().mockRejectedValue(new Error("timeout")))

    const { ANTIGRAVITY_VERSION_FALLBACK } = await import("../constants.ts")
    const { getAntigravityVersionResolution, initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersionResolution()).toEqual({
      version: ANTIGRAVITY_VERSION_FALLBACK,
      source: "fallback",
    })
  })

  it("fallback version appears in User-Agent header", async () => {
    globalThis.stubbed("fetch", mock().mockRejectedValue(new Error("timeout")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityHeaders } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    const headers = getAntigravityHeaders()
    expect(headers["User-Agent"]).toContain(`Antigravity/${ANTIGRAVITY_VERSION_FALLBACK}`)
  })

  it("randomized antigravity headers use captured agy CLI version", async () => {
    const { getRandomizedHeaders } = await import("../constants.ts")

    const headers = getRandomizedHeaders("antigravity")
    expect(headers["User-Agent"]).toMatch(
      /^antigravity\/cli\/1\.1\.5 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/,
    )
  })
})
