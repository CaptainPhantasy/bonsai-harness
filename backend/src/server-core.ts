import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PORT = 11431;
export const DEFAULT_MODEL_ID = "prism-ml/Ternary-Bonsai-8B-mlx-2bit";
export const DEFAULT_MLX_BINARY_PATH = "/opt/homebrew/bin/mlx_lm.generate";
export const DEFAULT_SANDBOX_ROOT = "/Volumes/SanDisk1Tb/bonsai-harness/sandbox";
export const DEFAULT_MAX_ACTIVE_AGENTS = 2;
export const DEFAULT_RUNNER_KIND = "mlx-lm";

export type SpawnAgentMessage = {
  action: "spawn_agent";
  agentId: string;
  prompt: string;
  modelId?: string;
};

export type WriteSandboxMessage = {
  action: "write_sandbox";
  filename: string;
  content: string;
};

export type ClientMessage = SpawnAgentMessage | WriteSandboxMessage;

export type HarnessEvent =
  | { type: "status"; payload: string }
  | { type: "error"; payload: string; agentId?: string }
  | { type: "inference"; agentId: string; payload: string }
  | { type: "agent_exit"; agentId: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: "mcp_response"; server: string; payload: string }
  | { type: "sandbox_write"; path: string; payload: string };

export type RunnerKind = "mlx-lm" | "mlx-swift";

type HarnessEnv = NodeJS.ProcessEnv | {
  PORT?: string | undefined;
  MLX_BINARY_PATH?: string | undefined;
  BONSAI_MODEL_ID?: string | undefined;
  BONSAI_MAX_ACTIVE_AGENTS?: string | undefined;
  BONSAI_SANDBOX_ROOT?: string | undefined;
  BONSAI_RUNNER_KIND?: string | undefined;
};

export function resolvePort(env: HarnessEnv): number {
  const value = Number(env.PORT?.trim() || DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 10000 || value > 65535) {
    throw new Error("PORT must be an integer between 10000 and 65535");
  }
  return value;
}

export function resolveMlxBinaryPath(env: HarnessEnv): string {
  return env.MLX_BINARY_PATH?.trim() || DEFAULT_MLX_BINARY_PATH;
}

export function resolveDefaultModelId(env: HarnessEnv): string {
  return env.BONSAI_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
}

export function resolveRunnerKind(env: HarnessEnv): RunnerKind {
  const value = env.BONSAI_RUNNER_KIND?.trim() || DEFAULT_RUNNER_KIND;
  if (value === "mlx-lm" || value === "mlx-swift") {
    return value;
  }
  throw new Error("BONSAI_RUNNER_KIND must be one of: mlx-lm, mlx-swift");
}

export function resolveMaxActiveAgents(env: HarnessEnv): number {
  const value = Number(env.BONSAI_MAX_ACTIVE_AGENTS ?? DEFAULT_MAX_ACTIVE_AGENTS);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error("BONSAI_MAX_ACTIVE_AGENTS must be an integer between 1 and 16");
  }
  return value;
}

export function resolveSandboxRoot(env: HarnessEnv): string {
  return env.BONSAI_SANDBOX_ROOT?.trim() || DEFAULT_SANDBOX_ROOT;
}

export function assertExecutableExists(binaryPath: string): void {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `MLX binary not found at ${binaryPath}. Set MLX_BINARY_PATH to the SLM runner executable before spawning agents.`,
    );
  }
}

export function assertSpawnCapacity(activeAgents: number, maxActiveAgents: number): void {
  if (activeAgents >= maxActiveAgents) {
    throw new Error(`SLM spawn capacity reached (${activeAgents}/${maxActiveAgents}); wait for a worker to exit before spawning another.`);
  }
}

export function buildSpawnArguments(modelId: string, rolePrompt: string, runnerKind: RunnerKind = DEFAULT_RUNNER_KIND): string[] {
  if (runnerKind === "mlx-lm") {
    return ["--model", modelId, "--prompt", rolePrompt, "--verbose", "False"];
  }
  return ["eval", "--model", modelId, "--prompt", rolePrompt];
}

export function createSandboxPath(filename: string, sandboxRoot = DEFAULT_SANDBOX_ROOT): string {
  const safeFilename = filename.replace(/\.{2,}/g, "").replace(/[^a-zA-Z0-9.\-_]/g, "");
  if (safeFilename.length === 0) {
    throw new Error("Sandbox filename must contain at least one safe character");
  }
  return join(sandboxRoot, safeFilename);
}

export function parseClientMessage(message: string | Buffer): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.toString());
  } catch {
    throw new Error("Invalid JSON message");
  }

  if (!isRecord(parsed) || typeof parsed.action !== "string") {
    throw new Error("Client message must include an action");
  }

  if (parsed.action === "spawn_agent") {
    if (typeof parsed.agentId !== "string" || parsed.agentId.trim().length === 0) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }
    if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
      throw new Error("spawn_agent requires a non-empty prompt");
    }
    if (parsed.modelId !== undefined && typeof parsed.modelId !== "string") {
      throw new Error("spawn_agent modelId must be a string when provided");
    }
    return {
      action: "spawn_agent",
      agentId: parsed.agentId,
      prompt: parsed.prompt,
      ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
    };
  }

  if (parsed.action === "write_sandbox") {
    if (typeof parsed.filename !== "string" || parsed.filename.trim().length === 0) {
      throw new Error("write_sandbox requires a non-empty filename");
    }
    if (typeof parsed.content !== "string") {
      throw new Error("write_sandbox requires string content");
    }
    return {
      action: "write_sandbox",
      filename: parsed.filename,
      content: parsed.content,
    };
  }

  throw new Error("Unsupported client action");
}

export function healthPayload(activeAgents: number, mcpConnections: number, env: HarnessEnv = process.env) {
  const mlxBinaryPath = resolveMlxBinaryPath(env);
  return {
    ok: true,
    service: "bonsai-harness",
    port: resolvePort(env),
    activeAgents,
    maxActiveAgents: resolveMaxActiveAgents(env),
    mcpConnections,
    modelId: resolveDefaultModelId(env),
    mlxBinaryPath,
    mlxBinaryPresent: existsSync(mlxBinaryPath),
    sandboxRoot: resolveSandboxRoot(env),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
