import { serve, type ServerWebSocket } from "bun";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";

import {
  assertExecutableExists,
  assertSpawnCapacity,
  buildSpawnArguments,
  createSandboxPath,
  healthPayload,
  parseClientMessage,
  resolveDefaultModelId,
  resolvePort,
  resolveMaxActiveAgents,
  resolveMlxBinaryPath,
  resolveRunnerKind,
  resolveSandboxRoot,
  type HarnessEvent,
} from "./src/server-core";

type ClientSocket = ServerWebSocket<unknown>;

const PORT = resolvePort(process.env);
const MAX_ACTIVE_AGENTS = resolveMaxActiveAgents(process.env);
const clients = new Set<ClientSocket>();
const activeAgents = new Map<string, ChildProcessWithoutNullStreams>();
const mcpConnections = new Map<string, ChildProcessWithoutNullStreams>();

const SANDBOX_ROOT = resolveSandboxRoot(process.env);
await mkdir(SANDBOX_ROOT, { recursive: true });
await mkdir("/Volumes/SanDisk1Tb/bonsai-harness/logs", { recursive: true });

function spawnBonsaiInstance(agentId: string, rolePrompt: string, modelId = resolveDefaultModelId(process.env)) {
  if (activeAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already active`);
  }
  assertSpawnCapacity(activeAgents.size, MAX_ACTIVE_AGENTS);

  const mlxBinaryPath = resolveMlxBinaryPath(process.env);
  const runnerKind = resolveRunnerKind(process.env);
  assertExecutableExists(mlxBinaryPath);

  console.log(`[EXO] Spawning ${agentId} with ${modelId} via ${runnerKind}:${mlxBinaryPath}`);
  const bonsaiProcess = spawn(mlxBinaryPath, buildSpawnArguments(modelId, rolePrompt, runnerKind), {
    env: {
      ...process.env,
      // Keep tokenizer/model caches off the system disk when the real SLM runner is configured.
      HF_HOME: process.env.HF_HOME ?? "/Volumes/SanDisk1Tb/HFModels",
      MLX_CACHE_DIR: process.env.MLX_CACHE_DIR ?? "/Volumes/SanDisk1Tb/mlx-cache",
    },
  });

  activeAgents.set(agentId, bonsaiProcess);
  broadcast({ type: "status", payload: `Spawned ${agentId}` });

  bonsaiProcess.stdout.on("data", (data: Buffer) => {
    broadcast({ type: "inference", agentId, payload: data.toString() });
  });

  bonsaiProcess.stderr.on("data", (data: Buffer) => {
    broadcast({ type: "error", agentId, payload: data.toString() });
  });

  bonsaiProcess.on("error", (error) => {
    activeAgents.delete(agentId);
    broadcast({ type: "error", agentId, payload: error.message });
  });

  bonsaiProcess.on("close", (code, signal) => {
    activeAgents.delete(agentId);
    broadcast({ type: "agent_exit", agentId, code, signal });
  });

  return bonsaiProcess;
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

serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json(healthPayload(activeAgents.size, mcpConnections.size, process.env));
    }

    if (url.pathname === "/mcp/local-fs" && req.method === "POST") {
      connectLocalMCPServer("Local-FS-Server", ["/usr/bin/env", "bash", "-lc", "pwd"]);
      return Response.json({ ok: true });
    }

    if (server.upgrade(req)) return undefined;
    return new Response("Bonsai Harness Orchestrator Online", { status: 200 });
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
          spawnBonsaiInstance(req.agentId, req.prompt, req.modelId);
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

process.on("SIGTERM", () => {
  for (const child of activeAgents.values()) child.kill("SIGTERM");
  for (const child of mcpConnections.values()) child.kill("SIGTERM");
  process.exit(0);
});

console.log(`Enterprise Harness listening on ws://localhost:${PORT}`);
console.log(`Health check available at http://localhost:${PORT}/health`);
