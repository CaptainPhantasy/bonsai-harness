import { describe, expect, test } from "bun:test";

import { classifyTool, decideToolCall } from "../src/safety-modes";

describe("MCP safety modes", () => {
  test("classifies only explicit read patterns as read-only", () => {
    expect(classifyTool("read_file")).toEqual({ readOnly: true, destructive: false });
    expect(classifyTool("delete_file")).toEqual({ readOnly: false, destructive: true });
    expect(classifyTool("run_command")).toEqual({ readOnly: false, destructive: false });
  });

  test("enforces plan, ask, auto, and yolo policies", () => {
    expect(decideToolCall("plan", "read_file").effect).toBe("allow");
    expect(decideToolCall("plan", "write_file").effect).toBe("block");
    expect(decideToolCall("ask", "read_file").effect).toBe("ask");
    expect(decideToolCall("auto", "read_file").effect).toBe("allow");
    expect(decideToolCall("auto", "write_file").effect).toBe("ask");
    expect(decideToolCall("yolo", "delete_file").effect).toBe("allow");
  });
});
