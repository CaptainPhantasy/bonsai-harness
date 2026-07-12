import { serve, type ServerWebSocket } from "bun";
import { mkdir } from "node:fs/promises";
import { McpConnectionManager, type McpToolResult } from "./src/mcp-client";
import { listMcpServerSummaries } from "./src/mcp-registry";
import { handleOpenCodeGatewayRequest } from "./src/opencode-gateway";
import { DEFAULT_SAFETY_MODE, decideToolCall, type SafetyMode } from "./src/safety-modes";
import {
  appendConversationTurn,
  createConversationId,
  historyToOpenAiMessages,
  loadConversation,
} from "./src/conversation-log";
import { buildGovernorSystemPrompt } from "./src/governor-prompt";
import { loadModelCatalog } from "./src/model-catalog";
import { routeAndValidate, type RoutingRequest } from "./src/router";
import {
  OpenAiStreamHttpError,
  streamOpenAiCompatibleCompletion,
  type StreamedToolCall,
} from "./src/streaming-openai";
import { extractVerdict, stripVerdictLine, type AgentVerdict } from "./src/verdict";
import {
  backupRuntimeFromCatalog,
  runtimeFromCatalogEntry,
  type ResolvedRuntime,
} from "./src/runtime-resolver";
import { ModelRateLimiter, routeWithRateLimit } from "./src/rate-limiter";
import { checkMediaGate, type MediaMode } from "./src/media-policy";

