import { describe, expect, test } from "bun:test";

import {
  assertSpawnCapacity,
  buildAnthropicRequest,
  buildLocalCommandArguments,
  buildOpenAiCompatibleRequest,
  createSandboxPath,
  healthPayload,
  isModelRuntimeKind,
  parseClientMessage,
  readSettingsSnapshot,
  resolveAnthropicApiKey,
  resolveDefaultModelId,
  resolveMaxActiveAgents,
  resolveModelRuntime,
  resolvePort,
  resolveSandboxRoot,
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
    }))).toThrow("spawn_agent runtimeKind must be one of: local-command, openai-compatible, anthropic");
  });

  test("parseClientMessage accepts stop_generation action", () => {
    const message = parseClientMessage(JSON.stringify({ action: "stop_generation" }));
    expect(message).toEqual({ action: "stop_generation" });
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

  test("resolveDefaultModelId uses generic env override while Bonsai remains the default value", () => {
    expect(resolveDefaultModelId({})).toBe("prism-ml/Ternary-Bonsai-8B-mlx-2bit");
    expect(resolveDefaultModelId({ HARNESS_MODEL_ID: "local/slm" })).toBe("local/slm");
  });

  test("resolveModelRuntime defaults to a local command runtime with swappable binary, args, and cache paths", () => {
    expect(resolveModelRuntime({
      HARNESS_MODEL_ID: "local/slm",
      HARNESS_RUNNER_BINARY: "/bin/echo",
      HARNESS_RUNNER_ARGS_TEMPLATE: "run --model {{modelId}} --prompt {{prompt}} --cache {{cacheDir}}",
      HARNESS_CACHE_DIR: "/tmp/harness-cache",
      HARNESS_RUNTIME_KIND: "local-command",
    })).toEqual({
      kind: "local-command",
      modelId: "local/slm",
      runnerBinaryPath: "/bin/echo",
      runnerArgsTemplate: "run --model {{modelId}} --prompt {{prompt}} --cache {{cacheDir}}",
      modelCacheDir: "/Volumes/SanDisk1Tb/HFModels",
      cacheDir: "/tmp/harness-cache",
    });
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

  test("buildLocalCommandArguments applies model, prompt, and cache placeholders without splitting prompt text", () => {
    expect(buildLocalCommandArguments(
      "run --model {{modelId}} --prompt {{prompt}} --cache {{cacheDir}}",
      "vendor/model",
      "Role prompt with spaces",
      "/tmp/cache path",
      "/tmp/model-cache",
      "local-command",
    )).toEqual([
      "run",
      "--model",
      "vendor/model",
      "--prompt",
      "Role prompt with spaces",
      "--cache",
      "/tmp/cache path",
    ]);
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
    expect(isModelRuntimeKind("local-command")).toBe(true);
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
    expect(snapshot.runtimeKind).toBe("local-command");
    expect(snapshot.openai.apiKeySet).toBe(false);
    expect(snapshot.anthropic.apiKeySet).toBe(false);
    expect(snapshot.anthropic.apiBaseUrl).toBe("https://api.anthropic.com");
  });
});
