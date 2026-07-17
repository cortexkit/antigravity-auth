import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  AgyRequestSessionStore,
  buildAgyAgentRequestMetadata,
  countAgyRequestSteps,
  createAgyRequestSessionContext,
  fnv1a64Signed,
  getAgyModelEnum,
  orderAgyRequestPayloadInPlace,
} from "./agy-request-metadata.ts"

type ModelMetadataFixture = {
  models: Record<string, {
    modelEnum: string
    thinkingBudget: number | null
    maxOutputTokens: number | null
  }>
}

const MODEL_METADATA_FIXTURE = JSON.parse(
  readFileSync(new URL("../../../test-fixtures/agy-cli-1.1.3-model-metadata.json", import.meta.url), "utf8"),
) as ModelMetadataFixture

describe("agy request metadata", () => {
  it("matches the captured signed FNV-1a session ID for an empty workspace URI", () => {
    expect(fnv1a64Signed("")).toBe("-3750763034362895579")
    expect(fnv1a64Signed("hello")).toBe("-6615550055289275125")
  })

  it("keeps contexts stable by key and allocates monotonic request timestamps", () => {
    const sessions = new AgyRequestSessionStore("file:///workspace", { now: () => 100 })

    const first = sessions.beginRequest("session-a")
    const second = sessions.beginRequest("session-a")
    const other = sessions.beginRequest("session-b")

    expect(second.session).toBe(first.session)
    expect(second.timestamp).toBe(101)
    expect(other.session).not.toBe(first.session)
    expect(other.session.numericSessionId).toBe(first.session.numericSessionId)
  })

  it("creates stable session IDs with independently generated conversation and trajectory IDs", () => {
    expect(createAgyRequestSessionContext("file:///workspace", {
      conversationId: "conversation-id",
      trajectoryId: "trajectory-id",
    })).toEqual({
      conversationId: "conversation-id",
      trajectoryId: "trajectory-id",
      numericSessionId: fnv1a64Signed("file:///workspace"),
    })
  })

  it("orders request fields like captured agy 1.1.3 payloads", () => {
    const payload: Record<string, unknown> = {
      generationConfig: {},
      sessionId: "session",
      contents: [],
      labels: {},
      toolConfig: {},
      tools: [],
      systemInstruction: {},
    }

    orderAgyRequestPayloadInPlace(payload)

    expect(Object.keys(payload)).toEqual([
      "contents",
      "systemInstruction",
      "tools",
      "toolConfig",
      "labels",
      "generationConfig",
      "sessionId",
    ])
  })

  it("derives last_step_index from the number of content parts", () => {
    const payload = {
      contents: [
        { role: "user", parts: [{ text: "prompt" }] },
        {
          role: "model",
          parts: [
            { text: "thinking", thought: true },
            { functionCall: { name: "read", args: {} } },
          ],
        },
        { role: "user", parts: [{ functionResponse: { name: "read", response: {} } }] },
      ],
    }

    expect(countAgyRequestSteps(payload)).toBe(4)
    expect(countAgyRequestSteps({ contents: [] })).toBe(1)
    expect(countAgyRequestSteps({})).toBe(1)
  })

  it("builds captured Claude request IDs, labels, and numeric session ID", () => {
    const session = createAgyRequestSessionContext("", {
      conversationId: "conversation-id",
      trajectoryId: "trajectory-id",
    })
    const metadata = buildAgyAgentRequestMetadata(session, {
      contents: [
        { role: "user", parts: [{ text: "prompt" }] },
        {
          role: "model",
          parts: [
            { text: "thinking", thought: true },
            { functionCall: { name: "read", args: {} } },
          ],
        },
        { role: "user", parts: [{ functionResponse: { name: "read", response: {} } }] },
      ],
    }, "claude-sonnet-4-6", 1_784_285_195_116)

    expect(metadata).toEqual({
      requestId: "agent/conversation-id/1784285195116/trajectory-id/5",
      sessionId: "-3750763034362895579",
      lastStepIndex: 4,
      labels: {
        last_step_index: "4",
        model_enum: "MODEL_PLACEHOLDER_M35",
        trajectory_id: "trajectory-id",
        used_claude: "true",
        used_claude_conservative: "true",
        used_non_gemini_model: "true",
      },
    })
  })

  it("matches every captured agy 1.1.3 model enum fixture", () => {
    for (const [model, expected] of Object.entries(MODEL_METADATA_FIXTURE.models)) {
      expect(getAgyModelEnum(model), model).toBe(expected.modelEnum)
    }
  })

  it("keeps cumulative non-Gemini usage flags when a session switches back to Gemini", () => {
    const session = createAgyRequestSessionContext("", {
      conversationId: "conversation-id",
      trajectoryId: "trajectory-id",
    })
    const payload = { contents: [{ role: "user", parts: [{ text: "prompt" }] }] }

    buildAgyAgentRequestMetadata(session, payload, "claude-sonnet-4-6", 1)
    const gemini = buildAgyAgentRequestMetadata(session, payload, "gemini-3-flash-agent", 2)

    expect(gemini.labels.used_claude).toBe("true")
    expect(gemini.labels.used_claude_conservative).toBe("true")
    expect(gemini.labels.used_non_gemini_model).toBe("true")
  })

  it("omits an unverified model enum while retaining safe labels", () => {
    const session = createAgyRequestSessionContext("", {
      conversationId: "conversation-id",
      trajectoryId: "trajectory-id",
    })
    const metadata = buildAgyAgentRequestMetadata(
      session,
      { contents: [{ role: "user", parts: [{ text: "prompt" }] }] },
      "unknown-model",
      1,
    )

    expect(metadata.labels).not.toHaveProperty("model_enum")
    expect(metadata.labels.used_claude).toBe("false")
    expect(metadata.labels.used_non_gemini_model).toBe("false")
  })
})
