import { beforeAll, describe, expect, it, vi } from "vitest"

type ExtractAccessBlock = (body: string) => {
  validationRequired: boolean
  accountIneligible: boolean
  message?: string
  verifyUrl?: string
}

let extractAccessBlock: ExtractAccessBlock | undefined
let buildProbeRequest: ((projectId: string) => Record<string, unknown>) | undefined
let interpretProbeResponse: ((response: Response) => Promise<{
  status: "ok" | "verification-required" | "ineligible" | "error"
  message: string
}>) | undefined

beforeAll(async () => {
  vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }))
  const { __testExports } = await import("../plugin")
  const exports = __testExports as {
    buildAccountAccessProbeRequest?: (projectId: string) => Record<string, unknown>
    extractAccountAccessErrorDetails?: ExtractAccessBlock
    interpretAccountAccessProbeResponse?: (response: Response) => Promise<{
      status: "ok" | "verification-required" | "ineligible" | "error"
      message: string
    }>
  }
  buildProbeRequest = exports.buildAccountAccessProbeRequest
  extractAccessBlock = exports.extractAccountAccessErrorDetails
  interpretProbeResponse = exports.interpretAccountAccessProbeResponse
})

describe("account eligibility recovery", () => {
  it("finishes a successful probe without waiting for an open SSE body", async () => {
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: still-open\n\n"))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(interpretProbeResponse?.(new Response(body, { status: 200 }))).resolves.toMatchObject({
      status: "ok",
    })
    expect(cancelled).toBe(true)
  })

  it("classifies ineligibility only on HTTP 403", async () => {
    const body = JSON.stringify({ error: { reason: "ACCOUNT_INELIGIBLE" } })

    await expect(interpretProbeResponse?.(new Response(body, { status: 403 }))).resolves.toMatchObject({
      status: "ineligible",
    })
    await expect(interpretProbeResponse?.(new Response(body, { status: 500 }))).resolves.toMatchObject({
      status: "error",
    })
  })

  it("uses the current AGY request metadata contract for access probes", () => {
    const body = buildProbeRequest?.("project-a") as {
      project: string
      requestId: string
      model: string
      request: {
        sessionId: string
        labels: Record<string, string>
        contents: unknown[]
      }
    }

    expect(body).toMatchObject({
      project: "project-a",
      model: "gemini-3.5-flash-low",
      request: {
        sessionId: "-3750763034362895579",
        labels: {
          model_enum: "MODEL_PLACEHOLDER_M20",
          last_step_index: "1",
        },
      },
    })
    expect(body.requestId).toMatch(/^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/2$/)
  })
})

describe("account ineligibility classification", () => {
  it("recognizes the exact structured ACCOUNT_INELIGIBLE reason", () => {
    const result = extractAccessBlock?.(JSON.stringify({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "This account cannot use Antigravity.",
        details: [{ reason: "ACCOUNT_INELIGIBLE" }],
      },
    }))

    expect(result).toMatchObject({
      accountIneligible: true,
      validationRequired: false,
      message: "This account cannot use Antigravity.",
    })
  })

  it("recognizes ACCOUNT_INELIGIBLE inside an SSE error frame", () => {
    const result = extractAccessBlock?.(
      'data: {"error":{"message":"Not eligible","metadata":{"reason":"ACCOUNT_INELIGIBLE"}}}\n\n',
    )

    expect(result?.accountIneligible).toBe(true)
    expect(result?.message).toBe("Not eligible")
  })

  it("does not disable accounts for generic access-denied text", () => {
    for (const message of [
      "Access denied",
      "Permission denied",
      "Your account is not eligible for this feature",
      "An upstream service denied access",
      "ACCOUNT_INELIGIBLE_TEMPORARY",
    ]) {
      const result = extractAccessBlock?.(JSON.stringify({ error: { code: 403, message } }))
      expect(result?.accountIneligible, message).toBe(false)
    }
  })

  it("keeps VALIDATION_REQUIRED separate from account ineligibility", () => {
    const result = extractAccessBlock?.(JSON.stringify({
      error: {
        code: 403,
        message: "Verify your account",
        details: [{ reason: "VALIDATION_REQUIRED" }],
      },
    }))

    expect(result?.validationRequired).toBe(true)
    expect(result?.accountIneligible).toBe(false)
  })
})
