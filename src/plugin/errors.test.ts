import { describe, expect, it } from "vitest";
import { EmptyResponseError, ToolIdMismatchError } from "./errors";

// ─── EmptyResponseError ───────────────────────────────────────────────────────

describe("EmptyResponseError", () => {
  it("is an instance of Error", () => {
    const err = new EmptyResponseError("gemini", "gemini-2.5-flash", 3);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name EmptyResponseError", () => {
    const err = new EmptyResponseError("gemini", "gemini-2.5-flash", 3);
    expect(err.name).toBe("EmptyResponseError");
  });

  it("stores provider, model, and attempts on the instance", () => {
    const err = new EmptyResponseError("anthropic", "claude-3-5-sonnet", 5);
    expect(err.provider).toBe("anthropic");
    expect(err.model).toBe("claude-3-5-sonnet");
    expect(err.attempts).toBe(5);
  });

  it("generates a default message that mentions the attempt count", () => {
    const err = new EmptyResponseError("gemini", "model-x", 2);
    expect(err.message).toContain("2");
    expect(err.message).toContain("attempts");
  });

  it("uses a custom message when provided", () => {
    const err = new EmptyResponseError("gemini", "model-x", 1, "custom error msg");
    expect(err.message).toBe("custom error msg");
  });

  it("works with attempts = 1 (singular language check)", () => {
    const err = new EmptyResponseError("p", "m", 1);
    expect(err.message).toContain("1");
  });

  it("can be thrown and caught as an Error", () => {
    expect(() => {
      throw new EmptyResponseError("gemini", "model", 1);
    }).toThrow(EmptyResponseError);
  });

  it("is also catchable as a generic Error", () => {
    expect(() => {
      throw new EmptyResponseError("gemini", "model", 1);
    }).toThrow(Error);
  });
});

// ─── ToolIdMismatchError ──────────────────────────────────────────────────────

describe("ToolIdMismatchError", () => {
  it("is an instance of Error", () => {
    const err = new ToolIdMismatchError(["tool_1"], ["tool_2"]);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name ToolIdMismatchError", () => {
    const err = new ToolIdMismatchError(["a"], ["b"]);
    expect(err.name).toBe("ToolIdMismatchError");
  });

  it("stores expectedIds and foundIds on the instance", () => {
    const expected = ["tool_a", "tool_b"];
    const found = ["tool_c"];
    const err = new ToolIdMismatchError(expected, found);
    expect(err.expectedIds).toEqual(expected);
    expect(err.foundIds).toEqual(found);
  });

  it("generates a default message mentioning both id lists", () => {
    const err = new ToolIdMismatchError(["x", "y"], ["z"]);
    expect(err.message).toContain("x");
    expect(err.message).toContain("y");
    expect(err.message).toContain("z");
  });

  it("uses a custom message when provided", () => {
    const err = new ToolIdMismatchError(["a"], ["b"], "my custom message");
    expect(err.message).toBe("my custom message");
  });

  it("handles empty arrays without throwing", () => {
    const err = new ToolIdMismatchError([], []);
    expect(err.expectedIds).toEqual([]);
    expect(err.foundIds).toEqual([]);
  });

  it("can be thrown and caught as an Error", () => {
    expect(() => {
      throw new ToolIdMismatchError(["a"], ["b"]);
    }).toThrow(ToolIdMismatchError);
  });

  it("preserves array references exactly", () => {
    const expected = ["id-1"];
    const found = ["id-2"];
    const err = new ToolIdMismatchError(expected, found);
    expect(err.expectedIds).toBe(expected);
    expect(err.foundIds).toBe(found);
  });
});
