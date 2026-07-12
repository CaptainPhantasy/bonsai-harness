import { describe, expect, test } from "bun:test";

import {
  backupRuntimeFromCatalog,
  findSameProviderAlternate,
  runtimeFromCatalogEntry,
} from "../src/runtime-resolver";
import { loadModelCatalog, type ModelCatalog } from "../src/model-catalog";

const realCatalog = loadModelCatalog();

const minimalCatalog: ModelCatalog = {
  version: 1,
  generatedAt: "2026-07-11",
  providers: {
    alpha: {
      displayName: "Alpha",
      runtimeKind: "openai-compatible",
      apiBaseUrl: "https://alpha.test/",
      apiPath: "/v1/chat/completions",
      credentialEnv: "ALPHA_KEY",
      authBrokerProvider: "alpha",
      subscription: "test",
    },
    beta: {
      displayName: "Beta",
      runtimeKind: "anthropic",
      apiBaseUrl: "https://beta.test",
      apiPath: "/v1/messages",
      credentialEnv: "BETA_KEY",
      authBrokerProvider: "beta",
      subscription: "test",
    },
  },
  models: [
    {
      id: "alpha-heavy",
      displayName: "Alpha Heavy",
      provider: "alpha",
      context: 200_000,
      maxOutput: 8192,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { kind: "always-on", budgetTokens: 1024, effort: "high" },
      rateLimits: { rpm: 500, quotaTier: 1 },
      roles: ["primary"],
    },
    {
      id: "alpha-vision",
      displayName: "Alpha Vision",
      provider: "alpha",
      context: 200_000,
      maxOutput: 8192,
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: { kind: "toggleable", budgetTokens: 1024, effort: "medium" },
      rateLimits: { rpm: 100, quotaTier: 1 },
      roles: ["vision"],
    },
    {
      id: "beta-anthropic",
      displayName: "Beta Anthropic",
      provider: "beta",
      context: 200_000,
      maxOutput: 4096,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { kind: "toggleable", budgetTokens: 512, effort: "medium" },
      rateLimits: { rpm: 50, quotaTier: 1 },
      roles: ["advisor"],
    },
  ],
  defaults: {
    primaryModelId: "alpha-heavy",
    backupModelId: "beta-anthropic",
    visionFallbackModelId: "alpha-vision",
    reasoningBudgetTokens: 1024,
    maxAgentToolRounds: 8,
  },
};

