import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ensureProjectContext,
  fetchWithAgyCliTransport,
} from "@cortexkit/antigravity-auth-core"
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai"

vi.mock("@cortexkit/antigravity-auth-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cortexkit/antigravity-auth-core")>()
  return {
    ...actual,
    ensureProjectContext: vi.fn(async () => ({ effectiveProjectId: "test-project" })),
    fetchWithAgyCliTransport: vi.fn(),
  }
})

import {
  convertGeminiToolCallPart,
  finalizePiAntigravityRequest,
  parseGeminiSse,
  resolvePiAntigravityModel,
  streamCortexKitAntigravity,
  updateUsage,
} from "./stream.ts"

function fakeModel(id = "antigravity-gemini-3.5-flash"): Model<Api> {
  return {
    id,
    api: "google-generative-ai",
    provider: "google-antigravity",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<Api>
}

function emptyOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "google-generative-ai",
    provider: "google-antigravity",
    model: "antigravity-gemini-3.5-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  }
}

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

function openSseResponse(frame: string): {
  response: Response
  wasCancelled: () => boolean
} {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame))
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    wasCancelled: () => cancelled,
  }
}

function stalledSseResponse(frame: string): {
  response: Response
  abort: () => void
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      controller.enqueue(new TextEncoder().encode(frame))
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    abort: () => streamController?.error(new Error("aborted")),
  }
}

function userContext(): Context {
  return { messages: [{ role: "user", content: "test", timestamp: 1 }] }
}

async function runStream(
  model: Model<Api>,
  response: Response,
  sessionId: string,
  onAbort?: () => void,
) {
  vi.mocked(fetchWithAgyCliTransport).mockImplementationOnce(async (_url, _init, transportOptions) => {
    if (onAbort) transportOptions?.signal?.addEventListener("abort", onAbort, { once: true })
    return response
  })
  const eventStream = streamCortexKitAntigravity(model, userContext(), {
    apiKey: "test-token",
    sessionId,
  })
  const events = []
  for await (const event of eventStream) {
    events.push(event)
  }
  return { events, result: await eventStream.result() }
}

afterEach(() => {
  vi.mocked(fetchWithAgyCliTransport).mockReset()
  vi.mocked(ensureProjectContext).mockClear()
})

describe("resolvePiAntigravityModel", () => {
  const gemini36 = {
    ...fakeModel(),
    id: "antigravity-gemini-3.6-flash",
    reasoning: true,
  }

  it.each([
    ["low", "gemini-3.6-flash-low", 1000],
    ["medium", "gemini-3.6-flash-medium", 4000],
    ["high", "gemini-3.6-flash-high", 10000],
  ] as const)("maps Pi %s thinking to the captured AGY route", (reasoning, actualModel, thinkingBudget) => {
    expect(resolvePiAntigravityModel(gemini36, reasoning)).toMatchObject({
      actualModel,
      thinkingBudget,
    })
  })

  it("clamps unsupported edge levels to live AGY tiers", () => {
    expect(resolvePiAntigravityModel(gemini36, "minimal").actualModel).toBe("gemini-3.6-flash-low")
    expect(resolvePiAntigravityModel(gemini36, "xhigh").actualModel).toBe("gemini-3.6-flash-high")
  })
})

describe("finalizePiAntigravityRequest", () => {
  it("adds AGY 1.1.5 session metadata and VALIDATED tool configuration", () => {
    const request: Record<string, unknown> = {
      generationConfig: { thinkingConfig: { thinkingBudget: 10_000 } },
      tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "OBJECT" } }] }],
      systemInstruction: { parts: [{ text: "system" }] },
      contents: [{ role: "user", parts: [{ text: "prompt" }] }],
    }

    const requestId = finalizePiAntigravityRequest(
      request,
      "gemini-3-flash-agent",
      {
        session: {
          conversationId: "conversation-id",
          trajectoryId: "trajectory-id",
          numericSessionId: "-3750763034362895579",
        },
        timestamp: 1_784_285_195_116,
      },
    )

    expect(requestId).toBe("agent/conversation-id/1784285195116/trajectory-id/2")
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } })
    expect(request.labels).toEqual({
      last_step_index: "1",
      model_enum: "MODEL_PLACEHOLDER_M84",
      trajectory_id: "trajectory-id",
      used_claude: "false",
      used_claude_conservative: "false",
      used_non_gemini_model: "false",
    })
    expect(request.sessionId).toBe("-3750763034362895579")
    expect(Object.keys(request)).toEqual([
      "contents",
      "systemInstruction",
      "tools",
      "toolConfig",
      "labels",
      "generationConfig",
      "sessionId",
    ])
  })
})

