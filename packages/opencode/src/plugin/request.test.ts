import { readFileSync } from "node:fs";

import { describe, it, expect, vi } from "vitest";
import {
  prepareAntigravityRequest,
  transformAntigravityResponse,
  getPluginSessionId,
  isGenerativeLanguageRequest,
  __testExports,
} from "./request";
import { DEFAULT_CONFIG } from "./config";
import { initializeDebug } from "./debug";
import { SKIP_THOUGHT_SIGNATURE } from "../constants";
import * as config from "./config";
import type { SignatureStore, ThoughtBuffer, StreamingCallbacks, StreamingOptions } from "./core/streaming/types";

const AGY_1_1_3_WIRE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../../../test-fixtures/agy-cli-1.1.3-stream-request.json", import.meta.url), "utf8"),
) as { envelopeKeys: string[]; requestKeys: string[] };

const {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasToolUseInContents,
  hasSignedThinkingInContents,
  hasToolUseInMessages,
  hasSignedThinkingInMessages,
  MIN_SIGNATURE_LENGTH,
  transformStreamingPayload,
  createStreamingTransformer,
  transformSseLine,
} = __testExports;

function createMockSignatureStore(): SignatureStore {
  const store = new Map<string, { text: string; signature: string }>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: { text: string; signature: string }) => store.set(key, value),
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
  };
}

function createMockThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (idx: number) => buffer.get(idx),
    set: (idx: number, text: string) => buffer.set(idx, text),
    clear: () => buffer.clear(),
  };
}

const defaultCallbacks: StreamingCallbacks = {};
const defaultOptions: StreamingOptions = {};
const defaultDebugState = { injected: false };

function withKeepThinking<T>(enabled: boolean, fn: () => T): T {
  const keepThinkingSpy = vi.spyOn(config, "getKeepThinking").mockReturnValue(enabled);
  try {
    return fn();
  } finally {
    keepThinkingSpy.mockRestore();
  }
}

