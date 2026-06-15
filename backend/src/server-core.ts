import { join, normalize, isAbsolute } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type ModelRuntimeKind = "local-command" | "openai-compatible" | "anthropic";

export const DEFAULT_PORT = 11431;
export const DEFAULT_MAX_ACTIVE_AGENTS = 2;
export const DEFAULT_SANDBOX_ROOT = "/Volumes/SanDisk1Tb/bonsai-harness/sandbox";
export const DEFAULT_RUNNER_BINARY_PATH = "/opt/homebrew/bin/mlx_lm";
export const DEFAULT_RUNNER_ARGS_TEMPLATE =
  "generate --model {{modelId}} --prompt {{prompt}} --verbose False";
export const DEFAULT_MODEL_CACHE_DIR = "/Volumes/SanDisk1Tb/HFModels";
export const DEFAULT_CACHE_DIR = "/Volumes/SanDisk1Tb/mlx-cache";
export const DEFAULT_MODEL_ID = "prism-ml/Ternary-Bonsai-8B-mlx-2bit";
export const DEFAULT_API_BASE_URL = "https://api.openai.com";
export const DEFAULT_API_PATH = "/v1/chat/completions";
export const DEFAULT_API_MAX_TOKENS = 256;
export const DEFAULT_API_TEMPERATURE = 0.2;
export const DEFAULT_RUNTIME_KIND: ModelRuntimeKind = "local-command";
export const DEFAULT_ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_API_MAX_TOKENS = 1024;
export const DEFAULT_ANTHROPIC_API_TEMPERATURE = 0.7;

export type LocalCommandRuntime = {
  kind: "local-command";
  modelId: string;
  runnerBinaryPath: string;
  runnerArgsTemplate: string;
  modelCacheDir: string;
  cacheDir: string;
};

export type OpenAiCompatibleRuntime = {
  kind: "openai-compatible";
  modelId: string;
  apiBaseUrl: string;
  apiPath: string;
  maxTokens: number;
  temperature: number;
};

export type AnthropicRuntime = {
  kind: "anthropic";
  modelId: string;
  apiBaseUrl: string;
  maxTokens: number;
  temperature: number;
};

export type ModelRuntime = LocalCommandRuntime | OpenAiCompatibleRuntime | AnthropicRuntime;

export type SpawnAgentMessage = {
  action: "spawn_agent";
  agentId: string;
  prompt: string;
  modelId?: string;
  runtimeKind?: ModelRuntimeKind;
};

export type WriteSandboxMessage = {
  action: "write_sandbox";
  filename: string;
  content: string;
};

export type SendMessage = {
  action: "send_message";
  payload: string;
  attachments?: { name: string; size: number; type: string }[];
};

export type StopGenerationMessage = {
  action: "stop_generation";
};

export type ClientMessage = SpawnAgentMessage | WriteSandboxMessage | SendMessage | StopGenerationMessage;

export type HarnessEvent =
  | { type: "status"; payload: string }
  | { type: "error"; payload: string; agentId?: string }
  | { type: "inference"; agentId: string; payload: string }
  | { type: "agent_exit"; agentId: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: "mcp_response"; server: string; payload: string }
  | { type: "sandbox_write"; path: string; payload: string };

type HarnessEnv = NodeJS.ProcessEnv | {
  PORT?: string | undefined;
  HARNESS_MODEL_ID?: string | undefined;
  HARNESS_RUNTIME_KIND?: string | undefined;
  HARNESS_RUNNER_BINARY?: string | undefined;
  HARNESS_RUNNER_ARGS_TEMPLATE?: string | undefined;
  HARNESS_MODEL_CACHE_DIR?: string | undefined;
  HARNESS_CACHE_DIR?: string | undefined;
  HARNESS_MAX_ACTIVE_AGENTS?: string | undefined;
  HARNESS_SANDBOX_ROOT?: string | undefined;
  HARNESS_API_BASE_URL?: string | undefined;
  HARNESS_API_PATH?: string | undefined;
  HARNESS_API_KEY?: string | undefined;
  HARNESS_API_MAX_TOKENS?: string | undefined;
  HARNESS_API_TEMPERATURE?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_API_BASE_URL?: string | undefined;
  ANTHROPIC_API_MAX_TOKENS?: string | undefined;
  ANTHROPIC_API_TEMPERATURE?: string | undefined;
};