describe("convertGeminiToolCallPart", () => {
  it("preserves the backend function-call ID", () => {
    const state = {}
    const toolCall = convertGeminiToolCallPart(
      { functionCall: { name: "read", args: { path: "a.ts" }, id: "toolu_vrtx_123" } },
      state,
    )

    expect(toolCall).toEqual({
      type: "toolCall",
      id: "toolu_vrtx_123",
      name: "read",
      arguments: { path: "a.ts" },
    })
  })

  it("generates an ID when the backend omits one", () => {
    const toolCall = convertGeminiToolCallPart(
      { functionCall: { name: "read", args: {} } },
      {},
    )

    expect(toolCall?.id).toMatch(/^call_[0-9a-f-]{36}$/)
  })

  it("carries a preceding thought signature onto the next function call", () => {
    const state = {}

    expect(convertGeminiToolCallPart(
      { text: "", thought: true, thoughtSignature: "SIG123" },
      state,
    )).toBeUndefined()

    expect(convertGeminiToolCallPart(
      { functionCall: { name: "read", args: {}, id: "c1" } },
      state,
    )).toEqual({
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: {},
      thoughtSignature: "SIG123",
    })
    expect(convertGeminiToolCallPart(
      { functionCall: { name: "grep", args: {}, id: "c2" } },
      state,
    )).not.toHaveProperty("thoughtSignature")
  })

  it("attaches a parallel batch signature only to the first function call", () => {
    const state = {}

    convertGeminiToolCallPart({ thought: true, thoughtSignature: "SIG1" }, state)
    const first = convertGeminiToolCallPart(
      { functionCall: { name: "read", args: {}, id: "c1" } },
      state,
    )
    const second = convertGeminiToolCallPart(
      { functionCall: { name: "grep", args: {}, id: "c2" } },
      state,
    )

    expect(first?.thoughtSignature).toBe("SIG1")
    expect(second).not.toHaveProperty("thoughtSignature")
  })
})

