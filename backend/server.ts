import { serve, type ServerWebSocket } from "bun";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";

import {
  assertExecutableExists,
  assertSpawnCapacity,
  buildLocalCommandArguments,
  buildOpenAiCompatibleRequest,
  createSandboxPath,
  healthPayload,
  parseClientMessage,
  resolveApiKey,
  resolveMaxActiveAgents,
  resolveModelRuntime,
  resolvePort,
  resolveSandboxRoot,
  type HarnessEvent,
  type OpenAiCompatibleRuntime,
} from "./src/server-core";

type ClientSocket = ServerWebSocket<unknown>;
type RunningAgent = { stop: (signal?: NodeJS.Signals) => void };

const PORT = resolvePort(process.env);
const MAX_ACTIVE_AGENTS = resolveMaxActiveAgents(process.env);
const clients = new Set<ClientSocket>();
const activeAgents = new Map<string, RunningAgent>();
const mcpConnections = new Map<string, ChildProcessWithoutNullStreams>();

const SANDBOX_ROOT = resolveSandboxRoot(process.env);
await mkdir(SANDBOX_ROOT, { recursive: true });
await mkdir("/Volumes/SanDisk1Tb/bonsai-harness/logs", { recursive: true });

function spawnHarnessAgent(
  agentId: string,
  rolePrompt: string,
  requested: { modelId?: string | undefined; runtimeKind?: "local-command" | "openai-compatible" | undefined } = {},
) {
  if (activeAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already active`);
  }
  assertSpawnCapacity(activeAgents.size, MAX_ACTIVE_AGENTS);

  const runtime = resolveModelRuntime(process.env, requested);

  if (runtime.kind === "local-command") {
    assertExecutableExists(runtime.runnerBinaryPath);
    const args = buildLocalCommandArguments(
      runtime.runnerArgsTemplate,
      runtime.modelId,
      rolePrompt,
      runtime.cacheDir,
      runtime.modelCacheDir,
      runtime.kind,
    );

    console.log(`[HARNESS] Spawning ${agentId} with ${runtime.modelId} via ${runtime.kind}:${runtime.runnerBinaryPath}`);
    const child = spawn(runtime.runnerBinaryPath, args, {
      env: {
        ...process.env,
        HF_HOME: runtime.modelCacheDir,
        MLX_CACHE_DIR: runtime.cacheDir,
      },
    });

    activeAgents.set(agentId, { stop: (signal = "SIGTERM") => child.kill(signal) });
    broadcast({ type: "status", payload: `Spawned ${agentId} (${runtime.kind}:${runtime.modelId})` });

    child.stdout.on("data", (data: Buffer) => {
      broadcast({ type: "inference", agentId, payload: data.toString() });
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      if (isHfCacheNoise(text)) return;
      broadcast({ type: "error", agentId, payload: text });
    });

    child.on("error", (error) => {
      activeAgents.delete(agentId);
      broadcast({ type: "error", agentId, payload: error.message });
    });

    child.on("close", (code, signal) => {
      activeAgents.delete(agentId);
      broadcast({ type: "agent_exit", agentId, code, signal });
    });

    return;
  }

  console.log(`[HARNESS] Spawning ${agentId} with ${runtime.modelId} via ${runtime.kind}:${runtime.apiBaseUrl}`);
  const controller = new AbortController();
  const API_TIMEOUT_MS = 60_000;
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  activeAgents.set(agentId, { stop: () => { clearTimeout(timeoutId); controller.abort(); } });
  broadcast({ type: "status", payload: `Spawned ${agentId} (${runtime.kind}:${runtime.modelId})` });
  void runOpenAiCompatibleAgent(agentId, rolePrompt, runtime, controller, timeoutId);
}

async function runOpenAiCompatibleAgent(
  agentId: string,
  rolePrompt: string,
  runtime: OpenAiCompatibleRuntime,
  controller: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
) {
  let exitCode = 0;
  try {
    const { url, body } = buildOpenAiCompatibleRequest(runtime, rolePrompt);
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
    if (!response.ok) {
      throw new Error(`API runtime failed with HTTP ${response.status}: ${responseText}`);
    }
    const responseJson = JSON.parse(responseText) as unknown;
    broadcast({ type: "inference", agentId, payload: extractOpenAiCompatibleContent(responseJson) });
  } catch (error) {
    exitCode = 1;
    const payload = error instanceof Error && error.name === "AbortError"
      ? "API runtime aborted"
      : error instanceof Error ? error.message : String(error);
    broadcast({ type: "error", agentId, payload });
  } finally {
    clearTimeout(timeoutId);
    activeAgents.delete(agentId);
    broadcast({ type: "agent_exit", agentId, code: exitCode, signal: null });
  }
}

function connectLocalMCPServer(serverName: string, startCommand: string[]) {
  if (startCommand.length === 0 || !startCommand[0]) {
    throw new Error("MCP start command must include an executable");
  }
  if (mcpConnections.has(serverName)) {
    throw new Error(`MCP server ${serverName} is already connected`);
  }

  const [cmd, ...args] = startCommand;
  console.log(`[MCP] Connecting to local server: ${serverName}`);
  const mcpProcess = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

  mcpConnections.set(serverName, mcpProcess);
  mcpProcess.stdout.on("data", (data: Buffer) => {
    broadcast({ type: "mcp_response", server: serverName, payload: data.toString() });
  });
  mcpProcess.on("close", () => mcpConnections.delete(serverName));
  mcpProcess.on("error", (error) => {
    mcpConnections.delete(serverName);
    broadcast({ type: "error", payload: `[MCP:${serverName}] ${error.message}` });
  });

  return mcpProcess;
}

async function writeToSandbox(filename: string, content: string) {
  const safePath = createSandboxPath(filename, SANDBOX_ROOT);
  await Bun.write(safePath, content);
  return safePath;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function cors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}

serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      return cors(Response.json(healthPayload(activeAgents.size, mcpConnections.size, process.env)));
    }

    if (url.pathname === "/mcp/local-fs" && req.method === "POST") {
      connectLocalMCPServer("Local-FS-Server", ["/usr/bin/env", "bash", "-lc", "pwd"]);
      return cors(Response.json({ ok: true }));
    }

    if (server.upgrade(req, { headers: CORS_HEADERS })) return undefined;
    return cors(new Response("Bonsai Harness Online", { status: 200 }));
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
          spawnHarnessAgent(req.agentId, req.prompt, { modelId: req.modelId, runtimeKind: req.runtimeKind });
          return;
        }

        if (req.action === "send_message") {
          const chatId = `Chat-${Date.now().toString(36)}`;
          spawnHarnessAgent(chatId, req.payload);
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
    },
  },
});

function broadcast(msg: HarnessEvent) {
  const serialized = JSON.stringify(msg);
  for (const client of clients) {
    client.send(serialized);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHfCacheNoise(text: string): boolean {
  return text.includes("Fetching") && /\d+ file/.test(text)
    || /^\s*$/.test(text)
    || (text.includes("model.safetensors") && text.includes("%"));
}

process.on("SIGTERM", () => {
  for (const agent of activeAgents.values()) agent.stop("SIGTERM");
  for (const child of mcpConnections.values()) child.kill("SIGTERM");
  process.exit(0);
});

console.log(`Bonsai Harness listening on ws://localhost:${PORT}`);
console.log(`Health check available at http://localhost:${PORT}/health`);
