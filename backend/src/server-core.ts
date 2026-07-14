import { join, normalize, isAbsolute, dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { isSafetyMode, type SafetyMode } from "./safety-modes";
import { isMediaMode, type MediaMode } from "./media-policy";

export type ModelRuntimeKind = "openai-compatible" | "anthropic";

export const DEFAULT_PORT = 11431;
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_MAX_ACTIVE_AGENTS = 2;
export const DEFAULT_SANDBOX_ROOT = "/Volumes/SanDisk1Tb/bonsai-harness/sandbox";
export const DEFAULT_PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
/**
 * Reserved per-project memory root. NEVER global (~/.bonsai). Decision 6
 * (LOCKED): memory is filesystem-scoped to project root, enforced by
 * filesystem ignorance, not policy prose.
 */
export const MEMORY_DIR_NAME = ".bonsai";
export const MEMORY_SUBDIR = "memory";
export const CONVERSATIONS_SUBDIR = "conversations";
export const DEFAULT_MODEL_ID = "gpt-4o-mini";
export const DEFAULT_API_BASE_URL = "https://api.openai.com";
export const DEFAULT_API_PATH = "/v1/chat/completions";
export const DEFAULT_API_MAX_TOKENS = 256;
export const DEFAULT_API_TEMPERATURE = 0.2;
export const DEFAULT_RUNTIME_KIND: ModelRuntimeKind = "openai-compatible";
export const DEFAULT_ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_API_MAX_TOKENS = 1024;
export const DEFAULT_ANTHROPIC_API_TEMPERATURE = 0.7;

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

export type ModelRuntime = OpenAiCompatibleRuntime | AnthropicRuntime;

export type SpawnAgentMessage = {
  action: "spawn_agent";
  agentId: string;
  prompt: string;
  modelId?: string;
  runtimeKind?: ModelRuntimeKind;
  safetyMode?: SafetyMode;
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
  safetyMode?: SafetyMode;
  /**
   * Media generation mode. Set ONLY by an explicit UI affordance (the
   * composer's "+" menu → pick Image / Video / Audio / Music). When
   * undefined, no media tools may run regardless of prompt phrasing.
   */
  mediaMode?: MediaMode;
};

export type StopGenerationMessage = {
  action: "stop_generation";
};

export type ResolveToolApprovalMessage = {
  action: "resolve_tool_approval";
  requestId: string;
  approved: boolean;
};

export type ClientMessage = SpawnAgentMessage | WriteSandboxMessage | SendMessage | StopGenerationMessage | ResolveToolApprovalMessage;

export type HarnessEvent =
  | { type: "status"; payload: string }
  | { type: "error"; payload: string; agentId?: string }
  | { type: "inference"; agentId: string; payload: string }
  | { type: "inference_delta"; agentId: string; payload: string; channel: "content" | "reasoning" }
  | { type: "agent_exit"; agentId: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: "mcp_response"; server: string; payload: string }
  | { type: "tool_approval_required"; requestId: string; agentId: string; server: string; tool: string; arguments: Record<string, unknown> }
  | { type: "sandbox_write"; path: string; payload: string };

export type HarnessEnv = NodeJS.ProcessEnv | {
  PORT?: string | undefined;
  HARNESS_BIND_HOST?: string | undefined;
  HARNESS_MODEL_ID?: string | undefined;
  HARNESS_RUNTIME_KIND?: string | undefined;
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
  HARNESS_BACKUP_API_BASE_URL?: string | undefined;
  HARNESS_BACKUP_API_PATH?: string | undefined;
  HARNESS_BACKUP_API_KEY?: string | undefined;
  HARNESS_BACKUP_MODEL_ID?: string | undefined;
  HARNESS_BACKUP_API_MAX_TOKENS?: string | undefined;
  HARNESS_BACKUP_API_TEMPERATURE?: string | undefined;
  HARNESS_PROJECT_ROOT?: string | undefined;
};

export function resolvePort(env: HarnessEnv = process.env): number {
  return resolveBoundedNumber(env.PORT, DEFAULT_PORT, "PORT", 1, 65_535);
}

export function resolveBindHost(env: HarnessEnv = process.env): string {
  const host = env.HARNESS_BIND_HOST?.trim() || DEFAULT_BIND_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && host !== "0.0.0.0") {
    throw new Error("HARNESS_BIND_HOST must be one of: 127.0.0.1, ::1, localhost, 0.0.0.0");
  }
  return host;
}

export function resolveMaxActiveAgents(env: HarnessEnv = process.env): number {
  return resolveBoundedNumber(env.HARNESS_MAX_ACTIVE_AGENTS, DEFAULT_MAX_ACTIVE_AGENTS, "HARNESS_MAX_ACTIVE_AGENTS", 1, 64);
}

