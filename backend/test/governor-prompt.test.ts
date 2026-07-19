import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGovernorPromptForDefault, buildGovernorSystemPrompt } from "../src/governor-prompt";
import { loadModelCatalogFromPath, type ModelCatalog } from "../src/model-catalog";

const fixture: ModelCatalog = {
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
      subscription: "Coding Plan Max",
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
      rateLimits: { rpm: null, quotaTier: 1, peakMultiplier: 3 },
      roles: ["primary-deep-reasoning"],
      notes: "Terminal-Bench 81.",
    },
  ],
  defaults: {
    primaryModelId: "glm-5.2",
    backupModelId: "glm-5.2",
    visionFallbackModelId: "glm-5.2",
    reasoningBudgetTokens: 1024,
    maxAgentToolRounds: 8,
  },
};

describe("governor prompt", () => {
  test("buildGovernorSystemPrompt produces a non-empty prompt with required sections", () => {
    const prompt = buildGovernorSystemPrompt(fixture, "glm-5.2", {
      agentId: "Worker-1",
      maxToolRounds: 8,
      availableToolCount: 12,
      conversationId: "conv_abc_20260711",
    });
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toContain("GOVERNOR-0 PROTOCOL KERNEL");
    expect(prompt).toContain("Worker-1");
    expect(prompt).toContain("conv_abc_20260711");
    expect(prompt).toContain("Tool rounds: 8");
    expect(prompt).toContain("Reasoning budget: 1024 tokens");
    expect(prompt).toContain("Available connected tools right now: 12");
    expect(prompt).toContain("NO RE-DELIBERATION");
    expect(prompt).toContain("ANTI-VANITY");
    expect(prompt).toContain("CAPABILITY CONTRACT");
    expect(prompt).toContain("VERDICT SCHEMA");
    expect(prompt).toContain("input=text");
    expect(prompt).toContain("Coding Plan Max");
    expect(prompt).toContain("Terminal-Bench 81");
  });

  test("buildGovernorSystemPrompt flags unverified plan coverage", () => {
    const unverified: ModelCatalog = JSON.parse(JSON.stringify(fixture));
    unverified.models[0]!.planCoverage = "unverified";
    const prompt = buildGovernorSystemPrompt(unverified, "glm-5.2", {
      agentId: "A",
      maxToolRounds: 8,
      availableToolCount: 0,
    });
    expect(prompt).toContain("UNVERIFIED");
    expect(prompt).toContain("HTTP 403");
  });

  test("buildGovernorSystemPrompt throws on unknown model", () => {
    expect(() => buildGovernorSystemPrompt(fixture, "ghost-model", {
      agentId: "A",
      maxToolRounds: 1,
      availableToolCount: 0,
    })).toThrow(/unknown model "ghost-model"/);
  });

  test("buildGovernorPromptForDefault uses the catalog primary model", () => {
    const prompt = buildGovernorPromptForDefault(fixture, {
      agentId: "Primary",
      maxToolRounds: 4,
      availableToolCount: 0,
    });
    expect(prompt).toContain("Primary");
    expect(prompt).toContain("Reasoning budget: 1024 tokens");
  });

  test("buildGovernorSystemPrompt renders correctly against the real production catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "bonsai-gov-prod-"));
    try {
      // Use the real catalog by reading from the actual project path
      const realPath = join(__dirname, "..", "models.json");
      const catalog = loadModelCatalogFromPath(realPath);
      const prompt = buildGovernorSystemPrompt(catalog, "MiniMax-M3", {
        agentId: "Advisor",
        maxToolRounds: 6,
        availableToolCount: 38,
        conversationId: "conv_xyz",
      });
      expect(prompt).toContain("Coding Plan Plus");
      expect(prompt).toContain("multimodal-primary");
      expect(prompt).toContain("image+video");
      expect(prompt).toContain("38");
      expect(prompt).toContain("Advisor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
