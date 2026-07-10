import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProviderToolDefinition } from "./server-core";
import {
  MCP_REGISTRY,
  getMcpServerUnavailableReason,
  type McpServerEntry,
} from "./mcp-registry";

const INITIALIZATION_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_STDIO_LINE_BYTES = 1_048_576;
const MAX_TOOL_PAGES = 100;

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolResult = {
  content: unknown;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

export type ConnectedMcpServer = {
  name: string;
  displayName: string;
  tools: McpTool[];
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export class McpStdioClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk.toString("utf-8")));
    child.on("error", (error) => this.failAll(new Error(`MCP process error: ${error.message}`)));
    child.on("close", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`MCP process closed (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  static async connect(entry: McpServerEntry): Promise<McpStdioClient> {
    const unavailableReason = getMcpServerUnavailableReason(entry);
    if (unavailableReason) throw new Error(`${entry.name}: ${unavailableReason}`);

    const child = spawn(entry.command, [...entry.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...entry.env },
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    });
    const client = new McpStdioClient(child);
    try {
      await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bonsai-harness", version: "0.2.0" },
      }, INITIALIZATION_TIMEOUT_MS);
      client.notify("notifications/initialized");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list response does not contain a tools array");
      for (const tool of result.tools) tools.push(parseMcpTool(tool));

      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) return tools;
    }
    throw new Error(`MCP tools/list exceeded ${MAX_TOOL_PAGES} pages`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, TOOL_CALL_TIMEOUT_MS);
    if (!isRecord(result)) throw new Error("MCP tools/call response must be an object");
    return {
      content: result.content ?? [],
      ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
      isError: result.isError === true,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP connection closed"));
    this.child.kill("SIGTERM");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = INITIALIZATION_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new Error("MCP connection is closed"));
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string): void {
    if (this.closed || !this.child.stdin.writable) return;
    this.write({ jsonrpc: "2.0", method });
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf-8") > MAX_STDIO_LINE_BYTES) {
      this.closeWithError(new Error(`MCP stdout exceeded ${MAX_STDIO_LINE_BYTES} bytes without a complete message`));
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.readMessage(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private readMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.closeWithError(new Error("MCP stdout contained invalid JSON-RPC"));
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeoutId);
    if (isRecord(message.error)) {
      pending.reject(new Error(`MCP error ${String(message.error.code ?? "unknown")}: ${String(message.error.message ?? "unknown")}`));
      return;
    }
    pending.resolve(message.result);
  }

  private closeWithError(error: Error): void {
    if (!this.closed) this.child.kill("SIGTERM");
    this.closed = true;
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
  }
}

export class McpConnectionManager {
  private readonly connections = new Map<string, { entry: McpServerEntry; client: McpStdioClient; tools: McpTool[] }>();
  private readonly registry: readonly McpServerEntry[];

  constructor(registry: readonly McpServerEntry[] = MCP_REGISTRY) {
    this.registry = registry;
  }

  get count(): number {
    return this.connections.size;
  }

  listConnected(): ConnectedMcpServer[] {
    return [...this.connections.values()].map(({ entry, tools }) => ({
      name: entry.name,
      displayName: entry.displayName,
      tools,
    }));
  }

  async connect(name: string): Promise<ConnectedMcpServer> {
    const existing = this.connections.get(name);
    if (existing) return { name: existing.entry.name, displayName: existing.entry.displayName, tools: existing.tools };

    const entry = this.registry.find((server) => server.name === name);
    if (!entry) throw new Error(`Unknown MCP server: ${name}`);
    const client = await McpStdioClient.connect(entry);
    try {
      const tools = await client.listTools();
      this.connections.set(name, { entry, client, tools });
      return { name: entry.name, displayName: entry.displayName, tools };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  disconnect(name: string): boolean {
    const connection = this.connections.get(name);
    if (!connection) return false;
    connection.client.close();
    this.connections.delete(name);
    return true;
  }

  disconnectAll(): void {
    for (const name of this.connections.keys()) this.disconnect(name);
  }

  providerTools(): ProviderToolDefinition[] {
    return this.providerToolBindings().map(({ providerName, tool }) => ({
      name: providerName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callProviderTool(providerName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const binding = this.providerToolBindings().find((candidate) => candidate.providerName === providerName);
    if (!binding) throw new Error(`Unknown connected MCP tool: ${providerName}`);
    return binding.connection.client.callTool(binding.tool.name, args);
  }

  getProviderToolMetadata(providerName: string): { server: string; tool: string } | undefined {
    const binding = this.providerToolBindings().find((candidate) => candidate.providerName === providerName);
    return binding ? { server: binding.connection.entry.name, tool: binding.tool.name } : undefined;
  }

  private providerToolBindings(): Array<{ providerName: string; connection: { entry: McpServerEntry; client: McpStdioClient; tools: McpTool[] }; tool: McpTool }> {
    const usedNames = new Set<string>();
    const bindings: Array<{ providerName: string; connection: { entry: McpServerEntry; client: McpStdioClient; tools: McpTool[] }; tool: McpTool }> = [];
    for (const connection of this.connections.values()) {
      for (const tool of connection.tools) {
        const providerName = uniqueProviderToolName(connection.entry.name, tool.name, usedNames);
        bindings.push({ providerName, connection, tool });
      }
    }
    return bindings;
  }
}

function uniqueProviderToolName(serverName: string, toolName: string, usedNames: Set<string>): string {
  const normalized = `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56) || "mcp_tool";
  let candidate = normalized;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${normalized.slice(0, 56 - String(suffix).length)}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function parseMcpTool(value: unknown): McpTool {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("MCP tools/list returned an invalid tool definition");
  }
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : value.name,
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : { type: "object", properties: {} },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