export function resolvePort(env: HarnessEnv = process.env): number {
  return resolveBoundedNumber(env.PORT, DEFAULT_PORT, "PORT", 1, 65_535);
}

export function resolveMaxActiveAgents(env: HarnessEnv = process.env): number {
  return resolveBoundedNumber(env.HARNESS_MAX_ACTIVE_AGENTS, DEFAULT_MAX_ACTIVE_AGENTS, "HARNESS_MAX_ACTIVE_AGENTS", 1, 64);
}

export function resolveSandboxRoot(env: HarnessEnv = process.env): string {
  const raw = env.HARNESS_SANDBOX_ROOT?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SANDBOX_ROOT;
}

export function resolveDefaultModelId(env: HarnessEnv = process.env): string {
  return env.HARNESS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
}

export function resolveRuntimeKind(env: HarnessEnv = process.env): ModelRuntimeKind {
  const value = env.HARNESS_RUNTIME_KIND?.trim() || DEFAULT_RUNTIME_KIND;
  if (!isModelRuntimeKind(value)) {
    throw new Error(`Unsupported HARNESS_RUNTIME_KIND "${value}". Allowed: local-command, openai-compatible`);
  }
  return value;
}

export function isModelRuntimeKind(value: unknown): value is ModelRuntimeKind {
  return value === "local-command" || value === "openai-compatible" || value === "anthropic";
}

export function resolveModelRuntime(
  env: HarnessEnv = process.env,
  requested: { modelId?: string | undefined; runtimeKind?: ModelRuntimeKind | undefined } = {},
): ModelRuntime {
  const kind: ModelRuntimeKind = requested.runtimeKind ?? resolveRuntimeKind(env);
  const modelId = (requested.modelId?.trim() || resolveDefaultModelId(env));

  if (kind === "local-command") {
    return {
      kind,
      modelId,
      runnerBinaryPath: env.HARNESS_RUNNER_BINARY?.trim() || DEFAULT_RUNNER_BINARY_PATH,
      runnerArgsTemplate: env.HARNESS_RUNNER_ARGS_TEMPLATE?.trim() || DEFAULT_RUNNER_ARGS_TEMPLATE,
      modelCacheDir: env.HARNESS_MODEL_CACHE_DIR?.trim() || DEFAULT_MODEL_CACHE_DIR,
      cacheDir: env.HARNESS_CACHE_DIR?.trim() || DEFAULT_CACHE_DIR,
    };
  }

  if (kind === "anthropic") {
    const anthropicBaseUrl = env.ANTHROPIC_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_ANTHROPIC_API_BASE_URL;
    const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic runtime");
    const anthropicModelId = env.HARNESS_MODEL_ID?.trim() || modelId;
    return {
      kind,
      modelId: anthropicModelId,
      apiBaseUrl: anthropicBaseUrl,
      maxTokens: resolveBoundedNumber(env.ANTHROPIC_API_MAX_TOKENS, DEFAULT_ANTHROPIC_API_MAX_TOKENS, "ANTHROPIC_API_MAX_TOKENS", 1, 128_000),
      temperature: resolveBoundedNumber(env.ANTHROPIC_API_TEMPERATURE, DEFAULT_ANTHROPIC_API_TEMPERATURE, "ANTHROPIC_API_TEMPERATURE", 0, 2),
    };
  }

  const apiBaseUrl = env.HARNESS_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!apiBaseUrl) throw new Error("HARNESS_API_BASE_URL is required for openai-compatible runtime");
  const apiModelId = env.HARNESS_MODEL_ID?.trim() || modelId;
  const apiKey = env.HARNESS_API_KEY?.trim();
  if (!apiKey) throw new Error("HARNESS_API_KEY is required for openai-compatible runtime");

  return {
    kind,
    modelId: apiModelId,
    apiBaseUrl,
    apiPath: normalizeApiPath(env.HARNESS_API_PATH?.trim() || DEFAULT_API_PATH),
    maxTokens: resolveBoundedNumber(env.HARNESS_API_MAX_TOKENS, DEFAULT_API_MAX_TOKENS, "HARNESS_API_MAX_TOKENS", 1, 128_000),
    temperature: resolveBoundedNumber(env.HARNESS_API_TEMPERATURE, DEFAULT_API_TEMPERATURE, "HARNESS_API_TEMPERATURE", 0, 2),
  };
}

