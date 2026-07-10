import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { McpConnectionManager } from "../src/mcp-client";
import type { McpServerEntry } from "../src/mcp-registry";

const fixturePath = fileURLToPath(new URL("./fixtures/mcp-stdio-fixture.ts", import.meta.url));
const fixtureServer: McpServerEntry = {
  name: "fixture",
  displayName: "Fixture",
  description: "Deterministic MCP fixture",
  command: process.execPath,
  args: [fixturePath],
  env: {},
  transport: "stdio",
  version: "1.0.0",
  toolCount: 2,
  source: "local-storage",
};

describe("MCP stdio client", () => {
  test("initializes, paginates tools, exposes provider schemas, and invokes a tool", async () => {
    const manager = new McpConnectionManager([fixtureServer]);
    try {
      const server = await manager.connect("fixture");
      expect(server.tools.map((tool) => tool.name)).toEqual(["read_note", "write_note"]);
      expect(manager.count).toBe(1);

      const tools = manager.providerTools();
      expect(tools.map((tool) => tool.name)).toEqual(["fixture__read_note", "fixture__write_note"]);
      expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: {} });

      const result = await manager.callProviderTool("fixture__read_note", {});
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: "called read_note" }]);
      expect(manager.getProviderToolMetadata("fixture__write_note")).toEqual({ server: "fixture", tool: "write_note" });
    } finally {
      manager.disconnectAll();
    }
  });

  test("rejects unknown servers and unavailable entries before spawning a process", async () => {
    const unavailable: McpServerEntry = { ...fixtureServer, name: "missing", args: ["/tmp/does-not-exist-mcp-entry.ts"] };
    const manager = new McpConnectionManager([unavailable]);

    await expect(manager.connect("unknown")).rejects.toThrow("Unknown MCP server");
    await expect(manager.connect("missing")).rejects.toThrow("not installed");
  });
});
