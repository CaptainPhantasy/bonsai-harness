import { describe, expect, test } from "bun:test";

import {
  accumulateDelta,
  createStreamAssembly,
  finalizeAssembly,
  parseSseLine,
  type StreamDelta,
} from "../src/streaming-openai";

describe("streaming-openai SSE parser", () => {
  test("parseSseLine ignores comments, blanks, and non-data lines", () => {
    expect(parseSseLine("")).toEqual({ kind: "ignore" });
    expect(parseSseLine("   ")).toEqual({ kind: "ignore" });
    expect(parseSseLine(": this is a heartbeat comment")).toEqual({ kind: "ignore" });
    expect(parseSseLine("event: tool_calls")).toEqual({ kind: "ignore" });
    expect(parseSseLine("id: 42")).toEqual({ kind: "ignore" });
  });

  test("parseSseLine recognizes [DONE] sentinel", () => {
    expect(parseSseLine("data: [DONE]")).toEqual({ kind: "data", delta: null, done: true });
  });

  test("parseSseLine tolerates malformed JSON without throwing", () => {
    const result = parseSseLine("data: {not valid json");
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.delta).toBeNull();
      expect(result.done).toBe(false);
    }
  });

  test("parseSseLine extracts content delta", () => {
    const result = parseSseLine('data: {"choices":[{"delta":{"content":"Hello"}}]}');
    expect(result.kind).toBe("data");
    if (result.kind === "data" && result.delta) {
      expect(result.delta.content).toBe("Hello");
      expect(result.delta.reasoning).toBeUndefined();
    }
  });

  test("parseSseLine extracts reasoning_content (GLM/DeepSeek) and reasoning (Anthropic-proxy) keys", () => {
    const glm = parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}');
    const anthropicProxy = parseSseLine('data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}');
    expect(glm.kind).toBe("data");
    expect(anthropicProxy.kind).toBe("data");
    if (glm.kind === "data" && glm.delta) expect(glm.delta.reasoning).toBe("thinking...");
    if (anthropicProxy.kind === "data" && anthropicProxy.delta) expect(anthropicProxy.delta.reasoning).toBe("thinking...");
  });

  test("parseSseLine never collapses reasoning into content", () => {
    const both = parseSseLine('data: {"choices":[{"delta":{"content":"visible","reasoning_content":"hidden"}}]}');
    if (both.kind === "data" && both.delta) {
      expect(both.delta.content).toBe("visible");
      expect(both.delta.reasoning).toBe("hidden");
    } else {
      throw new Error("Expected data with delta");
    }
  });

  test("parseSseLine extracts tool_call deltas with id/name/arguments fragments", () => {
    const first = parseSseLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_42","function":{"name":"search"}}]}}]}');
    if (first.kind === "data" && first.delta?.toolCall) {
      expect(first.delta.toolCall.index).toBe(0);
      expect(first.delta.toolCall.id).toBe("call_42");
      expect(first.delta.toolCall.name).toBe("search");
    } else {
      throw new Error("Expected tool_call delta");
    }
  });

  test("parseSseLine extracts finish_reason", () => {
    const stop = parseSseLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
    if (stop.kind === "data" && stop.delta) {
      expect(stop.delta.finishReason).toBe("stop");
    }
  });
});

describe("streaming-openai accumulator", () => {
  test("accumulateDelta folds content and reasoning into separate channels", () => {
    const assembly = createStreamAssembly();
    accumulateDelta(assembly, { content: "Hello, " });
    accumulateDelta(assembly, { reasoning: "I should greet politely. " });
    accumulateDelta(assembly, { content: "world!" });
    accumulateDelta(assembly, { reasoning: "Now stop." });
    expect(assembly.content).toBe("Hello, world!");
    expect(assembly.reasoning).toBe("I should greet politely. Now stop.");
  });

  test("accumulateDelta assembles tool_calls across multiple deltas of the same index", () => {
    const assembly = createStreamAssembly();
    const deltas: StreamDelta[] = [
      { toolCall: { index: 0, id: "call_1", name: "search" } },
      { toolCall: { index: 0, argumentsFragment: '{"q":"hel' } },
      { toolCall: { index: 0, argumentsFragment: 'lo"}' } },
      { toolCall: { index: 1, id: "call_2", name: "write" } },
      { toolCall: { index: 1, argumentsFragment: '{"path":"/tmp"}' } },
    ];
    for (const d of deltas) accumulateDelta(assembly, d);
    const result = finalizeAssembly(assembly);
    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]).toEqual({ id: "call_1", name: "search", arguments: '{"q":"hello"}' });
    expect(result.toolCalls[1]).toEqual({ id: "call_2", name: "write", arguments: '{"path":"/tmp"}' });
  });

  test("finalizeAssembly preserves finish_reason and returns immutable snapshot", () => {
    const assembly = createStreamAssembly();
    accumulateDelta(assembly, { content: "x" });
    accumulateDelta(assembly, { finishReason: "tool_calls" });
    const result = finalizeAssembly(assembly);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.content).toBe("x");
    expect(result.toolCalls).toEqual([]);
  });

  test("accumulateDelta is a no-op for empty deltas", () => {
    const assembly = createStreamAssembly();
    accumulateDelta(assembly, {});
    expect(assembly.content).toBe("");
    expect(assembly.reasoning).toBe("");
    expect(assembly.toolCalls.size).toBe(0);
  });
});
