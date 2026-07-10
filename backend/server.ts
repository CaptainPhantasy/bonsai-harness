import { serve, type ServerWebSocket } from "bun";
import { mkdir } from "node:fs/promises";
import { McpConnectionManager, type McpToolResult } from "./src/mcp-client";
import { listMcpServerSummaries } from "./src/mcp-registry";
import { handleOpenCodeGatewayRequest } from "./src/opencode-gateway";
import { DEFAULT_SAFETY_MODE, decideToolCall, type SafetyMode } from "./src/safety-modes";

import {
  assertSpawnCapacity,
  buildAnthropicConversationRequest,
  buildOpenAiCompatibleConversationRequest,
  createSandboxPath,
  healthPayload,
  parseClientMessage,
  applySettingsUpdate,
  readSettingsSnapshot,
  resolveAnthropicApiKey,
  resolveApiKey,
  resolveBindHost,
  resolveMaxActiveAgents,
  resolveModelRuntime,
  resolvePort,
  resolveSandboxRoot,
  type AnthropicRuntime,
  type HarnessEvent,
  type OpenAiCompatibleRuntime,
} from "./src/server-core";

type ClientSocket = ServerWebSocket<unknown>;
type RunningAgent = { stop: () => void };
type PendingToolApproval = {
  agentId: string;
  owner: ClientSocket;
  resolve: (approved: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const API_TIMEOUT_MS = 60_000;
const TOOL_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_AGENT_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 100_000;

const PORT = resolvePort(process.env);
const BIND_HOST = resolveBindHost(process.env);
const MAX_ACTIVE_AGENTS = resolveMaxActiveAgents(process.env);
const ALLOWED_WEBSOCKET_ORIGINS = new Set((process.env.HARNESS_ALLOWED_ORIGINS?.split(",") ?? ["http://127.0.0.1:11432", "http://localhost:11432"])
  .map((origin) => origin.trim())
  .filter(Boolean));
const clients = new Set<ClientSocket>();
const activeAgents = new Map<string, RunningAgent>();
const agentOwners = new Map<string, ClientSocket>();
const mcpManager = new McpConnectionManager();
const pendingToolApprovals = new Map<string, PendingToolApproval>();

const SANDBOX_ROOT = resolveSandboxRoot(process.env);
await mkdir(SANDBOX_ROOT, { recursive: true });

function spawnHarnessAgent(
  agentId: string,
  rolePrompt: string,
  owner: ClientSocket,
  requested: { modelId?: string | undefined; runtimeKind?: "openai-compatible" | "anthropic" | undefined; safetyMode?: SafetyMode | undefined } = {},
) {
  if (activeAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already active`);
  }
  assertSpawnCapacity(activeAgents.size, MAX_ACTIVE_AGENTS);

  const runtime = resolveModelRuntime(process.env, requested);
  const safetyMode = requested.safetyMode ?? DEFAULT_SAFETY_MODE;
  agentOwners.set(agentId, owner);

  if (runtime.kind === "anthropic") {
    console.log(`[HARNESS] Spawning ${agentId} with ${runtime.modelId} via anthropic:${runtime.apiBaseUrl}`);
    const anthropicController = new AbortController();
    const anthropicTimeoutId = setTimeout(() => anthropicController.abort(), API_TIMEOUT_MS);
    activeAgents.set(agentId, { stop: () => { clearTimeout(anthropicTimeoutId); anthropicController.abort(); rejectApprovalsForAgent(agentId); } });
    broadcast({ type: "status", payload: `Spawned ${agentId} (anthropic:${runtime.modelId})` });
    void runAnthropicAgent(agentId, rolePrompt, runtime, safetyMode, anthropicController, anthropicTimeoutId);
    return;
  }

  console.log(`[HARNESS] Spawning ${agentId} with ${runtime.modelId} via ${runtime.kind}:${runtime.apiBaseUrl}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  activeAgents.set(agentId, { stop: () => { clearTimeout(timeoutId); controller.abort(); rejectApprovalsForAgent(agentId); } });
  broadcast({ type: "status", payload: `Spawned ${agentId} (${runtime.kind}:${runtime.modelId})` });
  void runOpenAiCompatibleAgent(agentId, rolePrompt, runtime, safetyMode, controller, timeoutId);
}

async function runOpenAiCompatibleAgent(
  agentId: string,
  rolePrompt: string,
  runtime: OpenAiCompatibleRuntime,
  safetyMode: SafetyMode,
  controller: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
) {
  let exitCode = 0;
  try {
    const tools = mcpManager.providerTools();
    const messages: Record<string, unknown>[] = [{ role: "user", content: rolePrompt }];
    for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
      const { url, body } = buildOpenAiCompatibleConversationRequest(runtime, messages, tools);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${resolveApiKey(process.env)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`API runtime failed with HTTP ${response.status}: ${responseText}`);
      const responseJson = JSON.parse(responseText) as unknown;
      const assistantMessage = extractOpenAiAssistantMessage(responseJson);
      const toolCalls = assistantMessage ? extractOpenAiToolCalls(assistantMessage) : [];
      if (!assistantMessage || toolCalls.length === 0) {
        broadcast({ type: "inference", agentId, payload: extractOpenAiCompatibleContent(responseJson) });
        return;
      }

      messages.push(assistantMessage);
      for (const toolCall of toolCalls) {
        const result = await executeMcpToolCall(agentId, safetyMode, toolCall.name, toolCall.arguments, controller.signal);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: serializeMcpToolResult(result) });
      }
    }
    throw new Error(`Agent exceeded ${MAX_AGENT_TOOL_ROUNDS} MCP tool rounds`);
  } catch (error) {
    exitCode = 1;
    const payload = error instanceof Error && error.name === "AbortError"
      ? "API runtime aborted"
      : error instanceof Error ? error.message : String(error);
    broadcast({ type: "error", agentId, payload });
  } finally {
    clearTimeout(timeoutId);
    activeAgents.delete(agentId);
    agentOwners.delete(agentId);
    broadcast({ type: "agent_exit", agentId, code: exitCode, signal: null });
  }
}

