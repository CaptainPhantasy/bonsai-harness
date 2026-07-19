import { describe, expect, test } from "bun:test";

import { extractVerdict, stripVerdictLine } from "../src/verdict";

describe("verdict parser", () => {
  test("extracts a clean verdict from the last line", () => {
    const content = 'Here is the diff.\n\n{"passed": true, "reason": "server-core.ts:175 PROJECT_ROOT", "nextAction": "stop"}';
    const verdict = extractVerdict(content);
    expect(verdict).toEqual({
      passed: true,
      reason: "server-core.ts:175 PROJECT_ROOT",
      nextAction: "stop",
    });
  });

  test("extracts a verdict wrapped in ```json fences", () => {
    const content = 'Done.\n```json\n{"passed": false, "reason": "typecheck fails", "nextAction": "retry"}\n```';
    const verdict = extractVerdict(content);
    expect(verdict?.passed).toBe(false);
    expect(verdict?.nextAction).toBe("retry");
  });

  test("extracts a retry verdict", () => {
    const content = 'Need another pass.\n{"passed": false, "reason": "missing test", "nextAction": "retry"}';
    expect(extractVerdict(content)?.nextAction).toBe("retry");
  });

  test("extracts an escalate verdict", () => {
    const content = 'Cannot proceed.\n{"passed": false, "reason": "ambiguous spec", "nextAction": "escalate"}';
    expect(extractVerdict(content)?.nextAction).toBe("escalate");
  });

  test("returns null when content is empty", () => {
    expect(extractVerdict("")).toBeNull();
    expect(extractVerdict("   ")).toBeNull();
  });

  test("returns null when no JSON object on the last line", () => {
    expect(extractVerdict("Just a normal reply.")).toBeNull();
    expect(extractVerdict("Multi\nline\nreply with no JSON.")).toBeNull();
  });

  test("returns null when JSON is malformed", () => {
    const content = 'Reply.\n{"passed": true, "reason":';
    expect(extractVerdict(content)).toBeNull();
  });

  test("returns null when JSON lacks required fields", () => {
    expect(extractVerdict('Reply.\n{"passed": true}')).toBeNull();
    expect(extractVerdict('Reply.\n{"passed": true, "reason": "x"}')).toBeNull();
    expect(extractVerdict('Reply.\n{"reason": "x", "nextAction": "stop"}')).toBeNull();
  });

  test("coerces unknown nextAction to stop without failing the parse", () => {
    const content = 'Reply.\n{"passed": true, "reason": "ok", "nextAction": "shutdown-everything"}';
    const verdict = extractVerdict(content);
    expect(verdict?.passed).toBe(true);
    expect(verdict?.nextAction).toBe("stop");
  });

  test("requires passed to be a boolean", () => {
    expect(extractVerdict('Reply.\n{"passed": "yes", "reason": "x", "nextAction": "stop"}')).toBeNull();
  });

  test("ignores a JSON object in the middle of the response", () => {
    // Only the last non-empty line counts
    const content = '{"passed": true, "reason": "middle", "nextAction": "stop"}\nFollow-up paragraph.\nNo JSON here.';
    expect(extractVerdict(content)).toBeNull();
  });
});

describe("stripVerdictLine", () => {
  test("removes a trailing verdict line and trailing whitespace", () => {
    const content = 'Here is the work.\n\n{"passed": true, "reason": "ok", "nextAction": "stop"}\n';
    expect(stripVerdictLine(content)).toBe("Here is the work.");
  });

  test("removes a fenced verdict block", () => {
    const content = 'Work done.\n```json\n{"passed": true, "reason": "ok", "nextAction": "stop"}\n```';
    expect(stripVerdictLine(content)).toBe("Work done.");
  });

  test("leaves content unchanged when no verdict is present", () => {
    expect(stripVerdictLine("Just a reply.")).toBe("Just a reply.");
    expect(stripVerdictLine("Multi\nline\nreply.")).toBe("Multi\nline\nreply.");
  });

  test("handles empty content", () => {
    expect(stripVerdictLine("")).toBe("");
  });
});