describe("request.ts", () => {
  describe("getPluginSessionId", () => {
    it("returns consistent session ID across calls", () => {
      const id1 = getPluginSessionId();
      const id2 = getPluginSessionId();
      expect(id1).toBe(id2);
      expect(id1).toBeTruthy();
    });
  });

  describe("isGenerativeLanguageRequest", () => {
    it("returns true for generativelanguage.googleapis.com URLs", () => {
      expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1/models")).toBe(true);
    });

    it("returns false for other URLs", () => {
      expect(isGenerativeLanguageRequest("https://api.anthropic.com/v1/messages")).toBe(false);
    });

    it("detects URL and Request inputs (not only strings)", () => {
      // Matching on string-only would let fetch(new Request(...)) / fetch(new URL(...))
      // bypass the interceptor entirely.
      expect(
        isGenerativeLanguageRequest(new URL("https://generativelanguage.googleapis.com/v1/models")),
      ).toBe(true);
      expect(
        isGenerativeLanguageRequest(
          new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent"),
        ),
      ).toBe(true);
    });

    it("returns false for non-API URL and Request inputs", () => {
      expect(isGenerativeLanguageRequest(new URL("https://api.anthropic.com/v1/messages"))).toBe(false);
      expect(isGenerativeLanguageRequest(new Request("https://example.com"))).toBe(false);
    });
  });

  describe("buildSignatureSessionKey", () => {
    it("builds key from sessionId, model, project, and conversation", () => {
      const key = buildSignatureSessionKey("session-1", "claude-3", "conv-456", "proj-123");
      expect(key).toBe("session-1:claude-3:proj-123:conv-456");
    });

    it("uses defaults for missing optional params", () => {
      expect(buildSignatureSessionKey("s1", undefined, undefined, undefined)).toBe("s1:unknown:default:default");
      expect(buildSignatureSessionKey("s1", "model", undefined, undefined)).toBe("s1:model:default:default");
    });

    it("handles empty strings as defaults", () => {
      expect(buildSignatureSessionKey("s1", "", "", "")).toBe("s1:unknown:default:default");
    });
  });

  describe("hashConversationSeed", () => {
    it("returns consistent hash for same input", () => {
      const hash1 = hashConversationSeed("test-seed");
      const hash2 = hashConversationSeed("test-seed");
      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different inputs", () => {
      const hash1 = hashConversationSeed("seed-1");
      const hash2 = hashConversationSeed("seed-2");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", () => {
      const hash = hashConversationSeed("");
      expect(hash).toBeTruthy();
    });
  });

  describe("extractTextFromContent", () => {
    it("extracts text from string content", () => {
      expect(extractTextFromContent("hello world")).toBe("hello world");
    });

    it("extracts first text from content array with text blocks", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ];
      expect(extractTextFromContent(content)).toBe("hello");
    });

    it("returns empty string for non-text blocks", () => {
      const content = [{ type: "image", source: {} }];
      expect(extractTextFromContent(content)).toBe("");
    });

    it("returns first text block only (not concatenated)", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "image", source: {} },
        { type: "text", text: "after" },
      ];
      expect(extractTextFromContent(content)).toBe("before");
    });

    it("returns empty string for null/undefined", () => {
      expect(extractTextFromContent(null)).toBe("");
      expect(extractTextFromContent(undefined)).toBe("");
    });
  });

  describe("extractConversationSeedFromMessages", () => {
    it("extracts seed from first user message", () => {
      const messages = [
        { role: "user", content: "first message" },
        { role: "assistant", content: "response" },
      ];
      const seed = extractConversationSeedFromMessages(messages);
      expect(seed).toContain("first message");
    });

    it("returns empty string when no user messages", () => {
      const messages = [{ role: "assistant", content: "response" }];
      expect(extractConversationSeedFromMessages(messages)).toBe("");
    });

    it("handles empty messages array", () => {
      expect(extractConversationSeedFromMessages([])).toBe("");
    });
  });

  describe("extractConversationSeedFromContents", () => {
    it("extracts seed from first user content", () => {
      const contents = [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
      ];
      const seed = extractConversationSeedFromContents(contents);
      expect(seed).toContain("hello");
    });

    it("returns empty string when no user content", () => {
      const contents = [{ role: "model", parts: [{ text: "hi" }] }];
      expect(extractConversationSeedFromContents(contents)).toBe("");
    });
  });

  describe("resolveProjectKey", () => {
    it("returns candidate if it is a string", () => {
      expect(resolveProjectKey("my-project")).toBe("my-project");
    });

    it("returns fallback if candidate is not a string", () => {
      expect(resolveProjectKey(null, "fallback")).toBe("fallback");
      expect(resolveProjectKey(undefined, "fallback")).toBe("fallback");
      expect(resolveProjectKey({}, "fallback")).toBe("fallback");
    });

    it("returns undefined if no valid candidate or fallback", () => {
      expect(resolveProjectKey(null)).toBeUndefined();
      expect(resolveProjectKey(undefined)).toBeUndefined();
    });
  });

  describe("isGeminiToolUsePart", () => {
    it("returns true for functionCall parts", () => {
      expect(isGeminiToolUsePart({ functionCall: { name: "test" } })).toBe(true);
    });

    it("returns false for non-functionCall parts", () => {
      expect(isGeminiToolUsePart({ text: "hello" })).toBe(false);
      expect(isGeminiToolUsePart({ thought: true })).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isGeminiToolUsePart(null)).toBe(false);
      expect(isGeminiToolUsePart(undefined)).toBe(false);
    });
  });

  describe("isGeminiThinkingPart", () => {
    it("returns true for thought:true parts", () => {
      expect(isGeminiThinkingPart({ thought: true, text: "thinking..." })).toBe(true);
    });

    it("returns false for thought:false parts", () => {
      expect(isGeminiThinkingPart({ thought: false, text: "not thinking" })).toBe(false);
    });

    it("returns false for parts without thought property", () => {
      expect(isGeminiThinkingPart({ text: "hello" })).toBe(false);
    });
  });

  describe("ensureThoughtSignature", () => {
    it("adds sentinel signature when no cached signature exists", () => {
      const part = { thought: true, text: "thinking..." };
      const result = ensureThoughtSignature(part, "no-cache-session");
      // Now uses sentinel fallback to prevent API rejection
      expect(result.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("replaces untrusted thoughtSignature with sentinel", () => {
      const existingSignature = "a".repeat(MIN_SIGNATURE_LENGTH + 10);
      const part = { thought: true, text: "thinking...", thoughtSignature: existingSignature };
      const result = ensureThoughtSignature(part, "session-key");
      expect(result.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("does not modify non-thinking parts", () => {
      const part = { text: "regular text" };
      const result = ensureThoughtSignature(part, "session-key");
      expect(result.thoughtSignature).toBeUndefined();
    });

    it("returns null/undefined inputs unchanged", () => {
      expect(ensureThoughtSignature(null, "key")).toBeNull();
      expect(ensureThoughtSignature(undefined, "key")).toBeUndefined();
    });

    it("returns non-object inputs unchanged", () => {
      expect(ensureThoughtSignature("string", "key")).toBe("string");
      expect(ensureThoughtSignature(123, "key")).toBe(123);
    });
  });

  describe("hasSignedThinkingPart", () => {
    it("returns true for part with valid thoughtSignature", () => {
      const part = { thought: true, thoughtSignature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns true for type:thinking with valid signature field", () => {
      const part = { type: "thinking", thinking: "...", signature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns true for type:reasoning with valid signature field", () => {
      const part = { type: "reasoning", signature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns false for part with short signature", () => {
      const part = { thought: true, thoughtSignature: "short" };
      expect(hasSignedThinkingPart(part)).toBe(false);
    });

    it("returns false for part without signature", () => {
      const part = { thought: true, text: "no signature" };
      expect(hasSignedThinkingPart(part)).toBe(false);
    });
  });

  describe("hasToolUseInContents", () => {
    it("returns true when contents have functionCall", () => {
      const contents = [
        { role: "model", parts: [{ functionCall: { name: "test" } }] },
      ];
      expect(hasToolUseInContents(contents)).toBe(true);
    });

    it("returns false when no functionCall present", () => {
      const contents = [
        { role: "model", parts: [{ text: "hello" }] },
      ];
      expect(hasToolUseInContents(contents)).toBe(false);
    });

    it("handles empty contents", () => {
      expect(hasToolUseInContents([])).toBe(false);
    });
  });

  describe("hasSignedThinkingInContents", () => {
    it("returns true when contents have signed thinking", () => {
      const contents = [
        {
          role: "model",
          parts: [{ thought: true, thoughtSignature: "a".repeat(MIN_SIGNATURE_LENGTH) }],
        },
      ];
      expect(hasSignedThinkingInContents(contents)).toBe(true);
    });

    it("returns false when no signed thinking present", () => {
      const contents = [
        { role: "model", parts: [{ thought: true, text: "unsigned" }] },
      ];
      expect(hasSignedThinkingInContents(contents)).toBe(false);
    });
  });

  describe("hasToolUseInMessages", () => {
    it("returns true when messages have tool_use blocks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "tool_use", id: "123", name: "test" }] },
      ];
      expect(hasToolUseInMessages(messages)).toBe(true);
    });

    it("returns false when no tool_use blocks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ];
      expect(hasToolUseInMessages(messages)).toBe(false);
    });

    it("handles string content", () => {
      const messages = [{ role: "assistant", content: "just text" }];
      expect(hasToolUseInMessages(messages)).toBe(false);
    });
  });

  describe("hasSignedThinkingInMessages", () => {
    it("returns true when messages have signed thinking blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "...", signature: "a".repeat(MIN_SIGNATURE_LENGTH) }],
        },
      ];
      expect(hasSignedThinkingInMessages(messages)).toBe(true);
    });

    it("returns false when thinking blocks are unsigned", () => {
      const messages = [
        { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }] },
      ];
      expect(hasSignedThinkingInMessages(messages)).toBe(false);
    });
  });

  describe("MIN_SIGNATURE_LENGTH", () => {
    it("is 50", () => {
      expect(MIN_SIGNATURE_LENGTH).toBe(50);
    });
  });

  describe("transformSseLine", () => {
    const callTransformSseLine = (line: string) => {
      const store = createMockSignatureStore();
      const buffer = createMockThoughtBuffer();
      const sentBuffer = createMockThoughtBuffer();
      return transformSseLine(line, store, buffer, sentBuffer, defaultCallbacks, defaultOptions, { ...defaultDebugState });
    };

    it("returns empty lines unchanged", () => {
      expect(callTransformSseLine("")).toBe("");
      expect(callTransformSseLine("   ")).toBe("   ");
    });

    it("returns non-data lines unchanged", () => {
      expect(callTransformSseLine("event: message")).toBe("event: message");
      expect(callTransformSseLine(": heartbeat")).toBe(": heartbeat");
    });

    it("handles data: [DONE] unchanged", () => {
      expect(callTransformSseLine("data: [DONE]")).toBe("data: [DONE]");
    });

    it("handles invalid JSON gracefully", () => {
      expect(callTransformSseLine("data: not-json")).toBe("data: not-json");
      expect(callTransformSseLine("data: {invalid}")).toBe("data: {invalid}");
    });

    it("passes through valid JSON without thinking parts", () => {
      const payload = { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
      expect(result).toContain("hello");
    });

    it("transforms thinking parts in streaming data", () => {
      const payload = {
        candidates: [{
          content: {
            parts: [{ thought: true, text: "reasoning..." }]
          }
        }]
      };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
    });

    it("does not leak placeholder text into duplicate Claude thinking output", () => {
      const store = createMockSignatureStore();
      const buffer = createMockThoughtBuffer();
      const sentBuffer = createMockThoughtBuffer();
      const displayedThinkingHashes = new Set<string>();

      const line = `data: ${JSON.stringify({
        response: {
          content: [
            { type: "thinking", thinking: "The user wants OK", text: "The user wants OK" },
            { type: "text", text: "OK" },
          ],
        },
      })}`;

      const first = transformSseLine(
        line,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        { ...defaultOptions, displayedThinkingHashes },
        { ...defaultDebugState },
      );
      expect(first).toContain('"text":"OK"');

      const second = transformSseLine(
        line,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        { ...defaultOptions, displayedThinkingHashes },
        { ...defaultDebugState },
      );
      expect(second).not.toContain('"text":"."');
      expect(second).toContain('"text":"OK"');
    });

    it("omits empty duplicate Claude thinking chunks instead of creating blank text", () => {
      const store = createMockSignatureStore();
      const buffer = createMockThoughtBuffer();
      const sentBuffer = createMockThoughtBuffer();

      const firstLine = `data: ${JSON.stringify({
        response: {
          content: [
            { type: "thinking", thinking: "Only hidden thinking so far", text: "Only hidden thinking so far" },
          ],
        },
      })}`;

      transformSseLine(
        firstLine,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        defaultOptions,
        { ...defaultDebugState },
      );

      const duplicateLine = `data: ${JSON.stringify({
        response: {
          content: [
            { type: "thinking", thinking: "Only hidden thinking so far", text: "Only hidden thinking so far" },
          ],
        },
      })}`;

      const duplicate = transformSseLine(
        duplicateLine,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        defaultOptions,
        { ...defaultDebugState },
      );

      expect(duplicate).not.toContain('"type":"text","text":""');
      expect(duplicate).toContain('"content":[]');
    });
  });

  describe("transformStreamingPayload", () => {
    it("handles empty string", () => {
      expect(transformStreamingPayload("")).toBe("");
    });

    it("handles single line without data prefix", () => {
      expect(transformStreamingPayload("event: ping")).toBe("event: ping");
    });

    it("handles multiple lines", () => {
      const input = "event: message\ndata: [DONE]\n";
      const result = transformStreamingPayload(input);
      expect(result).toContain("event: message");
      expect(result).toContain("data: [DONE]");
    });

    it("preserves line structure", () => {
      const input = "line1\nline2\nline3";
      const result = transformStreamingPayload(input);
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
    });
  });

  describe("createStreamingTransformer", () => {
    it("returns a TransformStream", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      expect(transformer).toBeInstanceOf(TransformStream);
      expect(transformer.readable).toBeDefined();
      expect(transformer.writable).toBeDefined();
    });

    it("accepts optional signatureSessionKey", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts optional debugText", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", debugText: "debug info" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts cacheSignatures flag", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", cacheSignatures: true });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("processes chunks through the stream", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      
      const input = encoder.encode("data: [DONE]\n");
      const outputChunks: Uint8Array[] = [];
      
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      
      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(value);
        }
      })();
      
      await writer.write(input);
      await writer.close();
      await readPromise;
      
      const output = outputChunks.map(chunk => decoder.decode(chunk)).join("");
      expect(output).toContain("[DONE]");
    });

    it("terminates a finished stream even if the upstream body stays open", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const terminalToolCall = {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: "read", args: { filePath: "README.md" } } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      };

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminalToolCall)}\n`));
        },
      });
      const reader = source.pipeThrough(transformer).getReader();
      let output = "";
      let done = false;

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not terminate")), 100)),
        ]);
        if (result.done) {
          done = true;
          break;
        }
        output += decoder.decode(result.value);
      }

      expect(done).toBe(true);
      expect(output).toContain("functionCall");
      expect(output).toContain("usageMetadata");
      expect(output.endsWith("\n\n")).toBe(true);
    });

    it("merges terminal cached usage into buffered Gemini tool-call events", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const toolCall = {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: "bash", args: { command: "printf cache" } } },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 41880,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 45,
            totalTokenCount: 41950,
          },
        },
      };
      const terminalStop = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: "" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 41880,
            cachedContentTokenCount: 40682,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 45,
            totalTokenCount: 41950,
          },
        },
      };

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolCall)}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminalStop)}\n`));
        },
      });
      const reader = source.pipeThrough(transformer).getReader();
      let output = "";
      let done = false;

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not terminate")), 100)),
        ]);
        if (result.done) {
          done = true;
          break;
        }
        output += decoder.decode(result.value);
      }

      expect(done).toBe(true);
      const dataLines = output
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));

      expect(dataLines[0].candidates[0].content.parts[0].functionCall.name).toBe("bash");
      expect(dataLines[0].usageMetadata.cachedContentTokenCount).toBe(40682);
      expect(dataLines[1].candidates[0].finishReason).toBe("STOP");
      expect(output.endsWith("\n\n")).toBe(true);
    });

    it("merges terminal cached usage into a short final text event", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const textEvent = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: "CACHE_MERGE_TOOL_OK" }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 41924,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 31,
            totalTokenCount: 41967,
          },
        },
      };
      const terminalStop = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: "" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 41975,
            cachedContentTokenCount: 40673,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 31,
            totalTokenCount: 42018,
          },
        },
      };

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(textEvent)}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminalStop)}\n`));
        },
      });
      const reader = source.pipeThrough(transformer).getReader();
      let output = "";
      let done = false;

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not terminate")), 100)),
        ]);
        if (result.done) {
          done = true;
          break;
        }
        output += decoder.decode(result.value);
      }

      expect(done).toBe(true);
      const dataLines = output
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));

      expect(dataLines[0].candidates[0].content.parts[0].text).toBe("CACHE_MERGE_TOOL_OK");
      expect(dataLines[0].usageMetadata.cachedContentTokenCount).toBe(40673);
      expect(dataLines[1].candidates[0].finishReason).toBe("STOP");
      expect(output.endsWith("\n\n")).toBe(true);
    });

    it("terminates a finished empty-text stream even when there is no tool call", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const terminalEmptyText = {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      };

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminalEmptyText)}\n`));
        },
      });
      const reader = source.pipeThrough(transformer).getReader();
      let output = "";
      let done = false;

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not terminate")), 100)),
        ]);
        if (result.done) {
          done = true;
          break;
        }
        output += decoder.decode(result.value);
      }

      expect(done).toBe(true);
      expect(output).toContain("finishReason");
      expect(output).toContain("usageMetadata");
      expect(output.endsWith("\n\n")).toBe(true);
    });
  });

  describe("prepareAntigravityRequest", () => {
    const mockAccessToken = "test-token";
    const mockProjectId = "test-project";

    it("returns unchanged request for non-generative-language URLs", () => {
      const result = prepareAntigravityRequest(
        "https://example.com/api",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
      expect(result.request).toBe("https://example.com/api");
    });

    it("returns unchanged request for URLs without model pattern", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1/models",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("uses the stable default project id when none is provided (no per-request random)", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:streamGenerateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        "", // empty projectId — must fall back to the stable default, not a random id
      );
      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.project).toBe("rising-fact-p41fc");
    });

    it("detects streaming from generateStreamContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(true);
    });

    it("detects non-streaming from generateContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("sets Authorization header with Bearer token", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    });

it("removes x-api-key header", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-api-key": "old-key" } },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-api-key")).toBeNull();
    });

    it("removes x-goog-user-project header for antigravity headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("removes x-goog-user-project header for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("uses GeminiCLI User-Agent for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("User-Agent")).toMatch(/^GeminiCLI\//);
      expect(headers.get("X-Goog-Api-Client")).toBe("gl-node/22.17.0");
      expect(headers.get("Client-Metadata")).toBe("ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI");
    });
    it("builds gemini-cli wrapped body without antigravity-only fields", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
        mockAccessToken,
        "",
        undefined,
        "gemini-cli"
      );
      const parsed = JSON.parse(result.init.body as string);
      expect(parsed).toHaveProperty("project", "");
      expect(parsed).toHaveProperty("model");
      expect(parsed).toHaveProperty("request");
      expect(parsed.requestType).toBeUndefined();
      expect(parsed.userAgent).toBeUndefined();
      expect(parsed.requestId).toBeUndefined();
    });

    it("orders antigravity envelope fields like captured agy CLI", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity"
      );

      const body = result.init.body as string;
      const parsed = JSON.parse(body);
      expect(Object.keys(parsed)).toEqual(AGY_1_1_3_WIRE_FIXTURE.envelopeKeys);
      expect(parsed.requestId).toMatch(/^agent\/.+\/2$/);
      expect(parsed.userAgent).toBe("antigravity");
      expect(parsed.requestType).toBe("agent");
    });

    it("identifies Claude models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-20250514:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("claude");
    });

    it("identifies Gemini models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("gemini");
    });

    it("uses custom endpoint override", () => {
      const customEndpoint = "https://custom.api.com";
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        customEndpoint
      );
      expect(result.endpoint).toContain(customEndpoint);
    });

    it("handles wrapped Antigravity body format", () => {
      const wrappedBody = {
        project: "my-project",
        request: { contents: [{ parts: [{ text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles unwrapped body format", () => {
      const unwrappedBody = {
        contents: [{ parts: [{ text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("does not add Claude auto-caching to wrapped request by default", () => {
      const wrappedBody = {
        project: "my-project",
        request: { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
    });

    it("does not add Claude auto-caching to unwrapped request by default", () => {
      const unwrappedBody = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
    });

    it("normalizes whitespace-only Claude text blocks before sending", () => {
      const unwrappedBody = {
        messages: [
          { role: "user", content: [{ type: "text", text: "   \n\t  " }] },
        ],
      }

      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.messages[0].content[0]).toEqual({ type: "text", text: "." })
    })

    it("does not inject Claude auto-caching markers on the Antigravity proxy even when enabled", () => {
      const unwrappedBody = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
        false,
        { claudePromptAutoCaching: true },
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
      expect(wrapped.request.messages[0].content[0].cache_control).toBeUndefined();
    });

    it("strips host-only cache fields and configures VALIDATED tool calls on the agy path", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            providerOptions: { google: { thinkingLevel: "high" } },
            cached_content: "top-snake",
            cachedContent: "top-camel",
            extra_body: {
              cached_content: "extra-snake",
              cachedContent: "extra-camel",
              keep: "preserved",
            },
            systemInstruction: {
              parts: [{ text: "system", cacheControl: { type: "ephemeral" } }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: "hello", cache_control: { type: "ephemeral" } }],
              },
              {
                role: "model",
                parts: [{ functionCall: { name: "lookup", args: { cacheControl: "tool-data" } } }],
              },
            ],
            tools: [{
              functionDeclarations: [{
                name: "lookup",
                description: "Look something up",
                parameters: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              }],
            }],
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
      );

      const wrapped = JSON.parse(result.init.body as string);
      const request = wrapped.request;
      expect(result.effectiveModel).toBe("gemini-3-flash-agent");
      expect(request.providerOptions).toBeUndefined();
      expect(request.cached_content).toBeUndefined();
      expect(request.cachedContent).toBeUndefined();
      expect(request.extra_body).toEqual({ keep: "preserved" });
      expect(request.systemInstruction.parts[0].cacheControl).toBeUndefined();
      expect(request.contents[0].parts[0].cache_control).toBeUndefined();
      expect(request.contents[1].parts[0].functionCall.args.cacheControl).toBe("tool-data");
      expect(request.toolConfig).toEqual({
        functionCallingConfig: { mode: "VALIDATED" },
      });
    });

    it("sanitizes already-wrapped agy requests and preserves existing tool config fields", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            project: mockProjectId,
            request: {
              providerOptions: { google: { thinkingLevel: "medium" } },
              cachedContent: "cached-resource",
              contents: [{ role: "user", parts: [{ text: "hi", cacheControl: { type: "ephemeral" } }] }],
              tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "OBJECT", properties: {} } }] }],
              toolConfig: {
                functionCallingConfig: { allowedFunctionNames: ["read"] },
              },
            },
            model: "gemini-3-flash-agent",
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.providerOptions).toBeUndefined();
      expect(wrapped.request.cachedContent).toBeUndefined();
      expect(wrapped.request.contents[0].parts[0].cacheControl).toBeUndefined();
      expect(wrapped.request.toolConfig).toEqual({
        functionCallingConfig: {
          allowedFunctionNames: ["read"],
          mode: "VALIDATED",
        },
      });
    });

    it("keeps explicit cachedContent references on the Gemini CLI path", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            cached_content: "cachedContents/example",
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cached_content).toBeUndefined();
      expect(wrapped.request.cachedContent).toBe("cachedContents/example");
    });

    it("does not send toolConfig when an agy request has no tools", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.toolConfig).toBeUndefined();
    });

    it("strips Claude thinking blocks when keep_thinking is false (unwrapped)", () => {
      const result = withKeepThinking(false, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "foreign-thought-unwrapped",
                    thoughtSignature: "f".repeat(MIN_SIGNATURE_LENGTH + 8),
                  },
                  { functionCall: { name: "weather", args: {} } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      // Sentinel replacement: thinking parts are replaced with plain empty text parts (not deleted) to preserve array indices for cache
      // Plain text sentinels avoid the proxy converting them to Claude thinking blocks with missing fields
      expect(parts).toHaveLength(2); // Array length preserved (1 sentinel + 1 functionCall)
      expect(parts[0]).toMatchObject({ text: "." }); // Thinking replaced with plain space text
      expect(parts[0]).not.toHaveProperty("thought");
      expect(parts[0]).not.toHaveProperty("thoughtSignature");
      expect(result.needsSignedThinkingWarmup).toBe(false);
    });

    it("strips Claude thinking blocks when keep_thinking is false (wrapped)", () => {      const result = withKeepThinking(false, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            project: "my-project",
            request: {
              contents: [
                {
                  role: "model",
                  parts: [
                    {
                      thought: true,
                      text: "foreign-thought-wrapped",
                      thoughtSignature: "w".repeat(MIN_SIGNATURE_LENGTH + 8),
                    },
                    { functionCall: { name: "weather", args: {} } },
                  ],
                },
              ],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;

      // Sentinel replacement: thinking parts are replaced with plain empty text parts (not deleted) to preserve array indices for cache
      expect(parts).toHaveLength(2); // Array length preserved (1 sentinel + 1 functionCall)
      expect(parts[0]).toMatchObject({ text: "." }); // Thinking replaced with plain space text
      expect(parts[0]).not.toHaveProperty("thought");
      expect(parts[0]).not.toHaveProperty("thoughtSignature");
      expect(result.needsSignedThinkingWarmup).toBe(false);    });

    it("does not trust foreign Gemini thoughtSignature when keep_thinking is true", () => {      const foreignSignature = "x".repeat(MIN_SIGNATURE_LENGTH + 8);
      const result = withKeepThinking(true, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "foreign-thought-keep-true",
                    thoughtSignature: foreignSignature,
                  },
                  { functionCall: { name: "weather", args: {} } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingBlock = parts.find((part) =>
        part.thought === true || part.type === "thinking" || part.type === "redacted_thinking",
      );
      const signature = typeof thinkingBlock?.signature === "string"
        ? thinkingBlock.signature
        : thinkingBlock?.thoughtSignature;

      expect(JSON.stringify(wrapped)).not.toContain(foreignSignature);
      if (thinkingBlock) {
        expect(signature).toBe(SKIP_THOUGHT_SIGNATURE);
      }
    });

    it("replaces foreign Claude signatures with sentinel when keep_thinking is true", () => {
      const foreignSignature = "y".repeat(MIN_SIGNATURE_LENGTH + 8);
      const result = withKeepThinking(true, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "foreign-message-thinking",
                    signature: foreignSignature,
                  },
                  {
                    type: "tool_use",
                    id: "tool-1",
                    name: "weather",
                    input: {},
                  },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const content = wrapped.request.messages[0].content as Array<Record<string, unknown>>;

      // Sentinel replacement: thinking blocks become plain empty text parts
      // This avoids the proxy converting them to Claude thinking blocks with missing required fields
      const textSentinel = content.find((block) => block.text === "." && !block.type);
      expect(textSentinel).toBeTruthy();
      expect(JSON.stringify(content)).not.toContain(foreignSignature);
      // Without a signed replayable block, the compatibility path requests a warmup.
      expect(result.needsSignedThinkingWarmup).toBe(true);    });

    it("returns requestedModel matching URL model", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.requestedModel).toBe("gemini-2.5-flash");
    });

    it("handles empty body gracefully", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({}) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles minimal valid JSON body", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("removes contents entries with empty or invalid parts", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [] },
              { role: "model", parts: [null, { text: "kept" }] },
              { role: "user", parts: null },
            ],
            systemInstruction: {
              role: "user",
              parts: [null, { text: "system kept" }],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      // Fix F: content entries preserved (not filtered) to avoid index shifts that bust cache
      expect(wrapped.request.contents).toHaveLength(3);
      // Entry with empty parts preserved as-is
      expect(wrapped.request.contents[0].role).toBe("user");
      // Entry with valid parts keeps them (invalid parts replaced with sentinel to preserve indices)
      expect(wrapped.request.contents[1]).toEqual({
        role: "model",
        parts: [{ text: "." }, { text: "kept" }],
      });
      // systemInstruction parts: null replaced with sentinel, valid parts kept
      expect(wrapped.request.systemInstruction.parts).toEqual([{ text: "." }, { text: "system kept" }]);
    });

    it("drops systemInstruction when all parts are invalid", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            systemInstruction: {
              role: "user",
              parts: [null],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.systemInstruction).toBeUndefined();
    });

    it("preserves headerStyle in response", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      expect(result.headerStyle).toBe("gemini-cli");
    });

    describe("Issue #103: model name transformation during quota fallback", () => {
      it("transforms gemini-3-flash-preview to gemini-3-flash for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash-medium");
      });

      it("transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-low");
      });

      it("transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("maps Gemini 3.5 Flash to the captured agy medium model", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        const wrapped = JSON.parse(result.init.body as string);
        expect(result.effectiveModel).toBe("gemini-3.5-flash-low");
        expect(wrapped.model).toBe("gemini-3.5-flash-low");
        expect(wrapped.request.generationConfig.thinkingConfig.thinkingBudget).toBe(4000);
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(65536);
      });

      it("maps Claude Sonnet 4.6 Thinking to the captured agy thinking config", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-4-6-thinking:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [], generationConfig: {} }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        const wrapped = JSON.parse(result.init.body as string);
        expect(result.effectiveModel).toBe("claude-sonnet-4-6");
        expect(wrapped.model).toBe("claude-sonnet-4-6");
        expect(wrapped.request.generationConfig.thinkingConfig).toEqual({
          includeThoughts: true,
          thinkingBudget: 1024,
        });
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(64000);
      });

      it("uses captured agy Claude Opus config while retaining the OpenCode cache boundary", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-opus-4-6-thinking:generateContent",
          {
            method: "POST",
            body: JSON.stringify({
              generationConfig: {},
              systemInstruction: { parts: [{ text: "base system" }] },
              contents: [
                { role: "user", parts: [{ text: "read the file" }] },
                { role: "model", parts: [{ functionCall: { name: "read", args: {} } }] },
                { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "ok" } } }] },
              ],
              tools: [{
                functionDeclarations: [{
                  name: "read",
                  description: "Read a file",
                  parameters: {
                    type: "object",
                    properties: { filePath: { type: "string" } },
                    required: ["filePath"],
                  },
                }],
              }],
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity",
        );

        const wrapped = JSON.parse(result.init.body as string);
        const serialized = JSON.stringify(wrapped.request);
        expect(result.effectiveModel).toBe("claude-opus-4-6-thinking");
        expect(result.needsSignedThinkingWarmup).toBe(false);
        expect(wrapped.request.generationConfig.thinkingConfig).toEqual({
          includeThoughts: true,
          thinkingBudget: 1024,
        });
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(64000);
        expect(wrapped.request.contents.map((content: { role: string }) => content.role)).toEqual([
          "user",
          "model",
          "user",
          "model",
          "user",
        ]);
        expect(serialized).toContain("Interleaved thinking is enabled");
        expect(serialized).toContain("[Tool execution completed.]");
        expect(serialized).toContain("[Continue]");
      });

      it("maps Gemini 3.5 Flash medium variant to the live Antigravity medium-tier model", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent",
          {
            method: "POST",
            body: JSON.stringify({
              contents: [],
              generationConfig: {},
              providerOptions: { google: { thinkingLevel: "medium" } },
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        const wrapped = JSON.parse(result.init.body as string);
        expect(result.effectiveModel).toBe("gemini-3.5-flash-low");
        expect(wrapped.model).toBe("gemini-3.5-flash-low");
        expect(wrapped.request.generationConfig.thinkingConfig.thinkingBudget).toBe(4000);
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(65536);
        expect(wrapped.request.generationConfig.thinkingConfig.thinkingLevel).toBeUndefined();
      });

      it("transforms gemini-3-flash to gemini-3-flash-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash-preview");
      });

      it("transforms gemini-3-pro-low to gemini-3-pro-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-preview");
      });

      it("transforms gemini-3.1-pro-low to gemini-3.1-pro-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview");
      });

      it("keeps gemini-3.1-pro-preview-customtools unchanged for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview-customtools");
      });

      it("maps Gemini 3.5 Flash to the live Gemini CLI preview model", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        const wrapped = JSON.parse(result.init.body as string);
        expect(result.effectiveModel).toBe("gemini-3-flash-preview");
        expect(wrapped.model).toBe("gemini-3-flash-preview");
      });

      it("keeps non-Gemini-3 models unchanged regardless of headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-2.5-flash");
      });
    });
  });

  describe("transformAntigravityResponse", () => {
    it("injects [ThinkingResolution] details when debug_tui is enabled", async () => {
      initializeDebug({
        ...DEFAULT_CONFIG,
        debug: false,
        debug_tui: true,
      });

      const response = new Response(
        JSON.stringify({
          error: {
            code: 500,
            message: "Upstream error",
            status: "INTERNAL",
          },
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        false,
        undefined,
        "gemini-2.5-pro",
        "test-project",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
        "gemini-2.5-pro",
        "session-1",
        0,
        "summary",
        undefined,
        [
          "status=500 INTERNAL",
          "endpoint=https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
          "account=test@example.com",
        ],
      );

      const bodyText = await transformed.text();
      expect(bodyText).toContain("[ThinkingResolution]");
      expect(bodyText).toContain("status=500 INTERNAL");
      expect(bodyText).toContain("endpoint=https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
      expect(bodyText).toContain("account=test@example.com");

      initializeDebug(DEFAULT_CONFIG);
    });

    it("does not misclassify generic INVALID_ARGUMENT as thinking recovery from debug metadata", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        true,
        undefined,
        "antigravity-claude-opus-4-6-thinking",
        "test-project",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "claude-opus-4-6-thinking",
        "session-1",
        0,
        "expected=1 found=0",
      );

      await expect(transformed.text()).resolves.toContain("Request contains an invalid argument.");
    });

    it("rethrows THINKING_RECOVERY_NEEDED for outer retry handling", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Thinking must start with a thinking block before tool use.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      await expect(
        transformAntigravityResponse(
          response,
          true,
          undefined,
          "antigravity-claude-opus-4-6-thinking",
          "test-project",
          "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
          "claude-opus-4-6-thinking",
          "session-1",
        ),
      ).rejects.toMatchObject({ message: "THINKING_RECOVERY_NEEDED" });
    });
  });
});