async function runAnthropicAgent(
  agentId: string,
  rolePrompt: string,
  runtime: AnthropicRuntime,
  safetyMode: SafetyMode,
  controller: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
) {
  let exitCode = 0;
  try {
    const tools = mcpManager.providerTools();
    const messages: Record<string, unknown>[] = [{ role: "user", content: rolePrompt }];
    for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
      const { url, body, headers } = buildAnthropicConversationRequest(runtime, messages, tools);
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "x-api-key": resolveAnthropicApiKey(process.env) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`Anthropic API failed with HTTP ${response.status}: ${responseText}`);
      const responseJson = JSON.parse(responseText) as unknown;
      const content = extractAnthropicContentBlocks(responseJson);
      const toolCalls = extractAnthropicToolCalls(content);
      if (toolCalls.length === 0) {
        broadcast({ type: "inference", agentId, payload: extractAnthropicContent(responseJson) });
        return;
      }

      messages.push({ role: "assistant", content });
      const results: Record<string, unknown>[] = [];
      for (const toolCall of toolCalls) {
        const result = await executeMcpToolCall(agentId, safetyMode, toolCall.name, toolCall.arguments, controller.signal);
        results.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: serializeMcpToolResult(result),
          is_error: result.isError,
        });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`Agent exceeded ${MAX_AGENT_TOOL_ROUNDS} MCP tool rounds`);
  } catch (error) {
    exitCode = 1;
    const payload = error instanceof Error && error.name === "AbortError"
      ? "Anthropic API runtime aborted"
      : error instanceof Error ? error.message : String(error);
    broadcast({ type: "error", agentId, payload });
  } finally {
    clearTimeout(timeoutId);
    activeAgents.delete(agentId);
    agentOwners.delete(agentId);
    broadcast({ type: "agent_exit", agentId, code: exitCode, signal: null });
  }
}

async function writeToSandbox(filename: string, content: string) {
  const safePath = createSandboxPath(filename, SANDBOX_ROOT);
  await Bun.write(safePath, content);
  return safePath;
}

async function executeMcpToolCall(
  agentId: string,
  safetyMode: SafetyMode,
  providerToolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<McpToolResult> {
  if (signal.aborted) throw new DOMException("Agent stopped", "AbortError");
  const metadata = mcpManager.getProviderToolMetadata(providerToolName);
  if (!metadata) return toolErrorResult(`MCP tool is no longer connected: ${providerToolName}`);

  const decision = decideToolCall(safetyMode, metadata.tool);
  if (decision.effect === "block") return toolErrorResult(decision.reason);
  if (decision.effect === "ask") {
    const owner = agentOwners.get(agentId);
    if (!owner) return toolErrorResult("The initiating client disconnected before this tool call could be approved");
    const approved = await requestToolApproval(agentId, owner, metadata.server, metadata.tool, args);
    if (!approved || signal.aborted) return toolErrorResult(approved ? "Agent stopped before tool execution" : `Tool call was not approved: ${metadata.tool}`);
  }

  broadcast({ type: "mcp_response", server: metadata.server, payload: `Calling ${metadata.tool}` });
  try {
    const result = await mcpManager.callProviderTool(providerToolName, args);
    broadcast({ type: "mcp_response", server: metadata.server, payload: `${metadata.tool} completed${result.isError ? " with an error" : ""}` });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    broadcast({ type: "mcp_response", server: metadata.server, payload: `${metadata.tool} failed` });
    return toolErrorResult(`MCP tool failed: ${message}`);
  }
}

function requestToolApproval(
  agentId: string,
  owner: ClientSocket,
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const requestId = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingToolApprovals.delete(requestId);
      resolve(false);
    }, TOOL_APPROVAL_TIMEOUT_MS);
    pendingToolApprovals.set(requestId, { agentId, owner, resolve, timeoutId });
    owner.send(JSON.stringify({
      type: "tool_approval_required",
      requestId,
      agentId,
      server,
      tool,
      arguments: truncateToolArguments(args),
    } satisfies HarnessEvent));
  });
}