export function resolveApiKey(env: HarnessEnv = process.env): string {
  const apiKey = env.HARNESS_API_KEY?.trim();
  if (!apiKey) throw new Error("HARNESS_API_KEY is required for openai-compatible runtime");
  return apiKey;
}

export function resolveAnthropicApiKey(env: HarnessEnv = process.env): string {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic runtime");
  return apiKey;
}

function normalizeApiPath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

function resolveBoundedNumber(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined || raw === null || `${raw}`.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

export function assertExecutableExists(binaryPath: string): void {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Runner binary not found at ${binaryPath}. Set HARNESS_RUNNER_BINARY to the local runtime executable before spawning local-command agents.`,
    );
  }
}

export function assertSpawnCapacity(activeCount: number, maxAllowed: number): void {
  if (activeCount >= maxAllowed) {
    throw new Error(`Cannot spawn agent: ${activeCount}/${maxAllowed} active agents at capacity`);
  }
}

export function buildLocalCommandArguments(
  template: string,
  modelId: string,
  prompt: string,
  cacheDir: string,
  modelCacheDir: string,
  runtimeKind: ModelRuntimeKind,
): string[] {
  return template
    .split(/\s+/)
    .filter(Boolean)
    .map((token) =>
      token
        .replace(/\{\{modelId\}\}/g, modelId)
        .replace(/\{\{prompt\}\}/g, prompt)
        .replace(/\{\{cacheDir\}\}/g, cacheDir)
        .replace(/\{\{modelCacheDir\}\}/g, modelCacheDir)
        .replace(/\{\{runtimeKind\}\}/g, runtimeKind),
    );
}

export function buildOpenAiCompatibleRequest(runtime: OpenAiCompatibleRuntime, rolePrompt: string): {
  url: string; body: Record<string, unknown>;
} {
  return {
    url: `${runtime.apiBaseUrl}${runtime.apiPath}`,
    body: {
      model: runtime.modelId,
      max_tokens: runtime.maxTokens,
      temperature: runtime.temperature,
      messages: [{ role: "user", content: rolePrompt }],
    },
  };
}

export function buildAnthropicRequest(runtime: AnthropicRuntime, rolePrompt: string): {
  url: string; body: Record<string, unknown>; headers: Record<string, string>;
} {
  return {
    url: `${runtime.apiBaseUrl}/v1/messages`,
    body: {
      model: runtime.modelId,
      max_tokens: runtime.maxTokens,
      temperature: runtime.temperature,
      messages: [{ role: "user", content: rolePrompt }],
    },
    headers: {
      "x-api-key": "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  };
}

export function createSandboxPath(filename: string, sandboxRoot: string): string {
  if (!filename || filename.trim().length === 0) throw new Error("filename must be non-empty");
  const normalized = normalize(filename).replace(/^\.\.(\/|\\|$)/, "");
  if (isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error("filename must be a relative path within the sandbox");
  }
  const safeFilename = normalized.replace(/[^A-Za-z0-9._\-/]/g, "_");
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
    if (parsed.runtimeKind !== undefined && !isModelRuntimeKind(parsed.runtimeKind)) {
      throw new Error("spawn_agent runtimeKind must be one of: local-command, openai-compatible, anthropic");
    }
    return {
      action: "spawn_agent",
      agentId: parsed.agentId,
      prompt: parsed.prompt,
      ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
      ...(parsed.runtimeKind ? { runtimeKind: parsed.runtimeKind } : {}),
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

  if (parsed.action === "send_message") {
    if (typeof parsed.payload !== "string" || parsed.payload.trim().length === 0) {
      throw new Error("send_message requires a non-empty payload");
    }
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(isFileMetadata).map((a) => ({ name: String(a.name), size: Number(a.size), type: String(a.type) }))
      : undefined;
    return { action: "send_message", payload: parsed.payload, ...(attachments ? { attachments } : {}) };
  }

  if (parsed.action === "stop_generation") {
    return { action: "stop_generation" };
  }

  throw new Error("Unsupported client action");
}

export function healthPayload(activeAgents: number, mcpConnections: number, env: HarnessEnv = process.env) {
  const runtime = safeResolveRuntime(env);
  const basePayload = {
    ok: runtime.ok,
    service: "bonsai-harness",
    port: resolvePort(env),
    activeAgents,
    maxActiveAgents: resolveMaxActiveAgents(env),
    mcpConnections,
    modelId: runtime.runtime?.modelId ?? resolveDefaultModelId(env),
    runtimeKind: runtime.runtime?.kind ?? resolveRuntimeKind(env),
    sandboxRoot: resolveSandboxRoot(env),
    ...(runtime.error ? { error: runtime.error } : {}),
  };

  if (!runtime.runtime || runtime.runtime.kind === "local-command") {
    const localRuntime = runtime.runtime?.kind === "local-command" ? runtime.runtime : resolveModelRuntime({ ...env, HARNESS_RUNTIME_KIND: "local-command" }) as LocalCommandRuntime;
    return {
      ...basePayload,
      runnerBinaryPath: localRuntime.runnerBinaryPath,
      runnerBinaryPresent: existsSync(localRuntime.runnerBinaryPath),
      runnerArgsTemplate: localRuntime.runnerArgsTemplate,
      modelCacheDir: localRuntime.modelCacheDir,
      cacheDir: localRuntime.cacheDir,
    };
  }

  if (runtime.runtime.kind === "anthropic") {
    return {
      ...basePayload,
      apiBaseUrl: runtime.runtime.apiBaseUrl,
      apiMaxTokens: runtime.runtime.maxTokens,
      apiTemperature: runtime.runtime.temperature,
    };
  }

  return {
    ...basePayload,
    apiBaseUrl: runtime.runtime.apiBaseUrl,
    apiPath: runtime.runtime.apiPath,
    apiMaxTokens: runtime.runtime.maxTokens,
    apiTemperature: runtime.runtime.temperature,
  };
}

function safeResolveRuntime(env: HarnessEnv): { ok: boolean; runtime?: ModelRuntime; error?: string } {
  try {
    return { ok: true, runtime: resolveModelRuntime(env) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileMetadata(value: unknown): value is { name: string; size: number; type: string } {
  return isRecord(value) && typeof value.name === "string" && typeof value.size === "number" && typeof value.type === "string";
}

export type SettingsSnapshot = {
  runtimeKind: ModelRuntimeKind;
  modelId: string;
  openai: {
    apiBaseUrl: string;
    apiPath: string;
    maxTokens: number;
    temperature: number;
    apiKeySet: boolean;
  };
  anthropic: {
    apiBaseUrl: string;
    maxTokens: number;
    temperature: number;
    apiKeySet: boolean;
  };
};

export function readSettingsSnapshot(env: HarnessEnv = process.env): SettingsSnapshot {
  let runtimeKind: ModelRuntimeKind = DEFAULT_RUNTIME_KIND;
  try { runtimeKind = resolveRuntimeKind(env); } catch { /* use default */ }
  return {
    runtimeKind,
    modelId: resolveDefaultModelId(env),
    openai: {
      apiBaseUrl: env.HARNESS_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_API_BASE_URL,
      apiPath: normalizeApiPath(env.HARNESS_API_PATH?.trim() || DEFAULT_API_PATH),
      maxTokens: resolveBoundedNumber(env.HARNESS_API_MAX_TOKENS, DEFAULT_API_MAX_TOKENS, "HARNESS_API_MAX_TOKENS", 1, 128_000),
      temperature: resolveBoundedNumber(env.HARNESS_API_TEMPERATURE, DEFAULT_API_TEMPERATURE, "HARNESS_API_TEMPERATURE", 0, 2),
      apiKeySet: !!(env.HARNESS_API_KEY?.trim()),
    },
    anthropic: {
      apiBaseUrl: env.ANTHROPIC_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_ANTHROPIC_API_BASE_URL,
      maxTokens: resolveBoundedNumber(env.ANTHROPIC_API_MAX_TOKENS, DEFAULT_ANTHROPIC_API_MAX_TOKENS, "ANTHROPIC_API_MAX_TOKENS", 1, 128_000),
      temperature: resolveBoundedNumber(env.ANTHROPIC_API_TEMPERATURE, DEFAULT_ANTHROPIC_API_TEMPERATURE, "ANTHROPIC_API_TEMPERATURE", 0, 2),
      apiKeySet: !!(env.ANTHROPIC_API_KEY?.trim()),
    },
  };
}

export type SettingsUpdate = {
  runtimeKind?: ModelRuntimeKind;
  modelId?: string;
  openai?: {
    apiBaseUrl?: string;
    apiPath?: string;
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
  };
  anthropic?: {
    apiBaseUrl?: string;
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
  };
};

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

function writeEnvFile(path: string, values: Record<string, string>): void {
  const header = "# Bonsai Harness — Local Settings (managed by settings pane)\n# This file is gitignored. Do not commit.\n";
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, header + lines.join("\n") + "\n", "utf-8");
}

export function applySettingsUpdate(update: SettingsUpdate): SettingsSnapshot {
  const envFile = join(process.cwd(), ".env.local");
  const existing = readEnvFile(envFile);

  if (update.runtimeKind) { existing["HARNESS_RUNTIME_KIND"] = update.runtimeKind; process.env.HARNESS_RUNTIME_KIND = update.runtimeKind; }
  if (update.modelId !== undefined) { existing["HARNESS_MODEL_ID"] = update.modelId; process.env.HARNESS_MODEL_ID = update.modelId; }

  if (update.openai) {
    if (update.openai.apiBaseUrl !== undefined) { existing["HARNESS_API_BASE_URL"] = update.openai.apiBaseUrl; process.env.HARNESS_API_BASE_URL = update.openai.apiBaseUrl; }
    if (update.openai.apiPath !== undefined) { existing["HARNESS_API_PATH"] = update.openai.apiPath; process.env.HARNESS_API_PATH = update.openai.apiPath; }
    if (update.openai.apiKey) { existing["HARNESS_API_KEY"] = update.openai.apiKey; process.env.HARNESS_API_KEY = update.openai.apiKey; }
    if (update.openai.maxTokens !== undefined) { existing["HARNESS_API_MAX_TOKENS"] = String(update.openai.maxTokens); process.env.HARNESS_API_MAX_TOKENS = String(update.openai.maxTokens); }
    if (update.openai.temperature !== undefined) { existing["HARNESS_API_TEMPERATURE"] = String(update.openai.temperature); process.env.HARNESS_API_TEMPERATURE = String(update.openai.temperature); }
  }

  if (update.anthropic) {
    if (update.anthropic.apiBaseUrl !== undefined) { existing["ANTHROPIC_API_BASE_URL"] = update.anthropic.apiBaseUrl; process.env.ANTHROPIC_API_BASE_URL = update.anthropic.apiBaseUrl; }
    if (update.anthropic.apiKey) { existing["ANTHROPIC_API_KEY"] = update.anthropic.apiKey; process.env.ANTHROPIC_API_KEY = update.anthropic.apiKey; }
    if (update.anthropic.maxTokens !== undefined) { existing["ANTHROPIC_API_MAX_TOKENS"] = String(update.anthropic.maxTokens); process.env.ANTHROPIC_API_MAX_TOKENS = String(update.anthropic.maxTokens); }
    if (update.anthropic.temperature !== undefined) { existing["ANTHROPIC_API_TEMPERATURE"] = String(update.anthropic.temperature); process.env.ANTHROPIC_API_TEMPERATURE = String(update.anthropic.temperature); }
  }

  writeEnvFile(envFile, existing);
  return readSettingsSnapshot(process.env);
}