export function resolveSandboxRoot(env: HarnessEnv = process.env): string {
  const raw = env.HARNESS_SANDBOX_ROOT?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SANDBOX_ROOT;
}

/**
 * Resolve and validate the project root. The project root scopes every
 * per-project artifact (memory, conversation logs, catalog) — it is locked
 * at module load (see PROJECT_ROOT below) and never re-read at request time.
 *
 * Validation:
 *   - Must be absolute (relative roots would resolve against CWD, which is
 *     not deterministic across launch contexts).
 *   - Must exist and be a directory.
 *   - Must contain either a package.json or a FLOYD.md marker — guards
 *     against accidentally pointing at a parent or sibling directory.
 *
 * Honors HARNESS_PROJECT_ROOT when set; otherwise resolves the repository root
 * from this module. Production launchers may still set HARNESS_PROJECT_ROOT;
 * the module-relative fallback keeps clean checkouts and CI portable.
 */
export function resolveProjectRoot(env: HarnessEnv = process.env): string {
  const raw = env.HARNESS_PROJECT_ROOT?.trim() || DEFAULT_PROJECT_ROOT;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  if (!existsSync(absolute)) {
    throw new Error(`HARNESS_PROJECT_ROOT does not exist: ${absolute}`);
  }
  let stat;
  try {
    stat = statSync(absolute);
  } catch (error) {
    throw new Error(`HARNESS_PROJECT_ROOT is not stat-able: ${absolute} (${String(error)})`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`HARNESS_PROJECT_ROOT must be a directory: ${absolute}`);
  }
  const hasMarker = existsSync(join(absolute, "package.json")) || existsSync(join(absolute, "FLOYD.md"));
  if (!hasMarker) {
    throw new Error(`HARNESS_PROJECT_ROOT must contain package.json or FLOYD.md: ${absolute}`);
  }
  return absolute;
}

/**
 * The resolved project root, captured at module load. This is the ONLY
 * project root the rest of the runtime may consult. Tests that need a
 * different root pass an explicit env to resolveProjectRoot(); they do NOT
 * reassign this const.
 */
export const PROJECT_ROOT: string = resolveProjectRoot(process.env as HarnessEnv);

/**
 * Accessor for PROJECT_ROOT. Provided so callers express intent ("get the
 * locked root") rather than reaching into a top-level const.
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function resolveDefaultModelId(env: HarnessEnv = process.env): string {
  return env.HARNESS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
}

export function resolveRuntimeKind(env: HarnessEnv = process.env): ModelRuntimeKind {
  const value = env.HARNESS_RUNTIME_KIND?.trim() || DEFAULT_RUNTIME_KIND;
  if (!isModelRuntimeKind(value)) {
    throw new Error(`Unsupported HARNESS_RUNTIME_KIND "${value}". Allowed: openai-compatible, anthropic`);
  }
  return value;
}

export function isModelRuntimeKind(value: unknown): value is ModelRuntimeKind {
  return value === "openai-compatible" || value === "anthropic";
}

export function resolveModelRuntime(
  env: HarnessEnv = process.env,
  requested: { modelId?: string | undefined; runtimeKind?: ModelRuntimeKind | undefined } = {},
): ModelRuntime {
  const kind: ModelRuntimeKind = requested.runtimeKind ?? resolveRuntimeKind(env);
  const modelId = requested.modelId?.trim() || resolveDefaultModelId(env);

  if (kind === "anthropic") {
    const anthropicBaseUrl = env.ANTHROPIC_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_ANTHROPIC_API_BASE_URL;
    const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic runtime");
    return {
      kind,
      modelId,
      apiBaseUrl: anthropicBaseUrl,
      maxTokens: resolveBoundedNumber(env.ANTHROPIC_API_MAX_TOKENS, DEFAULT_ANTHROPIC_API_MAX_TOKENS, "ANTHROPIC_API_MAX_TOKENS", 1, 128_000),
      temperature: resolveBoundedNumber(env.ANTHROPIC_API_TEMPERATURE, DEFAULT_ANTHROPIC_API_TEMPERATURE, "ANTHROPIC_API_TEMPERATURE", 0, 2),
    };
  }

  const apiBaseUrl = env.HARNESS_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!apiBaseUrl) throw new Error("HARNESS_API_BASE_URL is required for openai-compatible runtime");
  const apiKey = env.HARNESS_API_KEY?.trim();
  if (!apiKey) throw new Error("HARNESS_API_KEY is required for openai-compatible runtime");

  return {
    kind,
    modelId,
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

/**
 * Built-in backup OpenAI-compatible runtime. Returns null when no backup is
 * configured (no HARNESS_BACKUP_API_BASE_URL). When a base URL is set, the key
 * is required. Used for primary→backup failover in the OpenAI-compatible agent.
 */
