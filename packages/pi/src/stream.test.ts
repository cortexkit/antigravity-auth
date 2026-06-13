import { describe, expect, it } from "vitest"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"

import { parseGeminiSse, updateUsage } from "./stream.ts"

function fakeModel(): Model<Api> {
  return {
    id: "antigravity-gemini-3.5-flash",
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