function resolveToolApproval(owner: ClientSocket, requestId: string, approved: boolean): boolean {
  const pending = pendingToolApprovals.get(requestId);
  if (!pending || pending.owner !== owner) return false;
  pendingToolApprovals.delete(requestId);
  clearTimeout(pending.timeoutId);
  pending.resolve(approved);
  return true;
}

function rejectApprovalsForAgent(agentId: string): void {
  for (const [requestId, pending] of pendingToolApprovals) {
    if (pending.agentId !== agentId) continue;
    pendingToolApprovals.delete(requestId);
    clearTimeout(pending.timeoutId);
    pending.resolve(false);
  }
}

function clearToolApprovals(): void {
  for (const [requestId, pending] of pendingToolApprovals) {
    pendingToolApprovals.delete(requestId);
    clearTimeout(pending.timeoutId);
    pending.resolve(false);
  }
}

function toolErrorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function serializeMcpToolResult(result: McpToolResult): string {
  const serialized = JSON.stringify(result);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized;
  return JSON.stringify(toolErrorResult(`MCP tool result exceeded ${MAX_TOOL_RESULT_CHARS} characters and was not passed to the model`));
}

function truncateToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(args);
  if (serialized.length <= 4_000) return args;
  return { _truncated: true, preview: serialized.slice(0, 4_000) };
}

function decodeMcpServerName(segment: string): string {
  try {
    const name = decodeURIComponent(segment);
    if (!name) throw new Error("MCP server name cannot be empty");
    return name;
  } catch {
    throw new Error("Invalid MCP server name");
  }
}

serve({
  port: PORT,
  hostname: BIND_HOST,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: "GET, POST, PUT, DELETE, OPTIONS" } });
    }

    if (url.pathname === "/gateway") {
      return handleOpenCodeGatewayRequest(req);
    }

    if (url.pathname === "/health") {
      return Response.json(healthPayload(activeAgents.size, mcpManager.count, process.env));
    }

    if (url.pathname === "/api/mcp/servers" && req.method === "GET") {
      const connected = new Set(mcpManager.listConnected().map((server) => server.name));
      return Response.json(listMcpServerSummaries().map((server) => ({ ...server, connected: connected.has(server.name) })));
    }

    const connectMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/connect$/);
    if (connectMatch && req.method === "POST") {
      try {
        const name = decodeMcpServerName(connectMatch[1] ?? "");
        const connected = await mcpManager.connect(name);
        broadcast({ type: "mcp_response", server: connected.name, payload: `Connected with ${connected.tools.length} tool${connected.tools.length === 1 ? "" : "s"}` });
        return Response.json({ ok: true, server: { name: connected.name, displayName: connected.displayName, toolCount: connected.tools.length } });
      } catch (error) {
        const payload = error instanceof Error ? error.message : String(error);
        return Response.json({ error: payload }, { status: 400 });
      }
    }

    const disconnectMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
    if (disconnectMatch && req.method === "DELETE") {
      try {
        const name = decodeMcpServerName(disconnectMatch[1] ?? "");
        if (!mcpManager.disconnect(name)) return Response.json({ error: `MCP server is not connected: ${name}` }, { status: 404 });
        broadcast({ type: "mcp_response", server: name, payload: "Disconnected" });
        return Response.json({ ok: true });
      } catch (error) {
        const payload = error instanceof Error ? error.message : String(error);
        return Response.json({ error: payload }, { status: 400 });
      }
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      return Response.json(readSettingsSnapshot(process.env));
    }

    if (url.pathname === "/api/settings" && req.method === "PUT") {
      try {
        const body = await req.json();
        const snapshot = applySettingsUpdate(body);
        return Response.json(snapshot);
      } catch (error) {
        const payload = error instanceof Error ? error.message : String(error);
        return Response.json({ error: payload }, { status: 400 });
      }
    }

    if (req.method === "GET" && isAllowedWebSocketOrigin(req) && server.upgrade(req)) return undefined;
    if (req.method === "GET" && req.headers.has("origin") && !isAllowedWebSocketOrigin(req)) {
      return new Response("WebSocket origin not allowed", { status: 403 });
    }
    return new Response("Bonsai Harness Online", { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "status", payload: "Connected to Bonsai Harness" } satisfies HarnessEvent));
    },
    async message(ws, message) {
      try {
        const req = parseClientMessage(message);
        if (req.action === "spawn_agent") {
          spawnHarnessAgent(req.agentId, req.prompt, ws, { modelId: req.modelId, runtimeKind: req.runtimeKind, safetyMode: req.safetyMode });
          return;
        }

        if (req.action === "send_message") {
          const chatId = `Chat-${Date.now().toString(36)}`;
          let prompt = req.payload;
          if (req.attachments && req.attachments.length > 0) {
            const fileList = req.attachments.map((a) => `- ${a.name} (${a.type}, ${a.size} bytes)`).join("\n");
            prompt = `${req.payload}\n\nAttached files:\n${fileList}`;
          }
          spawnHarnessAgent(chatId, prompt, ws, { safetyMode: req.safetyMode });
          return;
        }

        if (req.action === "stop_generation") {
          const stopped = activeAgents.size;
          for (const [agentId, agent] of activeAgents) {
            agent.stop();
          }
          broadcast({ type: "status", payload: `Stopped ${stopped} active agent${stopped === 1 ? "" : "s"}` });
          return;
        }

        if (req.action === "resolve_tool_approval") {
          if (!resolveToolApproval(ws, req.requestId, req.approved)) {
            throw new Error("Tool approval request is no longer pending");
          }
          return;
        }

        const path = await writeToSandbox(req.filename, req.content);
        broadcast({ type: "sandbox_write", path, payload: `Wrote ${path}` });
      } catch (error) {
        const payload = error instanceof Error ? error.message : String(error);
        ws.send(JSON.stringify({ type: "error", payload } satisfies HarnessEvent));
      }
    },
    close(ws) {
      clients.delete(ws);
      for (const [agentId, owner] of agentOwners) {
        if (owner === ws) activeAgents.get(agentId)?.stop();
      }
    },
  },
});