export function resolveBackupOpenAiRuntime(env: HarnessEnv = process.env): OpenAiCompatibleRuntime | null {
  const apiBaseUrl = env.HARNESS_BACKUP_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!apiBaseUrl) return null;
  const apiKey = env.HARNESS_BACKUP_API_KEY?.trim();
  if (!apiKey) throw new Error("HARNESS_BACKUP_API_KEY is required when HARNESS_BACKUP_API_BASE_URL is set");
  return {
    kind: "openai-compatible",
    modelId: env.HARNESS_BACKUP_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    apiBaseUrl,
    apiPath: normalizeApiPath(env.HARNESS_BACKUP_API_PATH?.trim() || DEFAULT_API_PATH),
    maxTokens: resolveBoundedNumber(env.HARNESS_BACKUP_API_MAX_TOKENS, DEFAULT_API_MAX_TOKENS, "HARNESS_BACKUP_API_MAX_TOKENS", 1, 128_000),
    temperature: resolveBoundedNumber(env.HARNESS_BACKUP_API_TEMPERATURE, DEFAULT_API_TEMPERATURE, "HARNESS_BACKUP_API_TEMPERATURE", 0, 2),
  };
}

export function resolveBackupApiKey(env: HarnessEnv = process.env): string {
  const apiKey = env.HARNESS_BACKUP_API_KEY?.trim();
  if (!apiKey) throw new Error("HARNESS_BACKUP_API_KEY is required for backup runtime");
  return apiKey;
}

function normalizeApiPath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

export function resolveOpenAiApiPath(baseUrl: string, apiPath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = normalizeApiPath(apiPath);

  if (normalizedPath === "/") {
    return `${normalizedBase}/`;
  }

  const baseEndsWithV1 = /\/v1$/.test(normalizedBase);
  if (baseEndsWithV1 && normalizedPath.startsWith("/v1/")) {
    return `${normalizedBase}${normalizedPath.slice(3)}`;
  }

  return `${normalizedBase}${normalizedPath}`;
}