describe("runtimeFromCatalogEntry", () => {
  test("builds an OpenAI-compatible runtime with endpoint from provider, key from credentialEnv", () => {
    const env = { ALPHA_KEY: "secret-alpha-key" };
    const resolved = runtimeFromCatalogEntry(minimalCatalog, "alpha-heavy", env);
    expect(resolved.runtime.kind).toBe("openai-compatible");
    if (resolved.runtime.kind === "openai-compatible") {
      expect(resolved.runtime.apiBaseUrl).toBe("https://alpha.test");
      expect(resolved.runtime.apiPath).toBe("/v1/chat/completions");
      expect(resolved.runtime.modelId).toBe("alpha-heavy");
    }
    expect(resolved.key).toBe("secret-alpha-key");
    expect(resolved.entry.id).toBe("alpha-heavy");
    expect(resolved.provider.displayName).toBe("Alpha");
  });

  test("builds an Anthropic runtime from a beta-provider entry", () => {
    const env = { BETA_KEY: "secret-beta-key" };
    const resolved = runtimeFromCatalogEntry(minimalCatalog, "beta-anthropic", env);
    expect(resolved.runtime.kind).toBe("anthropic");
    if (resolved.runtime.kind === "anthropic") {
      expect(resolved.runtime.apiBaseUrl).toBe("https://beta.test");
      expect(resolved.runtime.modelId).toBe("beta-anthropic");
    }
    expect(resolved.key).toBe("secret-beta-key");
  });

  test("strips trailing slashes from the provider apiBaseUrl", () => {
    const env = { ALPHA_KEY: "k" };
    const resolved = runtimeFromCatalogEntry(minimalCatalog, "alpha-heavy", env);
    expect(resolved.runtime.apiBaseUrl).not.toMatch(/\/$/);
  });

  test("throws when the credential env var is unset", () => {
    expect(() => runtimeFromCatalogEntry(minimalCatalog, "alpha-heavy", {})).toThrow(
      /Credential env var "ALPHA_KEY".*not set/,
    );
  });

  test("throws when the model id is not in the catalog", () => {
    expect(() => runtimeFromCatalogEntry(minimalCatalog, "ghost-model", { ALPHA_KEY: "k" })).toThrow(
      /model "ghost-model" not in catalog/,
    );
  });

  test("against the production catalog, resolves glm-5.2 to the zai Coding Plan endpoint", () => {
    const env = { HARNESS_API_KEY: "production-key" };
    const resolved = runtimeFromCatalogEntry(realCatalog, "glm-5.2", env);
    expect(resolved.runtime.kind).toBe("openai-compatible");
    if (resolved.runtime.kind === "openai-compatible") {
      expect(resolved.runtime.apiBaseUrl).toBe("https://api.z.ai");
      expect(resolved.runtime.apiPath).toBe("/api/coding/paas/v4/chat/completions");
    }
    expect(resolved.key).toBe("production-key");
  });

  test("against the production catalog, resolves MiniMax-M3 to the international coding endpoint", () => {
    const env = { HARNESS_BACKUP_API_KEY: "minimax-key" };
    const resolved = runtimeFromCatalogEntry(realCatalog, "MiniMax-M3", env);
    if (resolved.runtime.kind === "openai-compatible") {
      expect(resolved.runtime.apiBaseUrl).toBe("https://api.minimax.io");
      expect(resolved.runtime.apiPath).toBe("/v1/chat/completions");
    }
    expect(resolved.key).toBe("minimax-key");
  });
});

describe("backupRuntimeFromCatalog", () => {
  test("returns null when primary is the catalog's declared backup", () => {
    expect(backupRuntimeFromCatalog(minimalCatalog, "beta-anthropic", { BETA_KEY: "k" })).toBeNull();
  });

  test("returns the catalog's declared backup otherwise", () => {
    const backup = backupRuntimeFromCatalog(minimalCatalog, "alpha-heavy", { BETA_KEY: "k" });
    expect(backup?.entry.id).toBe("beta-anthropic");
    expect(backup?.provider.displayName).toBe("Beta");
  });

  test("against the production catalog, returns MiniMax-M3 as backup for glm-5.2", () => {
    const backup = backupRuntimeFromCatalog(realCatalog, "glm-5.2", { HARNESS_BACKUP_API_KEY: "k" });
    expect(backup?.entry.id).toBe("MiniMax-M3");
  });
});

describe("findSameProviderAlternate", () => {
  test("returns null when the chosen model has no same-provider siblings", () => {
    // beta-anthropic is the only beta model
    expect(findSameProviderAlternate(minimalCatalog, "beta-anthropic", ["text"])).toBeNull();
  });

  test("returns a sibling when one exists with the required modalities", () => {
    // alpha-heavy (text) → alpha-vision (text+image)
    const alt = findSameProviderAlternate(minimalCatalog, "alpha-heavy", ["text"]);
    expect(alt?.id).toBe("alpha-vision");
  });

  test("returns null when the sibling cannot satisfy the required modalities", () => {
    // alpha-vision (text+image) → alpha-heavy only accepts text, fails on image
    expect(findSameProviderAlternate(minimalCatalog, "alpha-vision", ["image"])).toBeNull();
  });

  test("against the production catalog, MiniMax-M3 has alternates in the M2.7 family", () => {
    const alt = findSameProviderAlternate(realCatalog, "MiniMax-M3", ["text"]);
    // Highest-RPM text-capable MiniMax sibling
    expect(alt?.provider).toBe("minimax");
    expect(alt?.rateLimits.rpm).toBe(500);
  });

  test("against the production catalog, glm-5.2 has alternates in the GLM family", () => {
    const alt = findSameProviderAlternate(realCatalog, "glm-5.2", ["text"]);
    expect(alt?.provider).toBe("zai");
  });
});
