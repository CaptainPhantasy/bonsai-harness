import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROJECT_ROOT,
  assertSpawnCapacity,
  buildAnthropicRequest,
  buildAnthropicConversationRequest,
  buildOpenAiCompatibleRequest,
  buildOpenAiCompatibleConversationRequest,
  createSandboxPath,
  healthPayload,
  isModelRuntimeKind,
  parseClientMessage,
  readSettingsSnapshot,
  resolveAnthropicApiKey,
  resolveBindHost,
  resolveDefaultModelId,
  resolveMaxActiveAgents,
  resolveModelRuntime,
  resolvePort,
  resolveProjectRoot,
  resolveSandboxRoot,
  resolveMemoryPath,
  getMemoryRoot,
  getConversationsDir,
  resolveOpenAiApiPath,
  parseSettingsUpdate,
  type ModelRuntimeKind,
} from "../src/server-core";

describe("server core", () => {
  test("createSandboxPath strips traversal and shell metacharacters", () => {
    const path = createSandboxPath("../semi;bad$(name).json", "/tmp/bonsai-sandbox");

    expect(path).toBe("/tmp/bonsai-sandbox/semi_bad__name_.json");
  });

  test("createSandboxPath rejects filenames that sanitize to empty", () => {
    expect(() => createSandboxPath("../../../", "/tmp/bonsai-sandbox")).toThrow(
      "filename must be a relative path within the sandbox",
    );
  });

  test("parseClientMessage accepts arbitrary model and runtime override in spawn requests", () => {
    const message = parseClientMessage(
      JSON.stringify({
        action: "spawn_agent",
        agentId: "Worker-2",
        prompt: "You are deterministic.",
        modelId: "vendor/any-model",
        runtimeKind: "openai-compatible" satisfies ModelRuntimeKind,
      }),
    );

    expect(message).toEqual({
      action: "spawn_agent",
      agentId: "Worker-2",
      prompt: "You are deterministic.",
      modelId: "vendor/any-model",
      runtimeKind: "openai-compatible",
    });
  });

  test("parseClientMessage rejects malformed JSON, unknown actions, and invalid runtime kinds", () => {
    expect(() => parseClientMessage("not json")).toThrow("Invalid JSON message");
    expect(() => parseClientMessage(JSON.stringify({ action: "rm_rf" }))).toThrow(
      "Unsupported client action",
    );
    expect(() => parseClientMessage(JSON.stringify({
      action: "spawn_agent",
      agentId: "Worker-2",
      prompt: "Run",
      runtimeKind: "bonsai-only",
    }))).toThrow("spawn_agent runtimeKind must be one of: openai-compatible, anthropic");
  });

  test("parseClientMessage accepts stop_generation action", () => {
    const message = parseClientMessage(JSON.stringify({ action: "stop_generation" }));
    expect(message).toEqual({ action: "stop_generation" });
  });

  test("parseClientMessage validates MCP safety modes and approval resolution", () => {
    expect(parseClientMessage(JSON.stringify({
      action: "spawn_agent",
      agentId: "ToolWorker",
      prompt: "Use connected tools safely",
      safetyMode: "ask",
    }))).toMatchObject({ action: "spawn_agent", safetyMode: "ask" });
    expect(parseClientMessage(JSON.stringify({
      action: "resolve_tool_approval",
      requestId: "approval-1",
      approved: true,
    }))).toEqual({ action: "resolve_tool_approval", requestId: "approval-1", approved: true });
    expect(() => parseClientMessage(JSON.stringify({ action: "resolve_tool_approval", requestId: "", approved: true }))).toThrow("requestId");
    expect(() => parseClientMessage(JSON.stringify({ action: "send_message", payload: "Run", safetyMode: "unsafe" }))).toThrow("safetyMode");
  });

  test("parseClientMessage passes through file attachments in send_message", () => {
    const message = parseClientMessage(JSON.stringify({
      action: "send_message",
      payload: "Review these files",
      attachments: [
        { name: "main.ts", size: 1024, type: "text/typescript" },
        { name: "config.json", size: 512, type: "application/json" },
      ],
    }));
    if (message.action === "send_message") {
      expect(message.payload).toBe("Review these files");
      expect(message.attachments).toEqual([
        { name: "main.ts", size: 1024, type: "text/typescript" },
        { name: "config.json", size: 512, type: "application/json" },
      ]);
    } else {
      throw new Error("Expected send_message action");
    }
  });

  test("resolveDefaultModelId uses a provider-neutral default and supports an env override", () => {
    expect(resolveDefaultModelId({})).toBe("gpt-4o-mini");
    expect(resolveDefaultModelId({ HARNESS_MODEL_ID: "local/slm" })).toBe("local/slm");
  });

  test("resolveModelRuntime supports OpenAI-compatible API runtime without exposing the API key", () => {
    expect(resolveModelRuntime({
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_MODEL_ID: "openai/gpt-test",
      HARNESS_API_BASE_URL: "https://api.example.test/",
      HARNESS_API_KEY: "secret-key",
    })).toEqual({
      kind: "openai-compatible",
      modelId: "openai/gpt-test",
      apiBaseUrl: "https://api.example.test",
      apiPath: "/v1/chat/completions",

      maxTokens: 256,
      temperature: 0.2,
    });
  });

  test("resolveModelRuntime rejects incomplete API configuration", () => {
    expect(() => resolveModelRuntime({ HARNESS_RUNTIME_KIND: "openai-compatible" })).toThrow(
      "HARNESS_API_BASE_URL is required for openai-compatible runtime",
    );
    expect(() => resolveModelRuntime({
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_API_BASE_URL: "https://api.example.test",
    })).toThrow("HARNESS_API_KEY is required for openai-compatible runtime");
  });

  test("resolvePort defaults to the claimed beta port and accepts valid ports", () => {
    expect(resolvePort({})).toBe(11431);
    expect(resolvePort({ PORT: "11432" })).toBe(11432);
    expect(resolvePort({ PORT: "3000" })).toBe(3000);
    expect(() => resolvePort({ PORT: "0" })).toThrow(
      "PORT must be between 1 and 65535",
    );
    expect(() => resolvePort({ PORT: "70000" })).toThrow(
      "PORT must be between 1 and 65535",
    );
  });

  test("resolveBindHost defaults to loopback and rejects an accidental network bind", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ HARNESS_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(() => resolveBindHost({ HARNESS_BIND_HOST: "192.168.1.25" })).toThrow("HARNESS_BIND_HOST");
  });

  test("resolveSandboxRoot supports generic container and launchd overrides", () => {
    expect(resolveSandboxRoot({ HARNESS_SANDBOX_ROOT: "/tmp/harness-container" })).toBe(
      "/tmp/harness-container",
    );
  });

  test("resolveMaxActiveAgents enforces bounded model concurrency", () => {
    expect(resolveMaxActiveAgents({ HARNESS_MAX_ACTIVE_AGENTS: "3" })).toBe(3);
    expect(() => resolveMaxActiveAgents({ HARNESS_MAX_ACTIVE_AGENTS: "0" })).toThrow(
      "HARNESS_MAX_ACTIVE_AGENTS must be between 1 and 64",
    );
    expect(() => assertSpawnCapacity(2, 2)).toThrow("active agents at capacity");
  });

  test("buildOpenAiCompatibleRequest creates request metadata without leaking server-side API key", () => {
    expect(buildOpenAiCompatibleRequest(
      {
        kind: "openai-compatible",
        modelId: "openai/gpt-test",
        apiBaseUrl: "https://api.example.test",
        apiPath: "/v1/chat/completions",
        maxTokens: 16,
        temperature: 0.1,
      },
      "Write a concise answer.",
    )).toEqual({
      url: "https://api.example.test/v1/chat/completions",
      body: {
        model: "openai/gpt-test",
        messages: [{ role: "user", content: "Write a concise answer." }],
        max_tokens: 16,
        temperature: 0.1,
      },
    });
  });

  test("provider conversation builders translate connected MCP tools into both provider contracts", () => {
    const tools = [{ name: "fixture__read_note", description: "Read a note", inputSchema: { type: "object", properties: {} } }];
    const openai = buildOpenAiCompatibleConversationRequest({
      kind: "openai-compatible",
      modelId: "test-model",
      apiBaseUrl: "https://api.example.test",
      apiPath: "/v1/chat/completions",
      maxTokens: 32,
      temperature: 0.2,
    }, [{ role: "user", content: "Read the note" }], tools);
    const anthropic = buildAnthropicConversationRequest({
      kind: "anthropic",
      modelId: "test-model",
      apiBaseUrl: "https://api.example.test",
      maxTokens: 32,
      temperature: 0.2,
    }, [{ role: "user", content: "Read the note" }], tools);

    expect(openai.body.tools).toEqual([{ type: "function", function: { name: "fixture__read_note", description: "Read a note", parameters: { type: "object", properties: {} } } }]);
    expect(openai.body.tool_choice).toBe("auto");
    expect(anthropic.body.tools).toEqual([{ name: "fixture__read_note", description: "Read a note", input_schema: { type: "object", properties: {} } }]);
  });

  test("resolveOpenAiApiPath avoids double /v1 when base already includes /v1", () => {
    expect(resolveOpenAiApiPath("https://opencode.ai/zen/v1", "/v1/chat/completions")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(resolveOpenAiApiPath("https://opencode.ai/zen/v1", "/chat/completions")).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("healthPayload reports generic runtime state without API secrets", () => {
    expect(healthPayload(1, 0, {
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_MODEL_ID: "smoke/api",
      HARNESS_MAX_ACTIVE_AGENTS: "1",
      HARNESS_API_BASE_URL: "https://api.example.test",
      HARNESS_API_KEY: "super-secret",
      PORT: "11431",
      HARNESS_SANDBOX_ROOT: "/tmp/harness-smoke",
    })).toMatchObject({
      ok: true,
      service: "bonsai-harness",
      port: 11431,
      activeAgents: 1,
      maxActiveAgents: 1,
      modelId: "smoke/api",
      runtimeKind: "openai-compatible",
      apiBaseUrl: "https://api.example.test",
      sandboxRoot: "/tmp/harness-smoke",
    });
    expect(JSON.stringify(healthPayload(0, 0, {
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_API_BASE_URL: "https://api.example.test",
      HARNESS_API_KEY: "super-secret",
    }))).not.toContain("super-secret");
  });

  test("resolveModelRuntime supports Anthropic API runtime without exposing the API key", () => {
    const runtime = resolveModelRuntime({
      HARNESS_RUNTIME_KIND: "anthropic",
      HARNESS_MODEL_ID: "claude-sonnet-4-20250514",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      ANTHROPIC_API_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_MAX_TOKENS: "2048",
      ANTHROPIC_API_TEMPERATURE: "0.5",
    });
    expect(runtime.kind).toBe("anthropic");
    if (runtime.kind === "anthropic") {
      expect(runtime.modelId).toBe("claude-sonnet-4-20250514");
      expect(runtime.apiBaseUrl).toBe("https://api.anthropic.com");
      expect(runtime.maxTokens).toBe(2048);
      expect(runtime.temperature).toBe(0.5);
      expect("apiKey" in runtime).toBe(false);
      expect(JSON.stringify(runtime)).not.toContain("sk-ant-test-key");
    }
  });

  test("resolveModelRuntime rejects Anthropic runtime without ANTHROPIC_API_KEY", () => {
    expect(() => resolveModelRuntime({ HARNESS_RUNTIME_KIND: "anthropic" })).toThrow("ANTHROPIC_API_KEY");
  });

  test("resolveAnthropicApiKey throws when missing and returns when present", () => {
    expect(() => resolveAnthropicApiKey({})).toThrow("ANTHROPIC_API_KEY");
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("sk-ant-test");
  });

  test("buildAnthropicRequest creates request metadata without leaking API key", () => {
    const { url, body, headers } = buildAnthropicRequest(
      { kind: "anthropic", modelId: "claude-sonnet-4-20250514", apiBaseUrl: "https://api.anthropic.com", maxTokens: 1024, temperature: 0.7 },
      "Hello Claude",
    );
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: "user", content: "Hello Claude" }]);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBe("");
  });

  test("isModelRuntimeKind accepts anthropic as a valid runtime kind", () => {
    expect(isModelRuntimeKind("anthropic")).toBe(true);
    expect(isModelRuntimeKind("openai-compatible")).toBe(true);
    expect(isModelRuntimeKind("invalid")).toBe(false);
  });

  test("readSettingsSnapshot reports key status without exposing actual keys", () => {
    const snapshot = readSettingsSnapshot({
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_MODEL_ID: "gpt-4o-mini",
      HARNESS_API_KEY: "sk-super-secret-key",
      HARNESS_API_BASE_URL: "https://api.openai.com",
      ANTHROPIC_API_KEY: "sk-ant-another-secret",
    });
    expect(snapshot.openai.apiKeySet).toBe(true);
    expect(snapshot.anthropic.apiKeySet).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("sk-super-secret");
    expect(JSON.stringify(snapshot)).not.toContain("sk-ant-another-secret");
    expect(snapshot.openai).not.toHaveProperty("apiKey");
    expect(snapshot.anthropic).not.toHaveProperty("apiKey");
  });

  test("readSettingsSnapshot uses sensible defaults for unset env vars", () => {
    const snapshot = readSettingsSnapshot({});
    expect(snapshot.runtimeKind).toBe("openai-compatible");
    expect(snapshot.openai.apiKeySet).toBe(false);
    expect(snapshot.anthropic.apiKeySet).toBe(false);
    expect(snapshot.anthropic.apiBaseUrl).toBe("https://api.anthropic.com");
  });

  test("requested model IDs override the configured default for both provider runtimes", () => {
    const openai = resolveModelRuntime({
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_MODEL_ID: "configured-default",
      HARNESS_API_BASE_URL: "https://api.example.test",
      HARNESS_API_KEY: "secret",
    }, { modelId: "requested-model" });
    const anthropic = resolveModelRuntime({
      HARNESS_RUNTIME_KIND: "anthropic",
      HARNESS_MODEL_ID: "configured-default",
      ANTHROPIC_API_KEY: "secret",
    }, { modelId: "requested-model" });

    expect(openai.modelId).toBe("requested-model");
    expect(anthropic.modelId).toBe("requested-model");
  });

  test("parseSettingsUpdate validates provider configuration before it can reach .env.local", () => {
    expect(parseSettingsUpdate({
      runtimeKind: "openai-compatible",
      modelId: "gpt-4o-mini",
      openai: { apiBaseUrl: "https://opencode.ai/zen/v1", apiPath: "/v1/chat/completions", maxTokens: 256, temperature: 0.2 },
    })).toMatchObject({ runtimeKind: "openai-compatible", modelId: "gpt-4o-mini" });
    expect(() => parseSettingsUpdate({ runtimeKind: "local-command" })).toThrow("runtimeKind");
    expect(() => parseSettingsUpdate({ openai: { apiKey: "secret\ninjected=true" } })).toThrow("single-line");
    expect(() => parseSettingsUpdate({ openai: { apiBaseUrl: "https://user:pass@example.test" } })).toThrow("without credentials");
    expect(() => parseSettingsUpdate({ openai: { apiPath: "https://example.test/v1" } })).toThrow("absolute path");
  });

  test("resolveProjectRoot accepts the canonical project root and rejects non-project dirs", () => {
    expect(resolveProjectRoot({})).toBe(DEFAULT_PROJECT_ROOT);
    expect(resolveProjectRoot({ HARNESS_PROJECT_ROOT: DEFAULT_PROJECT_ROOT })).toBe(DEFAULT_PROJECT_ROOT);
    expect(() => resolveProjectRoot({ HARNESS_PROJECT_ROOT: "/tmp" })).toThrow("package.json or FLOYD.md");
    expect(() => resolveProjectRoot({ HARNESS_PROJECT_ROOT: `${DEFAULT_PROJECT_ROOT}/backend/src` })).toThrow("package.json or FLOYD.md");
    expect(() => resolveProjectRoot({ HARNESS_PROJECT_ROOT: `${DEFAULT_PROJECT_ROOT}/nonexistent-dir-xyz` })).toThrow("does not exist");
    expect(() => resolveProjectRoot({ HARNESS_PROJECT_ROOT: `${DEFAULT_PROJECT_ROOT}/package.json` })).toThrow("must be a directory");
  });

  test("resolveMemoryPath scopes paths under <projectRoot>/.bonsai/memory and rejects escapes", () => {
    expect(resolveMemoryPath("conversations/abc-123.jsonl", "/proj")).toBe("/proj/.bonsai/memory/conversations/abc-123.jsonl");
    expect(resolveMemoryPath("vault/note.md", "/proj")).toBe("/proj/.bonsai/memory/vault/note.md");
    expect(getMemoryRoot("/proj")).toBe("/proj/.bonsai/memory");
    expect(getConversationsDir("/proj")).toBe("/proj/.bonsai/memory/conversations");
    expect(() => resolveMemoryPath("", "/proj")).toThrow("non-empty");
    expect(() => resolveMemoryPath("   ", "/proj")).toThrow("non-empty");
    expect(() => resolveMemoryPath("/etc/passwd", "/proj")).toThrow("relative path within the project memory root");
    expect(() => resolveMemoryPath("../../escape.jsonl", "/proj")).toThrow("relative path within the project memory root");
  });
});