function broadcast(msg: HarnessEvent) {
  const serialized = JSON.stringify(msg);
  for (const client of clients) {
    client.send(serialized);
  }
}

function isAllowedWebSocketOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || ALLOWED_WEBSOCKET_ORIGINS.has(origin);
}

function extractOpenAiCompatibleContent(value: unknown): string {
  if (isRecord(value)) {
    const choices = value.choices;
    if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
      const message = choices[0].message;
      if (isRecord(message) && typeof message.content === "string") {
        return message.content;
      }
      if (typeof choices[0].text === "string") {
        return choices[0].text;
      }
    }
  }
  return JSON.stringify(value);
}

function extractOpenAiAssistantMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0 || !isRecord(value.choices[0])) return undefined;
  const message = value.choices[0].message;
  return isRecord(message) ? message : undefined;
}

function extractOpenAiToolCalls(message: Record<string, unknown>): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((toolCall, index) => {
    if (!isRecord(toolCall) || !isRecord(toolCall.function) || typeof toolCall.function.name !== "string") {
      throw new Error("API runtime returned an invalid tool call");
    }
    const rawArguments = toolCall.function.arguments;
    let argumentsValue: unknown = {};
    if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
      try {
        argumentsValue = JSON.parse(rawArguments);
      } catch {
        throw new Error(`API runtime returned invalid JSON arguments for ${toolCall.function.name}`);
      }
    }
    if (!isRecord(argumentsValue)) throw new Error(`API runtime returned non-object arguments for ${toolCall.function.name}`);
    return {
      id: typeof toolCall.id === "string" && toolCall.id.length > 0 ? toolCall.id : `tool-call-${index + 1}`,
      name: toolCall.function.name,
      arguments: argumentsValue,
    };
  });
}

function extractAnthropicContent(value: unknown): string {
  const content = extractAnthropicContentBlocks(value);
  const text = content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  return text || JSON.stringify(value);
}

function extractAnthropicContentBlocks(value: unknown): Record<string, unknown>[] {
  return isRecord(value) && Array.isArray(value.content) ? value.content.filter(isRecord) : [];
}

function extractAnthropicToolCalls(content: Record<string, unknown>[]): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  return content.filter((block) => block.type === "tool_use").map((block) => {
    if (typeof block.id !== "string" || block.id.length === 0 || typeof block.name !== "string" || block.name.length === 0 || !isRecord(block.input)) {
      throw new Error("Anthropic API returned an invalid tool_use block");
    }
    return { id: block.id, name: block.name, arguments: block.input };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

process.on("SIGTERM", () => {
  for (const agent of activeAgents.values()) agent.stop();
  clearToolApprovals();
  mcpManager.disconnectAll();
  process.exit(0);
});

console.log(`Bonsai Harness listening on ws://localhost:${PORT}`);
console.log(`Health check available at http://localhost:${PORT}/health`);
