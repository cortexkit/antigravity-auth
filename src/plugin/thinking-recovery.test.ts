import { describe, expect, it } from "vitest";
import {
  analyzeConversationState,
  closeToolLoopForThinking,
  hasPossibleCompactedThinking,
  looksLikeCompactedThinkingTurn,
  needsThinkingRecovery,
} from "./thinking-recovery";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function userMsg(text: string) {
  return { role: "user", parts: [{ text }] };
}

function modelMsg(text: string) {
  return { role: "model", parts: [{ text }] };
}

function modelWithThinking(text: string) {
  return {
    role: "model",
    parts: [{ thought: true, text: "thinking..." }, { text }],
  };
}

function modelWithToolCall(name = "myTool") {
  return {
    role: "model",
    parts: [{ functionCall: { name, args: {} } }],
  };
}

function modelWithThinkingAndToolCall(name = "myTool") {
  return {
    role: "model",
    parts: [
      { thought: true, text: "reasoning..." },
      { functionCall: { name, args: {} } },
    ],
  };
}

function toolResultMsg(name = "myTool") {
  return {
    role: "user",
    parts: [{ functionResponse: { name, response: { result: "ok" } } }],
  };
}

// ─── analyzeConversationState ─────────────────────────────────────────────────

describe("analyzeConversationState", () => {
  it("returns default state for empty contents", () => {
    const state = analyzeConversationState([]);
    expect(state.inToolLoop).toBe(false);
    expect(state.turnStartIdx).toBe(-1);
    expect(state.lastModelIdx).toBe(-1);
  });

  it("returns default state for non-array input", () => {
    const state = analyzeConversationState(null as any);
    expect(state.inToolLoop).toBe(false);
  });

  it("detects a simple user→model conversation (not in tool loop)", () => {
    const contents = [userMsg("hello"), modelMsg("hi there")];
    const state = analyzeConversationState(contents);
    expect(state.inToolLoop).toBe(false);
    expect(state.lastModelIdx).toBe(1);
    expect(state.lastModelHasThinking).toBe(false);
    expect(state.lastModelHasToolCalls).toBe(false);
  });

  it("detects thinking in last model message", () => {
    const contents = [userMsg("hello"), modelWithThinking("hi there")];
    const state = analyzeConversationState(contents);
    expect(state.lastModelHasThinking).toBe(true);
    expect(state.turnHasThinking).toBe(true);
  });

  it("detects tool loop: conversation ends with tool result", () => {
    const contents = [
      userMsg("do something"),
      modelWithToolCall("search"),
      toolResultMsg("search"),
    ];
    const state = analyzeConversationState(contents);
    expect(state.inToolLoop).toBe(true);
    expect(state.lastModelIdx).toBe(1);
    expect(state.lastModelHasToolCalls).toBe(true);
  });

  it("detects tool loop with multiple tool results", () => {
    const contents = [
      userMsg("do two things"),
      { role: "model", parts: [
        { functionCall: { name: "a", args: {} } },
        { functionCall: { name: "b", args: {} } },
      ]},
      { role: "user", parts: [
        { functionResponse: { name: "a", response: {} } },
        { functionResponse: { name: "b", response: {} } },
      ]},
    ];
    const state = analyzeConversationState(contents);
    expect(state.inToolLoop).toBe(true);
  });

  it("is NOT in tool loop when last message is a real user message", () => {
    const contents = [
      userMsg("task"),
      modelWithToolCall(),
      toolResultMsg(),
      modelMsg("done"),
      userMsg("thanks"),
    ];
    const state = analyzeConversationState(contents);
    expect(state.inToolLoop).toBe(false);
  });

  it("tracks turn start correctly across multi-step tool loop", () => {
    const contents = [
      userMsg("first real user"),
      modelWithThinkingAndToolCall("step1"),
      toolResultMsg("step1"),
      modelWithToolCall("step2"),
      toolResultMsg("step2"),
    ];
    const state = analyzeConversationState(contents);
    expect(state.turnStartIdx).toBe(1); // first model message in turn
    expect(state.turnHasThinking).toBe(true);
    expect(state.inToolLoop).toBe(true);
  });

  it("turns NOT having thinking when first model msg has no thinking", () => {
    const contents = [
      userMsg("go"),
      modelWithToolCall("t1"),
      toolResultMsg("t1"),
    ];
    const state = analyzeConversationState(contents);
    expect(state.turnHasThinking).toBe(false);
    expect(state.inToolLoop).toBe(true);
  });
});

// ─── needsThinkingRecovery ────────────────────────────────────────────────────

describe("needsThinkingRecovery", () => {
  it("returns false when not in tool loop", () => {
    expect(needsThinkingRecovery({ inToolLoop: false, turnHasThinking: false,
      turnStartIdx: -1, lastModelIdx: -1, lastModelHasThinking: false,
      lastModelHasToolCalls: false })).toBe(false);
  });

  it("returns false when in tool loop but turn had thinking", () => {
    expect(needsThinkingRecovery({ inToolLoop: true, turnHasThinking: true,
      turnStartIdx: 1, lastModelIdx: 2, lastModelHasThinking: false,
      lastModelHasToolCalls: true })).toBe(false);
  });

  it("returns true when in tool loop without thinking", () => {
    expect(needsThinkingRecovery({ inToolLoop: true, turnHasThinking: false,
      turnStartIdx: 1, lastModelIdx: 2, lastModelHasThinking: false,
      lastModelHasToolCalls: true })).toBe(true);
  });
});

