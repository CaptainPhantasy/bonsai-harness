/**
 * OpenAI-Compatible SSE Stream Parser
 * ===================================
 *
 * Parses the `text/event-stream` wire format emitted by OpenAI-compatible
 * endpoints (Z.AI Coding Plan, MiniMax international) when `stream: true`
 * is set on the chat-completions request.
 *
 * The parser is split into pure, testable pieces:
 *   - `parseSseLine`     — decode one SSE line into a data payload or null
 *   - `accumulateDelta`  — fold one delta into a StreamAssembly accumulator
 *   - `StreamAssembly`   — mutable accumulator with finalized shape
 *
 * The streaming HTTP machinery (`streamOpenAiCompatibleCompletion`) lives
 * here too, but the pure helpers above are what the tests pin down. The
 * HTTP function accepts callbacks so the caller can route deltas to
 * WebSocket clients without this module knowing about the harness.
 *
 * Two-channel model (per the user's W3 weakness):
 *   - `content`           — the visible assistant reply
 *   - `reasoning_content` — the model's private thinking stream
 *                           (GLM-5.2, DeepSeek-R1, etc. emit this)
 *
 * Both channels are accumulated separately. The caller decides whether to
 * surface reasoning to the UI; the parser does not collapse them.
 */

export type StreamDelta = {
  content?: string;
  reasoning?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsFragment?: string;
  };
  finishReason?: string;
};

export type StreamedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type StreamAssembly = {
  content: string;
  reasoning: string;
  toolCalls: Map<number, StreamedToolCall>;
  finishReason: string;
};

export type StreamCompletion = {
  content: string;
  reasoning: string;
  toolCalls: StreamedToolCall[];
  finishReason: string;
};

export function createStreamAssembly(): StreamAssembly {
  return {
    content: "",
    reasoning: "",
    toolCalls: new Map(),
    finishReason: "",
  };
}

/**
 * Parse one SSE line. Returns:
 *   - {kind: "data", payload: StreamDelta | null, done: boolean}
 *   - {kind: "ignore"} for comments, event/type/ping lines, blanks
 *
 * The payload is null when the line is `data: [DONE]` (done: true) or
 * when JSON parsing fails — malformed chunks must not break the stream.
 */
export type SseLineParseResult =
  | { kind: "ignore" }
  | { kind: "data"; delta: StreamDelta | null; done: boolean };

export function parseSseLine(line: string): SseLineParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  if (trimmed.startsWith(":")) return { kind: "ignore" }; // SSE comment
  if (!trimmed.startsWith("data:")) return { kind: "ignore" }; // event/id/retry

  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return { kind: "data", delta: null, done: true };

  try {
    const parsed = JSON.parse(data) as unknown;
    return { kind: "data", delta: decodeChoiceDelta(parsed), done: false };
  } catch {
    // Malformed JSON: ignore the line but keep streaming.
    return { kind: "data", delta: null, done: false };
  }
}

/**
 * Pull the relevant delta fields out of a parsed chunk. Tolerates missing
 * `choices`, missing `delta`, and unknown `delta` shapes — every field of
 * the returned StreamDelta is optional.
 *
 * Vendor note: GLM-5.2 / DeepSeek-R1 put the thinking stream under
 * `delta.reasoning_content`. Anthropic-via-OpenAI proxies sometimes put
 * it under `delta.reasoning`. We accept both; we never collapse into
 * `content`.
 */