import {
  assertSpawnCapacity,
  buildAnthropicConversationRequest,
  buildOpenAiCompatibleConversationRequest,
  createSandboxPath,
  healthPayload,
  parseClientMessage,
  applySettingsUpdate,
  readSettingsSnapshot,
  resolveBindHost,
  resolveMaxActiveAgents,
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
const DEFAULT_WEBSOCKET_ORIGINS = [
  "http://127.0.0.1:11432",
  "http://localhost:11432",
  "https://douglass-mac-mini.tail58d565.ts.net",
  "https://douglass-mac-mini.tail58d565.ts.net:10017",
];
const ALLOWED_WEBSOCKET_ORIGINS = new Set((process.env.HARNESS_ALLOWED_ORIGINS?.split(",") ?? DEFAULT_WEBSOCKET_ORIGINS)
  .map((origin) => origin.trim())
  .filter(Boolean));
const clients = new Set<ClientSocket>();
const activeAgents = new Map<string, RunningAgent>();
const agentOwners = new Map<string, ClientSocket>();
const mcpManager = new McpConnectionManager();
const pendingToolApprovals = new Map<string, PendingToolApproval>();
/**
 * Per-WebSocket conversation scoping (I-06). The first `send_message` on a
 * socket mints a stable conversationId; subsequent messages on the same
 * socket reuse it. Cleared on `close(ws)`. Replaces the W1 bug where every
 * message got a fresh `Chat-${Date.now()}` and history could never thread.
 */
const conversationBySocket = new Map<ClientSocket, string>();
/**
 * Per-conversation provider tracking (I-10). Records which provider the
 * router last picked for a conversation so the next turn continues on the
 * same side unless a hard signal (vision attachment, deep-reasoning verb)
 * forces a switch.
 */
const providerByConversation = new Map<string, string>();

const SANDBOX_ROOT = resolveSandboxRoot(process.env);
await mkdir(SANDBOX_ROOT, { recursive: true });

/**
 * Single catalog instance loaded at startup. Fail-closed: if the catalog is
 * malformed or missing, the server never starts. No env-var fallback path.
 */
const CATALOG = loadModelCatalog();
/**
 * Single rate-limiter instance per process. Tracks per-model RPM using the
 * catalog's `rateLimits.rpm` field. Closes the M3-RPM-is-40%-of-M2.7 risk
 * by shedding to same-provider alternates when a window fills.
 */
const rateLimiter = new ModelRateLimiter(CATALOG);

function spawnHarnessAgent(
  agentId: string,
  rolePrompt: string,
  owner: ClientSocket,
  requested: {
    primary: ResolvedRuntime;
    backup: ResolvedRuntime | null;
    safetyMode?: SafetyMode | undefined;
    conversationId?: string | undefined;
    priorHistory?: Array<{ role: string; content: string }> | undefined;
    mediaMode?: MediaMode | undefined;
  },
) {
  if (activeAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already active`);
  }
  assertSpawnCapacity(activeAgents.size, MAX_ACTIVE_AGENTS);

  const { primary, backup } = requested;
  const safetyMode = requested.safetyMode ?? DEFAULT_SAFETY_MODE;
  const conversationId = requested.conversationId;
  const priorHistory = requested.priorHistory;
  const mediaMode = requested.mediaMode;
  agentOwners.set(agentId, owner);

  if (primary.runtime.kind === "anthropic") {
    console.log(`[HARNESS] Spawning ${agentId} with ${primary.runtime.modelId} via anthropic:${primary.runtime.apiBaseUrl}`);
    const anthropicController = new AbortController();
    const anthropicTimeoutId = setTimeout(() => anthropicController.abort(), API_TIMEOUT_MS);
    activeAgents.set(agentId, { stop: () => { clearTimeout(anthropicTimeoutId); anthropicController.abort(); rejectApprovalsForAgent(agentId); } });
    broadcast({ type: "status", payload: `Spawned ${agentId} (anthropic:${primary.runtime.modelId})` });
    void runAnthropicAgent(agentId, rolePrompt, primary, safetyMode, anthropicController, anthropicTimeoutId, conversationId, priorHistory, mediaMode);
    return;
  }

  console.log(`[HARNESS] Spawning ${agentId} with ${primary.runtime.modelId} via ${primary.runtime.kind}:${primary.runtime.apiBaseUrl}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  activeAgents.set(agentId, { stop: () => { clearTimeout(timeoutId); controller.abort(); rejectApprovalsForAgent(agentId); } });
  broadcast({ type: "status", payload: `Spawned ${agentId} (${primary.runtime.kind}:${primary.runtime.modelId})` });
  void runOpenAiCompatibleAgent(agentId, rolePrompt, primary, backup, safetyMode, controller, timeoutId, conversationId, priorHistory, mediaMode);
}

async function runOpenAiCompatibleAgent(
  agentId: string,
  rolePrompt: string,
  primary: ResolvedRuntime,
  backup: ResolvedRuntime | null,
  safetyMode: SafetyMode,
  controller: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
  conversationId?: string | undefined,
  priorHistory?: Array<{ role: string; content: string }> | undefined,
  mediaMode?: MediaMode | undefined,
) {
  let exitCode = 0;
  try {
    const tools = mcpManager.providerTools();
    const governorSystem = buildGovernorSystemPrompt(loadModelCatalog(), primary.runtime.modelId, {
      agentId,
      maxToolRounds: MAX_AGENT_TOOL_ROUNDS,
      availableToolCount: tools.length,
      ...(conversationId ? { conversationId } : {}),
    });
    const messages: Record<string, unknown>[] = [
      { role: "system", content: governorSystem },
      ...(priorHistory && priorHistory.length > 0 ? priorHistory : []),
      { role: "user", content: rolePrompt },
    ];
    let active: { resolved: ResolvedRuntime; label: "primary" | "backup" } = {
      resolved: primary,
      label: "primary",
    };
    for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
      if (active.resolved.runtime.kind !== "openai-compatible") {
        throw new Error(`Internal: OpenAI-compatible agent loop received ${active.resolved.runtime.kind} runtime`);
      }
      const { url, body } = buildOpenAiCompatibleConversationRequest(active.resolved.runtime, messages, tools);
      let completion;
      try {
        completion = await streamOpenAiCompatibleCompletion({
          url,
          body,
          headers: {
            "authorization": `Bearer ${active.resolved.key}`,
            "content-type": "application/json",
          },
          signal: controller.signal,
          onDelta: (delta) => {
            if (delta.content) {
              broadcast({ type: "inference_delta", agentId, payload: delta.content, channel: "content" });
            }
            if (delta.reasoning) {
              broadcast({ type: "inference_delta", agentId, payload: delta.reasoning, channel: "reasoning" });
            }
          },
        });
      } catch (streamError) {
        if (streamError instanceof OpenAiStreamHttpError && backup && active.label === "primary" && !controller.signal.aborted) {
          broadcast({ type: "status", payload: `Primary runtime HTTP ${streamError.status}; failing over to backup ${backup.entry.id}` });
          active = { resolved: backup, label: "backup" };
          rateLimiter.recordRequest(backup.entry.id);
          round -= 1;
          continue;
        }
        if (!(streamError instanceof OpenAiStreamHttpError) && backup && active.label === "primary" && !controller.signal.aborted) {
          const reason = streamError instanceof Error ? streamError.message : String(streamError);
          broadcast({ type: "status", payload: `Primary runtime unreachable (${reason}); failing over to backup ${backup.entry.id}` });
          active = { resolved: backup, label: "backup" };
          rateLimiter.recordRequest(backup.entry.id);
          round -= 1;
          continue;
        }
        throw streamError;
      }

      const toolCalls = parseStreamedToolCalls(completion.toolCalls);
      if (completion.finishReason !== "tool_calls" || toolCalls.length === 0) {
        // I-08 contract closure: parse the verdict the Governor-0 prompt
        // requested, then route on nextAction. Burns one tool round per
        // retry — bounded by MAX_AGENT_TOOL_ROUNDS so a misbehaving model
        // cannot loop forever. Escalate returns control to the operator.
        const verdict: AgentVerdict | null = extractVerdict(completion.content);
        const displayContent = verdict ? stripVerdictLine(completion.content) : completion.content;

        // Always persist the raw assistant turn (verdict included) for audit.
        if (conversationId && completion.content) {
          appendConversationTurn(conversationId, { role: "assistant", content: completion.content });
        }

        if (verdict) {
          broadcast({ type: "status", payload: `Verdict passed=${verdict.passed} nextAction=${verdict.nextAction}: ${verdict.reason}` });

          if (verdict.nextAction === "retry" && round < MAX_AGENT_TOOL_ROUNDS - 1) {
            // Push the assistant turn + a follow-up user nudge, then loop.
            messages.push({ role: "assistant", content: completion.content || null });
            messages.push({
              role: "user",
              content: `Prior verdict reported passed=false: ${verdict.reason}. Re-attempt the task addressing this failure, or return a stop verdict if the failure is irrecoverable.`,
            });
            continue;
          }

          if (verdict.nextAction === "escalate") {
            broadcast({ type: "inference", agentId, payload: `${displayContent}\n\n[escalated to operator: ${verdict.reason}]` });
            broadcast({ type: "status", payload: `ESCALATION requested by ${agentId}: ${verdict.reason}` });
            return;
          }
          // nextAction === "stop" — fall through to broadcast displayContent.
        }

        broadcast({ type: "inference", agentId, payload: displayContent });
        return;
      }

      messages.push({
        role: "assistant",
        content: completion.content || null,
        tool_calls: completion.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      for (const toolCall of toolCalls) {
        const result = await executeMcpToolCall(agentId, safetyMode, toolCall.name, toolCall.arguments, controller.signal, mediaMode);
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
  primary: ResolvedRuntime,
  safetyMode: SafetyMode,
  controller: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
  conversationId?: string | undefined,
  priorHistory?: Array<{ role: string; content: string }> | undefined,
  mediaMode?: MediaMode | undefined,
) {
  let exitCode = 0;
  try {
    const tools = mcpManager.providerTools();
    const governorSystem = buildGovernorSystemPrompt(loadModelCatalog(), primary.runtime.modelId, {
      agentId,
      maxToolRounds: MAX_AGENT_TOOL_ROUNDS,
      availableToolCount: tools.length,
      ...(conversationId ? { conversationId } : {}),
    });
    const messages: Record<string, unknown>[] = [
      { role: "system", content: governorSystem },
      ...(priorHistory && priorHistory.length > 0 ? priorHistory : []),
      { role: "user", content: rolePrompt },
    ];
    if (primary.runtime.kind !== "anthropic") {
      throw new Error(`Internal: Anthropic agent loop received ${primary.runtime.kind} runtime`);
    }
    const runtime: AnthropicRuntime = primary.runtime;
    for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
      const { url, body, headers } = buildAnthropicConversationRequest(runtime, messages, tools);
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "x-api-key": primary.key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`Anthropic API failed with HTTP ${response.status}: ${responseText}`);
      const responseJson = JSON.parse(responseText) as unknown;
      const content = extractAnthropicContentBlocks(responseJson);
      const toolCalls = extractAnthropicToolCalls(content);
      if (toolCalls.length === 0) {
        const finalContent = extractAnthropicContent(responseJson);
        const verdict: AgentVerdict | null = extractVerdict(finalContent);
        const displayContent = verdict ? stripVerdictLine(finalContent) : finalContent;

        if (conversationId && finalContent) {
          appendConversationTurn(conversationId, { role: "assistant", content: finalContent });
        }

        if (verdict) {
          broadcast({ type: "status", payload: `Verdict passed=${verdict.passed} nextAction=${verdict.nextAction}: ${verdict.reason}` });

          if (verdict.nextAction === "retry" && round < MAX_AGENT_TOOL_ROUNDS - 1) {
            messages.push({ role: "assistant", content });
            messages.push({
              role: "user",
              content: `Prior verdict reported passed=false: ${verdict.reason}. Re-attempt the task addressing this failure, or return a stop verdict if the failure is irrecoverable.`,
            });
            continue;
          }
          if (verdict.nextAction === "escalate") {
            broadcast({ type: "inference", agentId, payload: `${displayContent}\n\n[escalated to operator: ${verdict.reason}]` });
            broadcast({ type: "status", payload: `ESCALATION requested by ${agentId}: ${verdict.reason}` });
            return;
          }
        }

        broadcast({ type: "inference", agentId, payload: displayContent });
        return;
      }

      messages.push({ role: "assistant", content });
      const results: Record<string, unknown>[] = [];
      for (const toolCall of toolCalls) {
        const result = await executeMcpToolCall(agentId, safetyMode, toolCall.name, toolCall.arguments, controller.signal, mediaMode);
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
  mediaMode?: MediaMode | undefined,
): Promise<McpToolResult> {
  if (signal.aborted) throw new DOMException("Agent stopped", "AbortError");
  const metadata = mcpManager.getProviderToolMetadata(providerToolName);
  if (!metadata) return toolErrorResult(`MCP tool is no longer connected: ${providerToolName}`);

  // Media gate fires BEFORE the safety-mode decision. Rationale: media tools
  // draw from finite Credits. Yolo doesn't override "the user didn't activate
  // media mode." Even if the user is in yolo, the model cannot autonomously
  // decide to generate media — it must ask the user to activate media mode.
  const mediaGate = checkMediaGate(mediaMode, metadata.tool);
  if (!mediaGate.allowed) return toolErrorResult(mediaGate.reason);

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

    if (url.pathname === "/api/catalog" && req.method === "GET") {
      // Safe catalog summary for the frontend. Strips every field the
      // browser has no business seeing: credential env-var names, API base
      // URLs, auth-broker provider tags, rate-limit RPMs, and operational
      // notes. The frontend uses this to drive the model picker and to
      // validate custom model ids before they reach the spawn path.
      return Response.json({
        version: CATALOG.version,
        generatedAt: CATALOG.generatedAt,
        defaults: {
          primaryModelId: CATALOG.defaults.primaryModelId,
          backupModelId: CATALOG.defaults.backupModelId,
          visionFallbackModelId: CATALOG.defaults.visionFallbackModelId,
        },
        models: CATALOG.models.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          provider: m.provider,
          context: m.context,
          maxOutput: m.maxOutput,
          modalities: m.modalities,
          roles: m.roles,
          reasoning: { kind: m.reasoning.kind, effort: m.reasoning.effort },
          ...(m.planCoverage ? { planCoverage: m.planCoverage } : {}),
        })),
        providers: Object.fromEntries(
          Object.entries(CATALOG.providers).map(([id, p]) => [id, {
            displayName: p.displayName,
            runtimeKind: p.runtimeKind,
            subscription: p.subscription,
          }]),
        ),
      });
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
          // Catalog-driven runtime construction: resolve modelId from the
          // catalog (explicit request or catalog default) and build the
          // runtime from the provider's declared endpoint/credential.
          const targetModelId = req.modelId ?? CATALOG.defaults.primaryModelId;
          const primary = runtimeFromCatalogEntry(CATALOG, targetModelId, process.env);
          const backup = backupRuntimeFromCatalog(CATALOG, primary.entry.id, process.env);
          spawnHarnessAgent(req.agentId, req.prompt, ws, {
            primary,
            backup,
            safetyMode: req.safetyMode,
          });
          return;
        }

        if (req.action === "send_message") {
          const conversationId = conversationBySocket.get(ws) ?? createConversationId();
          conversationBySocket.set(ws, conversationId);
          let prompt = req.payload;
          if (req.attachments && req.attachments.length > 0) {
            const fileList = req.attachments.map((a) => `- ${a.name} (${a.type}, ${a.size} bytes)`).join("\n");
            prompt = `${req.payload}\n\nAttached files:\n${fileList}`;
          }
          appendConversationTurn(conversationId, { role: "user", content: prompt });
          const priorHistory = historyToOpenAiMessages(loadConversation(conversationId));
          // Drop the trailing user turn we just appended — it becomes rolePrompt
          // and gets re-added by the agent loop. Avoids a duplicated user msg.
          priorHistory.pop();

          // I-10: capability router picks the model based on attachment shape
          // and prompt verbs. Prior provider is tracked so continuation stays
          // on the same side unless a hard signal forces a switch.
          const priorProviderId = providerByConversation.get(conversationId);
          const routingRequest: RoutingRequest = {
            prompt: req.payload,
            ...(req.attachments ? { attachments: req.attachments } : {}),
            ...(priorProviderId ? { priorProviderId } : {}),
          };
          const decision = routeAndValidate(CATALOG, routingRequest);
          providerByConversation.set(conversationId, decision.provider);
          broadcast({ type: "status", payload: `Router → ${decision.modelId} (${decision.reason})` });

          // RPM-aware shedding: if the router's first choice is at its per-minute
          // cap, look for a same-provider alternate with the required modalities
          // and higher headroom. M3 (200 RPM) text work sheds to M2.7 (500 RPM).
          // Cross-provider shedding is not done here — that's the agent loop's
          // primary→backup failover path.
          const requiredModalities = attachmentsToModalities(req.attachments);
          const limited = routeWithRateLimit({
            catalog: CATALOG,
            limiter: rateLimiter,
            requiredModalities,
            firstChoiceModelId: decision.modelId,
          });
          if (limited.alternateUsed) {
            broadcast({ type: "status", payload: limited.reason });
          }
          if (limited.throttled) {
            // Proceed anyway when no alternate exists — the runtime may queue,
            // or the operator prefers a 429 over silent refusal. Surface it.
            broadcast({ type: "status", payload: `Rate-limit warning: ${limited.reason}` });
          }
          const chosenModelId = limited.modelId;
          rateLimiter.recordRequest(chosenModelId);

          const primary = runtimeFromCatalogEntry(CATALOG, chosenModelId, process.env);
          const backup = backupRuntimeFromCatalog(CATALOG, primary.entry.id, process.env);

          spawnHarnessAgent(conversationId, prompt, ws, {
            primary,
            backup,
            safetyMode: req.safetyMode,
            conversationId,
            priorHistory,
            ...(req.mediaMode ? { mediaMode: req.mediaMode } : {}),
          });
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
      conversationBySocket.delete(ws);
      for (const [agentId, owner] of agentOwners) {
        if (owner === ws) activeAgents.get(agentId)?.stop();
      }
    },
  },
});

/**
 * Extract the modalities a request needs based on its attachment MIME types.
 * Used by the rate-limiter shedding path to filter same-provider alternates
 * — a video attachment cannot shed to a text-only model even if its RPM is
 * wide open.
 */
function attachmentsToModalities(
  attachments: { name: string; size: number; type: string }[] | undefined,
): string[] {
  if (!attachments || attachments.length === 0) return ["text"];
  const modalities = new Set<string>(["text"]);
  for (const a of attachments) {
    if (a.type.startsWith("image/")) modalities.add("image");
    else if (a.type.startsWith("video/")) modalities.add("video");
  }
  return [...modalities];
}

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

/**
 * Parse tool calls accumulated from the streaming response. The streamed
 * shape gives `arguments` as a string (assembled from fragments across
 * multiple SSE chunks); this function JSON-parses each one and synthesizes
 * an id when the stream omitted one.
 *
 * Replaces extractOpenAiAssistantMessage + extractOpenAiToolCalls, which
 * were tuned for the non-streaming JSON shape. The streaming rewrite
 * (I-09) made those obsolete — kept extractOpenAiCompatibleContent for
 * any future non-streaming fallback path.
 */
function parseStreamedToolCalls(streamed: StreamedToolCall[]): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  return streamed.map((toolCall, index) => {
    if (!toolCall.name) {
      throw new Error("Streamed tool call is missing function name");
    }
    let argumentsValue: unknown = {};
    const raw = toolCall.arguments.trim();
    if (raw.length > 0) {
      try {
        argumentsValue = JSON.parse(raw);
      } catch {
        throw new Error(`Streamed tool call ${toolCall.name} returned invalid JSON arguments: ${raw.slice(0, 80)}`);
      }
    }
    if (!isRecord(argumentsValue)) {
      throw new Error(`Streamed tool call ${toolCall.name} returned non-object arguments`);
    }
    return {
      id: toolCall.id.length > 0 ? toolCall.id : `tool-call-${index + 1}`,
      name: toolCall.name,
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