describe("streamCortexKitAntigravity", () => {
  it("streams thinking and transfers a pending signature to visible text", async () => {
    const { events, result } = await runStream(
      fakeModel("antigravity-claude-opus-4-6-thinking"),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"reasoning","thought":true}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thought":true,"thoughtSignature":"SIG123"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3}}}\n\n',
      ]),
      "thinking-text-signature",
    )

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ])
    expect(result.content).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer", textSignature: "SIG123" },
    ])
  })

  it("adds execution metadata after a completed turn", async () => {
    const terminal = () => sseResponse([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
    ])

    await runStream(fakeModel(), terminal(), "execution-metadata")
    await runStream(fakeModel(), terminal(), "execution-metadata")

    const calls = vi.mocked(fetchWithAgyCliTransport).mock.calls
    const firstBody = JSON.parse(String(calls.at(-2)?.[1]?.body))
    const secondBody = JSON.parse(String(calls.at(-1)?.[1]?.body))
    expect(firstBody.request.labels).not.toHaveProperty("last_execution_id")
    expect(firstBody.request.labels.last_step_index).toBe("1")
    expect(secondBody.request.labels.last_execution_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondBody.request.labels.last_step_index).toBe("2")
  })

  it("does not rotate execution metadata on a tool-call turn", async () => {
    await runStream(
      fakeModel("antigravity-claude-opus-4-6-thinking"),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{},"id":"c1"}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ]),
      "tool-execution-metadata",
    )
    await runStream(
      fakeModel("antigravity-claude-opus-4-6-thinking"),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ]),
      "tool-execution-metadata",
    )

    const secondBody = JSON.parse(String(vi.mocked(fetchWithAgyCliTransport).mock.calls.at(-1)?.[1]?.body))
    expect(secondBody.request.labels).not.toHaveProperty("last_execution_id")
    expect(secondBody.request.labels.last_step_index).toBe("1")
  })

  it("releases and cancels an open response body after STOP", async () => {
    const open = openSseResponse(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
    )
    const { result } = await runStream(
      fakeModel("antigravity-claude-opus-4-6-thinking"),
      open.response,
      "open-response-cleanup",
    )

    expect(result.stopReason).toBe("stop")
    expect(open.wasCancelled()).toBe(true)
  })

  it("consumes GPT usage metadata sent after STOP", async () => {
    const { result } = await runStream(
      fakeModel("antigravity-gpt-oss-120b-medium"),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}}\n\n',
        'data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}}\n\n',
      ]),
      "gpt-trailing-usage",
    )

    expect(result.stopReason).toBe("stop")
    expect(result.usage.input).toBe(10)
    expect(result.usage.output).toBe(3)
    expect(result.usage.totalTokens).toBe(13)
  })

  it("finishes a GPT turn when trailing usage never arrives", async () => {
    const stalled = stalledSseResponse(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}}\n\n',
    )
    const { result } = await runStream(
      fakeModel("antigravity-gpt-oss-120b-medium"),
      stalled.response,
      "gpt-missing-trailing-usage",
      stalled.abort,
    )

    expect(result.stopReason).toBe("stop")
    expect(result.content).toEqual([{ type: "text", text: "answer" }])
  })
})

describe("parseGeminiSse", () => {
  it("parses and unwraps the Antigravity response envelope into chunks", async () => {
    // Antigravity wraps each chunk under a `response` key (MITM-verified).
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":3}}}\n\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "hi" })
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBe("STOP")
    expect(chunks[1]?.usageMetadata?.candidatesTokenCount).toBe(3)
  })

  it("handles frames split across read boundaries", async () => {
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"rol',
      'e":"model","parts":[{"text":"split"}]}}]}}\n\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "split" })
  })

  it("ignores [DONE] sentinels and malformed frames", async () => {
    const response = sseResponse([
      "data: [DONE]\n\n",
      "data: not-json\n\n",
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.candidates?.[0]?.finishReason).toBe("STOP")
  })

  it("parses CRLF-separated frames (Antigravity wire format)", async () => {
    // Antigravity separates frames with \r\n\r\n, which contains no \n\n.
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"crlf"}]}}]}}\r\n\r\n',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\r\n\r\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "crlf" })
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBe("STOP")
  })

  it("flushes a trailing frame without a blank-line separator", async () => {
    const response = sseResponse([
      'data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"tail"}]}}]}}',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "tail" })
  })

  it("returns nothing for an empty body", async () => {
    const response = new Response(null, { status: 200 })
    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(0)
  })
})

describe("updateUsage", () => {
  it("counts thinking tokens as output and splits cached prompt tokens", () => {
    const output = emptyOutput()
    // MITM-observed: total = prompt + candidates + thoughts.
    updateUsage(fakeModel(), output, {
      promptTokenCount: 11597,
      candidatesTokenCount: 16,
      thoughtsTokenCount: 50,
      cachedContentTokenCount: 4000,
      totalTokenCount: 11663,
    })
    expect(output.usage.input).toBe(11597 - 4000)
    expect(output.usage.cacheRead).toBe(4000)
    expect(output.usage.output).toBe(16 + 50)
    expect(output.usage.totalTokens).toBe(7597 + 66 + 4000)
  })

  it("treats promptTokenCount as the full prompt when no cache is reported", () => {
    const output = emptyOutput()
    updateUsage(fakeModel(), output, {
      promptTokenCount: 100,
      candidatesTokenCount: 10,
    })
    expect(output.usage.input).toBe(100)
    expect(output.usage.cacheRead).toBe(0)
    expect(output.usage.output).toBe(10)
  })
})
