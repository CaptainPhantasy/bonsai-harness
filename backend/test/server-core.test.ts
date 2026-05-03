import { describe, expect, test } from "bun:test";

import {
  assertSpawnCapacity,
  buildLocalCommandArguments,
  buildOpenAiCompatibleRequest,
  createSandboxPath,
  healthPayload,
  parseClientMessage,
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

    expect(path).toBe("/tmp/bonsai-sandbox/semibadname.json");
  });

  test("createSandboxPath rejects filenames that sanitize to empty", () => {
    expect(() => createSandboxPath("../../../", "/tmp/bonsai-sandbox")).toThrow(
      "Sandbox filename must contain at least one safe character",
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
    }))).toThrow("spawn_agent runtimeKind must be one of: local-command, openai-compatible");
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
      apiKeyPresent: true,
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

  test("resolvePort defaults to the claimed beta port and rejects forbidden dev ports", () => {
    expect(resolvePort({})).toBe(11431);
    expect(resolvePort({ PORT: "11432" })).toBe(11432);
    expect(() => resolvePort({ PORT: "3000" })).toThrow(
      "PORT must be an integer between 10000 and 65535",
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
      "HARNESS_MAX_ACTIVE_AGENTS must be an integer between 1 and 16",
    );
    expect(() => assertSpawnCapacity(2, 2)).toThrow("Model spawn capacity reached");
  });

  test("buildLocalCommandArguments applies model, prompt, and cache placeholders without splitting prompt text", () => {
    expect(buildLocalCommandArguments(
      "run --model {{modelId}} --prompt {{prompt}} --cache {{cacheDir}}",
      "vendor/model",
      "Role prompt with spaces",
      "/tmp/cache path",
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
        apiKeyPresent: true,
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
      apiKeyPresent: true,
      sandboxRoot: "/tmp/harness-smoke",
    });
    expect(JSON.stringify(healthPayload(0, 0, {
      HARNESS_RUNTIME_KIND: "openai-compatible",
      HARNESS_API_BASE_URL: "https://api.example.test",
      HARNESS_API_KEY: "super-secret",
    }))).not.toContain("super-secret");
  });
});
