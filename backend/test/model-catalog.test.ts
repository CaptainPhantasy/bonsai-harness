import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findModelEntry,
  getBackupModel,
  getDefaultModel,
  getProvider,
  getVisionFallbackModel,
  loadModelCatalog,
  loadModelCatalogFromPath,
  modelAcceptsInput,
  resetModelCatalogCache,
  type ModelCatalog,
} from "../src/model-catalog";

const validFixture: ModelCatalog = {
  version: 1,
  generatedAt: "2026-07-11",
  providers: {
    zai: {
      displayName: "Z.AI",
      runtimeKind: "openai-compatible",
      apiBaseUrl: "https://api.z.ai",
      apiPath: "/api/coding/paas/v4/chat/completions",
      credentialEnv: "HARNESS_API_KEY",
      authBrokerProvider: "zai",
      subscription: "Max",
    },
    minimax: {
      displayName: "MiniMax",
      runtimeKind: "openai-compatible",
      apiBaseUrl: "https://api.minimax.io",
      apiPath: "/v1/chat/completions",
      credentialEnv: "HARNESS_BACKUP_API_KEY",
      authBrokerProvider: "minimax-code",
      subscription: "Plus",
    },
  },
  models: [
    {
      id: "glm-5.2",
      displayName: "GLM-5.2",
      provider: "zai",
      context: 1_000_000,
      maxOutput: 131_072,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { kind: "always-on", budgetTokens: 1024, effort: "high" },
      rateLimits: { rpm: null, quotaTier: 1, peakMultiplier: 3, offPeakMultiplier: 2 },
      roles: ["primary-deep-reasoning"],
    },
    {
      id: "MiniMax-M3",
      displayName: "MiniMax M3",
      provider: "minimax",
      context: 1_000_000,
      maxOutput: 8192,
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning: { kind: "toggleable", budgetTokens: 1024, effort: "medium" },
      rateLimits: { rpm: 200, quotaTier: 2 },
      roles: ["multimodal-primary"],
    },
  ],
  defaults: {
    primaryModelId: "glm-5.2",
    backupModelId: "MiniMax-M3",
    visionFallbackModelId: "MiniMax-M3",
    reasoningBudgetTokens: 1024,
    maxAgentToolRounds: 8,
  },
};

function writeFixture(dir: string, catalog: unknown): string {
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify(catalog));
  return path;
}

describe("model catalog loader", () => {
  test("loadModelCatalogFromPath parses a valid fixture with 2 models", () => {
    const dir = mkdtempSync(join(tmpdir(), "bonsai-catalog-"));
    try {
      const path = writeFixture(dir, validFixture);
      const catalog = loadModelCatalogFromPath(path);
      expect(catalog.models.length).toBe(2);
      expect(catalog.providers.zai?.apiBaseUrl).toBe("https://api.z.ai");
      expect(findModelEntry(catalog, "glm-5.2")?.reasoning.budgetTokens).toBe(1024);
      expect(getDefaultModel(catalog).id).toBe("glm-5.2");
      expect(getBackupModel(catalog).id).toBe("MiniMax-M3");
      expect(getVisionFallbackModel(catalog).id).toBe("MiniMax-M3");
      expect(getProvider(catalog, "minimax").authBrokerProvider).toBe("minimax-code");
      expect(modelAcceptsInput(catalog, "MiniMax-M3", "image")).toBe(true);
      expect(modelAcceptsInput(catalog, "glm-5.2", "image")).toBe(false);
      expect(findModelEntry(catalog, "nope")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadModelCatalogFromPath rejects catalogs with structural violations", () => {
    const dir = mkdtempSync(join(tmpdir(), "bonsai-catalog-bad-"));
    try {
      // Missing provider referenced by model
      const danglingProvider = JSON.parse(JSON.stringify(validFixture)) as unknown;
      (danglingProvider as { models: Array<{ provider: string }> }).models[0]!.provider = "ghost";
      expect(() => loadModelCatalogFromPath(writeFixture(dir, danglingProvider))).toThrow(/unknown provider "ghost"/);

      // Missing defaults
      const noDefaults = JSON.parse(JSON.stringify(validFixture)) as Record<string, unknown>;
      delete noDefaults.defaults;
      expect(() => loadModelCatalogFromPath(writeFixture(dir, noDefaults))).toThrow(/defaults/);

      // Duplicate model id
      const dupId = JSON.parse(JSON.stringify(validFixture)) as { models: Array<{ id: string }> };
      dupId.models[1]!.id = "glm-5.2";
      expect(() => loadModelCatalogFromPath(writeFixture(dir, dupId))).toThrow(/duplicate model id/);

      // Defaults pointing at a non-existent model
      const badDefault = JSON.parse(JSON.stringify(validFixture)) as { defaults: { primaryModelId: string } };
      badDefault.defaults.primaryModelId = "ghost";
      expect(() => loadModelCatalogFromPath(writeFixture(dir, badDefault))).toThrow(/defaults.primaryModelId/);

      // Invalid runtime kind
      const badKind = JSON.parse(JSON.stringify(validFixture)) as { providers: { zai: { runtimeKind: string } } };
      badKind.providers.zai!.runtimeKind = "voodoo";
      expect(() => loadModelCatalogFromPath(writeFixture(dir, badKind))).toThrow(/runtimeKind/);

      // Invalid reasoning kind
      const badReasoning = JSON.parse(JSON.stringify(validFixture)) as { models: Array<{ reasoning: { kind: string } }> };
      badReasoning.models[0]!.reasoning.kind = "maybe";
      expect(() => loadModelCatalogFromPath(writeFixture(dir, badReasoning))).toThrow(/reasoning\.kind/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("model catalog production cache", () => {
  test("loadModelCatalog reads the real backend/models.json and returns the 10 expected models", () => {
    resetModelCatalogCache();
    const catalog = loadModelCatalog();
    expect(catalog.models.length).toBe(10);
    const glmCount = catalog.models.filter((m) => m.provider === "zai").length;
    const minimaxCount = catalog.models.filter((m) => m.provider === "minimax").length;
    expect(glmCount).toBe(5);
    expect(minimaxCount).toBe(5);
    expect(getDefaultModel(catalog).id).toBe("glm-5.2");
    expect(getBackupModel(catalog).id).toBe("MiniMax-M3");
    expect(getVisionFallbackModel(catalog).id).toBe("MiniMax-M3");
    expect(catalog.defaults.reasoningBudgetTokens).toBe(1024);
  });
});