function decodeChoiceDelta(parsed: unknown): StreamDelta {
  if (!parsed || typeof parsed !== "object") return {};
  const root = parsed as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return {};
  const delta = first.delta as Record<string, unknown> | undefined;
  const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  const out: StreamDelta = {};
  if (delta && typeof delta.content === "string" && delta.content.length > 0) {
    out.content = delta.content;
  }
  const reasoningRaw = delta && (delta.reasoning_content ?? delta.reasoning);
  if (typeof reasoningRaw === "string" && reasoningRaw.length > 0) {
    out.reasoning = reasoningRaw;
  }
  if (delta && Array.isArray(delta.tool_calls)) {
    const firstCall = delta.tool_calls[0] as Record<string, unknown> | undefined;
    if (firstCall && typeof firstCall === "object") {
      const toolCall: NonNullable<StreamDelta["toolCall"]> = {
        index: typeof firstCall.index === "number" ? firstCall.index : 0,
      };
      if (typeof firstCall.id === "string") toolCall.id = firstCall.id;
      const fn = firstCall.function as Record<string, unknown> | undefined;
      if (fn && typeof fn.name === "string") toolCall.name = fn.name;
      if (fn && typeof fn.arguments === "string") toolCall.argumentsFragment = fn.arguments;
      out.toolCall = toolCall;
    }
  }
  if (finishReason) out.finishReason = finishReason;
  return out;
}

/**
 * Fold one decoded delta into the assembly. Mutates `assembly` and returns
 * it for chaining. Idempotent for empty deltas.
 */
export function accumulateDelta(assembly: StreamAssembly, delta: StreamDelta): StreamAssembly {
  if (delta.content) assembly.content += delta.content;
  if (delta.reasoning) assembly.reasoning += delta.reasoning;
  if (delta.finishReason) assembly.finishReason = delta.finishReason;
  if (delta.toolCall) {
    const existing = assembly.toolCalls.get(delta.toolCall.index) ?? { id: "", name: "", arguments: "" };
    if (delta.toolCall.id) existing.id = delta.toolCall.id;
    if (delta.toolCall.name) existing.name = delta.toolCall.name;
    if (delta.toolCall.argumentsFragment) existing.arguments += delta.toolCall.argumentsFragment;
    assembly.toolCalls.set(delta.toolCall.index, existing);
  }
  return assembly;
}

/**
 * Snapshot the assembly into an immutable completion shape. The Map is
 * converted to a sorted array (sorted by original stream index, which is
 * the order the model emitted them).
 */
export function finalizeAssembly(assembly: StreamAssembly): StreamCompletion {
  const toolCalls = [...assembly.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value);
  return {
    content: assembly.content,
    reasoning: assembly.reasoning,
    toolCalls,
    finishReason: assembly.finishReason,
  };
}

/**
 * Drive a streaming OpenAI-compatible completion. Sets `stream: true` on
 * the body, consumes the SSE response, and invokes `onDelta` for each
 * content/reasoning fragment. Returns the finalized completion.
 *
 * The caller owns HTTP error handling: this function throws on non-2xx
 * and on network errors, and the caller (the agent loop) decides whether
 * to fail over to a backup runtime.
 */
export async function streamOpenAiCompatibleCompletion(args: {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
}): Promise<StreamCompletion> {
  const streamingBody = { ...args.body, stream: true };
  const response = await fetch(args.url, {
    method: "POST",
    headers: args.headers,
    body: JSON.stringify(streamingBody),
    signal: args.signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new OpenAiStreamHttpError(response.status, text);
  }
  if (!response.body) {
    throw new Error("Streaming response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const assembly = createStreamAssembly();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (parsed.kind !== "data") continue;
        if (parsed.done) continue;
        if (!parsed.delta) continue;
        accumulateDelta(assembly, parsed.delta);
        args.onDelta?.(parsed.delta);
      }
    }
    // Flush any trailing line in the buffer (some servers don't terminate with \n)
    if (buffer.length > 0) {
      const parsed = parseSseLine(buffer);
      if (parsed.kind === "data" && !parsed.done && parsed.delta) {
        accumulateDelta(assembly, parsed.delta);
        args.onDelta?.(parsed.delta);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return finalizeAssembly(assembly);
}

/**
 * Typed HTTP error so the agent loop can distinguish "non-2xx from the
 * runtime" (which may trigger failover) from "transport error" (which may
 * not). Mirrors the prior non-streaming code's error contract.
 */
export class OpenAiStreamHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`OpenAI-compatible stream returned HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "OpenAiStreamHttpError";
    this.status = status;
    this.body = body;
  }
}