function resolveBoundedNumber(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined || raw === null || `${raw}`.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

export function assertSpawnCapacity(activeCount: number, maxAllowed: number): void {
  if (activeCount >= maxAllowed) {
    throw new Error(`Cannot spawn agent: ${activeCount}/${maxAllowed} active agents at capacity`);
  }
}

export function buildOpenAiCompatibleRequest(runtime: OpenAiCompatibleRuntime, rolePrompt: string): {
  url: string; body: Record<string, unknown>;
} {
  return buildOpenAiCompatibleConversationRequest(runtime, [{ role: "user", content: rolePrompt }]);
}

export type ProviderToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function buildOpenAiCompatibleConversationRequest(
  runtime: OpenAiCompatibleRuntime,
  messages: Record<string, unknown>[],
  tools: ProviderToolDefinition[] = [],
): { url: string; body: Record<string, unknown> } {
  return {
    url: resolveOpenAiApiPath(runtime.apiBaseUrl, runtime.apiPath),
    body: {
      model: runtime.modelId,
      max_tokens: runtime.maxTokens,
      temperature: runtime.temperature,
      messages,
      ...(tools.length > 0 ? {
        tools: tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
        tool_choice: "auto",
      } : {}),
    },
  };
}

export function buildAnthropicRequest(runtime: AnthropicRuntime, rolePrompt: string): {
  url: string; body: Record<string, unknown>; headers: Record<string, string>;
} {
  return buildAnthropicConversationRequest(runtime, [{ role: "user", content: rolePrompt }]);
}

export function buildAnthropicConversationRequest(
  runtime: AnthropicRuntime,
  messages: Record<string, unknown>[],
  tools: ProviderToolDefinition[] = [],
): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
  return {
    url: `${runtime.apiBaseUrl}/v1/messages`,
    body: {
      model: runtime.modelId,
      max_tokens: runtime.maxTokens,
      temperature: runtime.temperature,
      messages,
      ...(tools.length > 0 ? {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      } : {}),
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

/**
 * Resolve a path inside the per-project memory directory
 * (`<projectRoot>/.bonsai/memory/<relativePath>`).
 *
 * Same containment discipline as createSandboxPath, but rooted at the
 * project-scoped memory tree. Used by conversation logging (I-06) and any
 * future per-project memory artifact. Rejects absolute paths, `..`
 * traversal, and empty input. The caller is responsible for mkdirSync on
 * the returned path's parent (resolved paths are not auto-created here so
 * that read paths can be checked without side effects).
 *
 * Decision 6 (LOCKED): memory is filesystem-scoped to PROJECT_ROOT, never
 * global. This function is the ONLY sanctioned entry point for memory
 * paths; constructing them by hand is a governance failure.
 */
export function resolveMemoryPath(relativePath: string, projectRoot: string = PROJECT_ROOT): string {
  if (!relativePath || relativePath.trim().length === 0) {
    throw new Error("memory relativePath must be non-empty");
  }
  const normalized = normalize(relativePath).replace(/^\.\.(\/|\\|$)/, "");
  if (isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error("memory relativePath must be a relative path within the project memory root");
  }
  const safeRelative = normalized.replace(/[^A-Za-z0-9._\-/]/g, "_");
  return join(projectRoot, MEMORY_DIR_NAME, MEMORY_SUBDIR, safeRelative);
}

/**
 * Returns the absolute path to the memory root for the given project.
 * Convenience for callers that need to mkdirSync the tree before writing.
 */
export function getMemoryRoot(projectRoot: string = PROJECT_ROOT): string {
  return join(projectRoot, MEMORY_DIR_NAME, MEMORY_SUBDIR);
}

/**
 * Returns the absolute path to the conversations subdirectory.
 */
export function getConversationsDir(projectRoot: string = PROJECT_ROOT): string {
  return join(projectRoot, MEMORY_DIR_NAME, MEMORY_SUBDIR, CONVERSATIONS_SUBDIR);
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
      throw new Error("spawn_agent runtimeKind must be one of: openai-compatible, anthropic");
    }
    if (parsed.safetyMode !== undefined && !isSafetyMode(parsed.safetyMode)) {
      throw new Error("spawn_agent safetyMode must be one of: plan, ask, auto, yolo");
    }
    return {
      action: "spawn_agent",
      agentId: parsed.agentId,
      prompt: parsed.prompt,
      ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
      ...(parsed.runtimeKind ? { runtimeKind: parsed.runtimeKind } : {}),
      ...(parsed.safetyMode ? { safetyMode: parsed.safetyMode } : {}),
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
    if (parsed.safetyMode !== undefined && !isSafetyMode(parsed.safetyMode)) {
      throw new Error("send_message safetyMode must be one of: plan, ask, auto, yolo");
    }
    if (parsed.mediaMode !== undefined && !isMediaMode(parsed.mediaMode)) {
      throw new Error("send_message mediaMode must be one of: image, video, audio, music");
    }
    return {
      action: "send_message",
      payload: parsed.payload,
      ...(attachments ? { attachments } : {}),
      ...(parsed.safetyMode ? { safetyMode: parsed.safetyMode } : {}),
      ...(parsed.mediaMode ? { mediaMode: parsed.mediaMode } : {}),
    };
  }

  if (parsed.action === "stop_generation") {
    return { action: "stop_generation" };
  }

  if (parsed.action === "resolve_tool_approval") {
    if (typeof parsed.requestId !== "string" || parsed.requestId.trim().length === 0) {
      throw new Error("resolve_tool_approval requires a non-empty requestId");
    }
    if (typeof parsed.approved !== "boolean") {
      throw new Error("resolve_tool_approval requires an approved boolean");
    }
    return { action: "resolve_tool_approval", requestId: parsed.requestId, approved: parsed.approved };
  }

  throw new Error("Unsupported client action");
}

export function healthPayload(activeAgents: number, mcpConnections: number, env: HarnessEnv = process.env) {
  const runtime = safeResolveRuntime(env);
  const settings = readSettingsSnapshot(env);
  const basePayload = {
    ok: runtime.ok,
    service: "bonsai-harness",
    port: resolvePort(env),
    activeAgents,
    maxActiveAgents: resolveMaxActiveAgents(env),
    mcpConnections,
    modelId: runtime.runtime?.modelId ?? settings.modelId,
    runtimeKind: runtime.runtime?.kind ?? settings.runtimeKind,
    sandboxRoot: resolveSandboxRoot(env),
    ...(runtime.error ? { error: runtime.error } : {}),
  };

  if (settings.runtimeKind === "anthropic") {
    return {
      ...basePayload,
      apiBaseUrl: runtime.runtime?.kind === "anthropic" ? runtime.runtime.apiBaseUrl : settings.anthropic.apiBaseUrl,
      apiMaxTokens: runtime.runtime?.kind === "anthropic" ? runtime.runtime.maxTokens : settings.anthropic.maxTokens,
      apiTemperature: runtime.runtime?.kind === "anthropic" ? runtime.runtime.temperature : settings.anthropic.temperature,
    };
  }

  return {
    ...basePayload,
    apiBaseUrl: runtime.runtime?.kind === "openai-compatible" ? runtime.runtime.apiBaseUrl : settings.openai.apiBaseUrl,
    apiPath: runtime.runtime?.kind === "openai-compatible" ? runtime.runtime.apiPath : settings.openai.apiPath,
    apiMaxTokens: runtime.runtime?.kind === "openai-compatible" ? runtime.runtime.maxTokens : settings.openai.maxTokens,
    apiTemperature: runtime.runtime?.kind === "openai-compatible" ? runtime.runtime.temperature : settings.openai.temperature,
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
  const header = "# Harness local settings (managed by the settings pane)\n# This file is gitignored. Do not commit.\n";
  const lines = Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, header + lines.join("\n") + "\n", "utf-8");
}

export function parseSettingsUpdate(value: unknown): SettingsUpdate {
  if (!isRecord(value)) throw new Error("Settings update must be a JSON object");

  const update: SettingsUpdate = {};
  if (value.runtimeKind !== undefined) {
    if (!isModelRuntimeKind(value.runtimeKind)) throw new Error("runtimeKind must be one of: openai-compatible, anthropic");
    update.runtimeKind = value.runtimeKind;
  }
  if (value.modelId !== undefined) update.modelId = parseEnvironmentValue(value.modelId, "modelId", 256, true);
  if (value.openai !== undefined) update.openai = parseOpenAiSettings(value.openai);
  if (value.anthropic !== undefined) update.anthropic = parseAnthropicSettings(value.anthropic);

  return update;
}

export function applySettingsUpdate(value: unknown): SettingsSnapshot {
  const update = parseSettingsUpdate(value);
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

function parseOpenAiSettings(value: unknown): NonNullable<SettingsUpdate["openai"]> {
  if (!isRecord(value)) throw new Error("openai settings must be an object");
  const settings: NonNullable<SettingsUpdate["openai"]> = {};
  if (value.apiBaseUrl !== undefined) settings.apiBaseUrl = parseProviderBaseUrl(value.apiBaseUrl, "openai.apiBaseUrl");
  if (value.apiPath !== undefined) settings.apiPath = parseApiPath(value.apiPath);
  if (value.apiKey !== undefined) settings.apiKey = parseEnvironmentValue(value.apiKey, "openai.apiKey", 8_192, false);
  if (value.maxTokens !== undefined) settings.maxTokens = parseBoundedNumber(value.maxTokens, "openai.maxTokens", 1, 128_000);
  if (value.temperature !== undefined) settings.temperature = parseBoundedNumber(value.temperature, "openai.temperature", 0, 2);
  return settings;
}

function parseAnthropicSettings(value: unknown): NonNullable<SettingsUpdate["anthropic"]> {
  if (!isRecord(value)) throw new Error("anthropic settings must be an object");
  const settings: NonNullable<SettingsUpdate["anthropic"]> = {};
  if (value.apiBaseUrl !== undefined) settings.apiBaseUrl = parseProviderBaseUrl(value.apiBaseUrl, "anthropic.apiBaseUrl");
  if (value.apiKey !== undefined) settings.apiKey = parseEnvironmentValue(value.apiKey, "anthropic.apiKey", 8_192, false);
  if (value.maxTokens !== undefined) settings.maxTokens = parseBoundedNumber(value.maxTokens, "anthropic.maxTokens", 1, 128_000);
  if (value.temperature !== undefined) settings.temperature = parseBoundedNumber(value.temperature, "anthropic.temperature", 0, 2);
  return settings;
}

function parseEnvironmentValue(value: unknown, field: string, maxLength: number, nonEmpty: boolean): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if ((nonEmpty && normalized.length === 0) || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${field} must be ${nonEmpty ? "a non-empty " : ""}single-line value up to ${maxLength} characters`);
  }
  return normalized;
}

function parseProviderBaseUrl(value: unknown, field: string): string {
  const raw = parseEnvironmentValue(value, field, 2_048, true);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid http or https URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${field} must be an http or https URL without credentials, query, or fragment`);
  }
  return raw.replace(/\/+$/, "");
}

function parseApiPath(value: unknown): string {
  const path = parseEnvironmentValue(value, "openai.apiPath", 512, true);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#") || path.includes("\\")) {
    throw new Error("openai.apiPath must be an absolute path without query, fragment, or backslash");
  }
  return path;
}

function parseBoundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}
