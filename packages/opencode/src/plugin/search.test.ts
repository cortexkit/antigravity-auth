import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { executeSearch } from "./search";

mock.module("./agy-transport", () => ({
  fetchWithAgyCliTransport: mock(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(
  text: string,
  opts: {
    searchQueries?: string[];
    chunks?: Array<{ title: string; uri: string }>;
    urlMetadata?: Array<{ retrieved_url: string; url_retrieval_status: string }>;
  } = {},
) {
  return {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: opts.searchQueries ?? [],
            groundingChunks: (opts.chunks ?? []).map((c) => ({ web: c })),
          },
          urlContextMetadata: { url_metadata: opts.urlMetadata ?? [] },
        },
      ],
    },
  };
}

function mockFetch(body: unknown, status = 200) {
  return mock().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

async function mockAgyTransport(body: unknown, status = 200) {
  const { fetchWithAgyCliTransport } = await import("./agy-transport");
  const spy = mockFetch(body, status);
  (fetchWithAgyCliTransport as any).mockImplementation(spy);
  return spy;
}

// ─── executeSearch ────────────────────────────────────────────────────────────

describe("executeSearch", () => {
  let fetchWithAgyCliTransport: any;

  beforeEach(async () => {
    ({ fetchWithAgyCliTransport } = await import("./agy-transport"));
    fetchWithAgyCliTransport.mockReset();
    mockAgyTransport(makeResponse("Default result"));
  });

  afterEach(() => {
    mock.restore();
  });

  it("returns formatted text from the response", async () => {
    await mockAgyTransport(makeResponse("The answer is 42."));
    const result = await executeSearch({ query: "what is 42?" }, "tok", "proj");
    expect(result).toContain("The answer is 42.");
    expect(result).toContain("## Search Results");
  });

  it("lists sources from groundingChunks (uses groundingMeta internally)", async () => {
    await mockAgyTransport(
      makeResponse("answer", {
        chunks: [{ title: "Example", uri: "https://example.com/page" }],
      }),
    );
    const result = await executeSearch({ query: "q" }, "tok", "proj");
    expect(result).toContain("### Sources");
    expect(result).toContain("Example");
    expect(result).toContain("https://example.com/page");
  });

  it("includes search queries section when queries are present", async () => {
    await mockAgyTransport(makeResponse("res", { searchQueries: ["my query"] }));
    const result = await executeSearch({ query: "my query" }, "tok", "proj");
    expect(result).toContain("### Search Queries Used");
    expect(result).toContain('"my query"');
  });

  it("marks successful URL retrieval with ✓", async () => {
    await mockAgyTransport(
      makeResponse("ok", {
        urlMetadata: [
          { retrieved_url: "https://docs.example.com", url_retrieval_status: "URL_RETRIEVAL_STATUS_SUCCESS" },
        ],
      }),
    );
    const result = await executeSearch({ query: "q", urls: ["https://docs.example.com"] }, "tok", "proj");
    expect(result).toContain("✓");
    expect(result).toContain("https://docs.example.com");
  });

  it("marks failed URL retrieval with ✗", async () => {
    await mockAgyTransport(
      makeResponse("ok", {
        urlMetadata: [
          { retrieved_url: "https://broken.example.com", url_retrieval_status: "URL_RETRIEVAL_STATUS_ERROR" },
        ],
      }),
    );
    const result = await executeSearch({ query: "q", urls: ["https://broken.example.com"] }, "tok", "proj");
    expect(result).toContain("✗");
  });

  it("returns error block on non-OK HTTP response", async () => {
    await mockAgyTransport({ error: "bad" }, 400);
    const result = await executeSearch({ query: "q" }, "tok", "proj");
    expect(result).toContain("## Search Error");
    expect(result).toContain("400");
  });

  it("returns error block when fetch throws", async () => {
    fetchWithAgyCliTransport.mockRejectedValue(new Error("Network down"));
    const result = await executeSearch({ query: "q" }, "tok", "proj");
    expect(result).toContain("## Search Error");
    expect(result).toContain("Network down");
  });

  it("uses captured agy CLI content headers and envelope ordering", async () => {
    const spy = await mockAgyTransport(makeResponse("ok"));
    await executeSearch({ query: "q" }, "bearer-token-xyz", "proj");
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string);

    expect(headers["Authorization"]).toBe("Bearer bearer-token-xyz");
    expect(headers["User-Agent"]).toMatch(
      /^antigravity\/cli\/1\.1\.5 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/,
    );
    expect(headers["X-Goog-Api-Client"]).toBeUndefined();
    expect(headers["Client-Metadata"]).toBeUndefined();
    expect(Object.keys(body)).toEqual(["project", "requestId", "request", "model", "userAgent", "requestType"]);
    expect(body.requestId).toMatch(/^agent\/.+\/2$/);
    expect(body.userAgent).toBe("antigravity");
    expect(body.requestType).toBe("agent");
  });
});