// ─── closeToolLoopForThinking ─────────────────────────────────────────────────

describe("closeToolLoopForThinking", () => {
  it("appends synthetic model + user messages", () => {
    const contents = [
      userMsg("go"),
      modelWithToolCall("search"),
      toolResultMsg("search"),
    ];
    const result = closeToolLoopForThinking(contents);
    expect(result.length).toBe(5);
    expect(result[3]?.role).toBe("model");
    expect(result[4]?.role).toBe("user");
    expect(result[4]?.parts[0]?.text).toBe("[Continue]");
  });

  it("strips thinking blocks from prior messages", () => {
    const contents = [
      userMsg("hello"),
      modelWithThinking("response"),
      toolResultMsg(),
    ];
    const result = closeToolLoopForThinking(contents);
    const modelMessages = result.filter((m) => m.role === "model");
    for (const msg of modelMessages) {
      const parts: any[] = msg.parts ?? [];
      const hasThinking = parts.some((p: any) => p?.thought === true);
      expect(hasThinking).toBe(false);
    }
  });

  it("uses singular message for single tool result", () => {
    const contents = [userMsg("go"), modelWithToolCall(), toolResultMsg()];
    const result = closeToolLoopForThinking(contents);
    const syntheticModel = result[result.length - 2];
    expect(syntheticModel?.parts[0]?.text).toBe("[Tool execution completed.]");
  });

  it("uses plural message for multiple tool results", () => {
    const contents = [
      userMsg("go"),
      { role: "model", parts: [
        { functionCall: { name: "a", args: {} } },
        { functionCall: { name: "b", args: {} } },
      ]},
      { role: "user", parts: [
        { functionResponse: { name: "a", response: {} } },
        { functionResponse: { name: "b", response: {} } },
      ]},
    ];
    const result = closeToolLoopForThinking(contents);
    const syntheticModel = result[result.length - 2];
    expect(syntheticModel?.parts[0]?.text).toBe("[2 tool executions completed.]");
  });

  it("uses fallback message when no tool results present", () => {
    const contents = [userMsg("go"), modelMsg("working...")];
    const result = closeToolLoopForThinking(contents);
    const syntheticModel = result[result.length - 2];
    expect(syntheticModel?.parts[0]?.text).toBe("[Processing previous context.]");
  });

  it("does not mutate original contents array", () => {
    const contents = [userMsg("go"), modelWithToolCall(), toolResultMsg()];
    const original = JSON.stringify(contents);
    closeToolLoopForThinking(contents);
    expect(JSON.stringify(contents)).toBe(original);
  });
});

// ─── looksLikeCompactedThinkingTurn ──────────────────────────────────────────

describe("looksLikeCompactedThinkingTurn", () => {
  it("returns false for null / undefined", () => {
    expect(looksLikeCompactedThinkingTurn(null)).toBe(false);
    expect(looksLikeCompactedThinkingTurn(undefined)).toBe(false);
  });

  it("returns false for message with no parts", () => {
    expect(looksLikeCompactedThinkingTurn({ role: "model", parts: [] })).toBe(false);
  });

  it("returns false for message without function calls", () => {
    expect(looksLikeCompactedThinkingTurn(modelMsg("just text"))).toBe(false);
  });

  it("returns false when message has thinking blocks alongside function call", () => {
    const msg = {
      role: "model",
      parts: [
        { thought: true, text: "thinking" },
        { functionCall: { name: "t", args: {} } },
      ],
    };
    expect(looksLikeCompactedThinkingTurn(msg)).toBe(false);
  });

  it("returns false when text appears before function call (non-compacted)", () => {
    const msg = {
      role: "model",
      parts: [
        { text: "I will now call the tool." },
        { functionCall: { name: "t", args: {} } },
      ],
    };
    expect(looksLikeCompactedThinkingTurn(msg)).toBe(false);
  });

  it("returns true for bare function call with no preceding text (looks compacted)", () => {
    const msg = modelWithToolCall("search");
    expect(looksLikeCompactedThinkingTurn(msg)).toBe(true);
  });
});

// ─── hasPossibleCompactedThinking ────────────────────────────────────────────

describe("hasPossibleCompactedThinking", () => {
  it("returns false for empty contents", () => {
    expect(hasPossibleCompactedThinking([], 0)).toBe(false);
  });

  it("returns false for invalid turnStartIdx", () => {
    expect(hasPossibleCompactedThinking([modelMsg("hi")], -1)).toBe(false);
  });

  it("returns false when no model messages look compacted", () => {
    const contents = [userMsg("go"), modelWithThinkingAndToolCall(), toolResultMsg()];
    expect(hasPossibleCompactedThinking(contents, 1)).toBe(false);
  });

  it("returns true when a model message in turn looks compacted", () => {
    const contents = [
      userMsg("go"),
      modelWithToolCall("search"),
      toolResultMsg("search"),
    ];
    expect(hasPossibleCompactedThinking(contents, 1)).toBe(true);
  });

  it("ignores model messages before turnStartIdx", () => {
    const contents = [
      userMsg("first turn"),
      modelWithToolCall("old"),
      toolResultMsg("old"),
      userMsg("second turn"),
      modelWithThinkingAndToolCall("new"),
      toolResultMsg("new"),
    ];
    // turnStart is 4 (second model message)
    expect(hasPossibleCompactedThinking(contents, 4)).toBe(false);
  });
});
