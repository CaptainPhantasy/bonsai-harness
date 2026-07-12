import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendConversationTurn,
  conversationLogPath,
  createConversationId,
  historyToOpenAiMessages,
  loadConversation,
} from "../src/conversation-log";

// conversation-log uses PROJECT_ROOT captured at module load, so we must
// build a temp project tree BEFORE importing the module indirectly. The
// import above already captured the real PROJECT_ROOT; we exercise the
// pure-logic helpers (createConversationId, historyToOpenAiMessages, ID
// validation) here and validate persistence against a temp tree by
// overriding the path inside conversationLogPath's call to resolveMemoryPath
// via a wrapper that points at our temp root.

describe("conversation log", () => {
  test("createConversationId is stable in shape and unique across calls", () => {
    const a = createConversationId();
    const b = createConversationId();
    expect(a).toMatch(/^conv_[0-9a-f]{32}_\d{8}$/);
    expect(b).toMatch(/^conv_[0-9a-f]{32}_\d{8}$/);
    expect(a).not.toBe(b);
  });

  test("conversationLogPath rejects malformed IDs that would escape the conversations tree", () => {
    expect(() => conversationLogPath("../../../etc/passwd")).toThrow(/conversationId/);
    expect(() => conversationLogPath("with spaces")).toThrow(/conversationId/);
    expect(() => conversationLogPath("dot.in.name")).toThrow(/conversationId/);
    expect(() => conversationLogPath("")).toThrow(/conversationId/);
    expect(() => conversationLogPath("../../escape")).toThrow(/conversationId/);
    // A well-formed ID resolves into the conversations subtree
    expect(conversationLogPath("conv_abc_20260710")).toMatch(/\.bonsai\/memory\/conversations\/conv_abc_20260710\.jsonl$/);
  });

  test("historyToOpenAiMessages keeps user/assistant and drops tool-only entries", () => {
    const history = [
      { role: "user", content: "hello", timestamp: "2026-07-10T00:00:00Z" },
      { role: "assistant", content: "hi", timestamp: "2026-07-10T00:00:01Z" },
      { role: "tool", content: "tool-result", tool_call_id: "x", timestamp: "2026-07-10T00:00:02Z" },
      { role: "assistant", content: "final", timestamp: "2026-07-10T00:00:03Z" },
    ] as const;
    const messages = historyToOpenAiMessages([...history]);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "assistant", content: "final" },
    ]);
  });
});

// Persistence behavior: stub the project root via a temp tree by writing the
// JSONL file directly through the same path computation and asserting load
// round-trips. We use the public conversationLogPath so the test exercises
// the real path-safety rules; the project root is the real one (captured at
// import), but we scope writes by always cleaning up after.
describe("conversation log persistence", () => {
  const id = "conv_persist_test_20260710";
  const path = conversationLogPath(id);

  beforeEach(() => {
    if (existsSync(path)) rmSync(path, { force: true });
  });

  afterEach(() => {
    if (existsSync(path)) rmSync(path, { force: true });
  });

  test("appendConversationTurn writes a JSONL line that loadConversation parses back", () => {
    expect(loadConversation(id)).toEqual([]);
    appendConversationTurn(id, { role: "user", content: "first turn" });
    appendConversationTurn(id, { role: "assistant", content: "ack" });
    const loaded = loadConversation(id);
    expect(loaded.length).toBe(2);
    expect(loaded[0]?.role).toBe("user");
    expect(loaded[0]?.content).toBe("first turn");
    expect(typeof loaded[0]?.timestamp).toBe("string");
    expect(loaded[1]?.role).toBe("assistant");
  });

  test("loadConversation skips malformed lines without throwing", () => {
    appendConversationTurn(id, { role: "user", content: "good" });
    // Manually append a garbage line to simulate a torn write
    writeFileSync(path, "{not json\n", { flag: "a" });
    appendConversationTurn(id, { role: "assistant", content: "still good" });
    const loaded = loadConversation(id);
    expect(loaded.length).toBe(2);
    expect(loaded[1]?.content).toBe("still good");
  });
});
