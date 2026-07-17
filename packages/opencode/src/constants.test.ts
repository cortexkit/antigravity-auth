import { describe, it, expect } from "vitest"
import {
  GEMINI_CLI_HEADERS,
  GEMINI_CLI_VERSION,
  GEMINI_CLI_DEFAULT_MODEL,
  buildGeminiCliUserAgent,
  getRandomizedHeaders,
  type HeaderSet,
} from "./constants.ts"

describe("GEMINI_CLI_HEADERS (deprecated)", () => {
  it("still exposes legacy Code Assist headers for backward compat", () => {
    expect(GEMINI_CLI_HEADERS).toEqual({
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
    })
  })
})

describe("buildGeminiCliUserAgent", () => {
  it("returns GeminiCLI/{version}/{model} ({platform}; {arch}) format", () => {
    const ua = buildGeminiCliUserAgent("gemini-2.5-pro")
    expect(ua).toMatch(/^GeminiCLI\//)
    expect(ua).toContain(`/${GEMINI_CLI_VERSION}/`)
    expect(ua).toContain("gemini-2.5-pro")
    expect(ua).toMatch(/\(.+; .+\)$/)
  })

  it("uses default model when none provided", () => {
    const ua = buildGeminiCliUserAgent()
    expect(ua).toContain(`/${GEMINI_CLI_DEFAULT_MODEL}`)
  })

  it("uses default model when empty string provided", () => {
    const ua = buildGeminiCliUserAgent("")
    expect(ua).toContain(`/${GEMINI_CLI_DEFAULT_MODEL}`)
  })

  it("includes the requested model in the UA string", () => {
    const ua = buildGeminiCliUserAgent("gemini-3-pro-preview")
    expect(ua).toContain("/gemini-3-pro-preview")
  })

  it("includes platform and arch from process", () => {
    const ua = buildGeminiCliUserAgent("gemini-2.5-flash")
    const platform = process.platform || "darwin"
    const arch = process.arch || "arm64"
    expect(ua).toContain(`(${platform}; ${arch})`)
  })
})

describe("getRandomizedHeaders", () => {
  describe("gemini-cli style", () => {
    it("returns GeminiCLI User-Agent with model", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-2.5-pro")
      expect(headers["User-Agent"]).toMatch(/^GeminiCLI\//)
      expect(headers["User-Agent"]).toContain("gemini-2.5-pro")
    })

    it("includes model name in User-Agent when provided", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-3-pro-preview")
      expect(headers["User-Agent"]).toContain("gemini-3-pro-preview")
    })

    it("uses default model when no model provided", () => {
      const headers = getRandomizedHeaders("gemini-cli")
      expect(headers["User-Agent"]).toContain(`/${GEMINI_CLI_DEFAULT_MODEL}`)
    })

    it("still includes X-Goog-Api-Client and Client-Metadata", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-2.5-pro")
      expect(headers["X-Goog-Api-Client"]).toBe(GEMINI_CLI_HEADERS["X-Goog-Api-Client"])
      expect(headers["Client-Metadata"]).toBe(GEMINI_CLI_HEADERS["Client-Metadata"])
    })
  })

  describe("antigravity style", () => {
    it("returns only the captured agy CLI User-Agent", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toMatch(
        /^antigravity\/cli\/1\.1\.3 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/,
      )
      expect(headers["X-Goog-Api-Client"]).toBeUndefined()
      expect(headers["Client-Metadata"]).toBeUndefined()
    })

    it("uses normalized runtime platform/arch in User-Agent", () => {
      const headers = getRandomizedHeaders("antigravity")
      const platform = process.platform === "win32" ? "windows" : process.platform
      const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch
      expect(headers["User-Agent"]).toContain(`os_type=${platform}; arch=${arch}`)
    })
  })
})

describe("HeaderSet type", () => {
  it("allows omitting X-Goog-Api-Client and Client-Metadata", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBeUndefined()
    expect(headers["Client-Metadata"]).toBeUndefined()
  })

  it("allows including all three headers", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
      "X-Goog-Api-Client": "test-client",
      "Client-Metadata": "test-metadata",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBe("test-client")
    expect(headers["Client-Metadata"]).toBe("test-metadata")
  })
})
