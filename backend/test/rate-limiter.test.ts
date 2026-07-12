import { describe, expect, test } from "bun:test";

import { ModelRateLimiter, routeWithRateLimit } from "../src/rate-limiter";
import { loadModelCatalog, type ModelCatalog } from "../src/model-catalog";

const realCatalog = loadModelCatalog();

const fixture: ModelCatalog = {
  version: 1,
  generatedAt: "2026-07-11",
  providers: {
    minimax: {
      displayName: "MiniMax",
      runtimeKind: "openai-compatible",
      apiBaseUrl: "https://api.minimax.io",
      apiPath: "/v1/chat/completions",
      credentialEnv: "MINIMAX_KEY",
      authBrokerProvider: "minimax-code",
      subscription: "test",
    },
    zai: {
      displayName: "Z.AI",
      runtimeKind: "openai-compatible",
      apiBaseUrl: "https://api.z.ai",
      apiPath: "/api/coding/paas/v4/chat/completions",
      credentialEnv: "ZAI_KEY",
      authBrokerProvider: "zai",
      subscription: "test",
    },
  },
  models: [
    {
      id: "M3",
      displayName: "M3",
      provider: "minimax",
      context: 1_000_000,
      maxOutput: 8192,
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning: { kind: "toggleable", budgetTokens: 1024, effort: "medium" },
      rateLimits: { rpm: 200, quotaTier: 2 },
      roles: ["multimodal-primary"],
    },
    {
      id: "M2.7",
      displayName: "M2.7",
      provider: "minimax",
      context: 204_800,
      maxOutput: 8192,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { kind: "off", budgetTokens: 0, effort: "none" },
      rateLimits: { rpm: 500, quotaTier: 2 },
      roles: ["high-throughput-text"],
    },
    {
      id: "glm-5.2",
      displayName: "GLM-5.2",
      provider: "zai",
      context: 1_000_000,
      maxOutput: 131_072,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { kind: "always-on", budgetTokens: 1024, effort: "high" },
      rateLimits: { rpm: null, quotaTier: 1 },
      roles: ["primary"],
    },
  ],
  defaults: {
    primaryModelId: "glm-5.2",
    backupModelId: "M3",
    visionFallbackModelId: "M3",
    reasoningBudgetTokens: 1024,
    maxAgentToolRounds: 8,
  },
};

describe("ModelRateLimiter", () => {
  test("models with null rpm are always allowed", () => {
    const limiter = new ModelRateLimiter(fixture);
    for (let i = 0; i < 1000; i += 1) {
      expect(limiter.check("glm-5.2", 0).allowed).toBe(true);
    }
  });

  test("models with rpm throttle once the window fills", () => {
    const limiter = new ModelRateLimiter(fixture);
    // M3 has rpm=200. At t=0, fill 200 slots.
    for (let i = 0; i < 200; i += 1) {
      expect(limiter.check("M3", 0).allowed).toBe(true);
      limiter.recordRequest("M3", 0);
    }
    // 201st at t=0 must throttle.
    const blocked = limiter.check("M3", 0);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.limit).toBe(200);
      expect(blocked.activeCount).toBe(200);
    }
  });

  test("expired entries are evicted as the window slides", () => {
    const limiter = new ModelRateLimiter(fixture);
    for (let i = 0; i < 200; i += 1) {
      limiter.recordRequest("M3", 0);
    }
    // At t=60_001 (1ms past the window), all 200 entries expire.
    const allowed = limiter.check("M3", 60_001);
    expect(allowed.allowed).toBe(true);
  });

  test("partial eviction: half the window slides out", () => {
    const limiter = new ModelRateLimiter(fixture);
    // 100 requests at t=0
    for (let i = 0; i < 100; i += 1) limiter.recordRequest("M3", 0);
    // 100 more at t=30_000 (still within window of t=60_001)
    for (let i = 0; i < 100; i += 1) limiter.recordRequest("M3", 30_000);
    // At t=60_001, the first 100 expired; the second 100 remain.
    expect(limiter.check("M3", 60_001).allowed).toBe(true);
    limiter.recordRequest("M3", 60_001);
    // Now 101 in window — still under 200.
    expect(limiter.check("M3", 60_001).allowed).toBe(true);
  });

  test("snapshot reports active count per model", () => {
    const limiter = new ModelRateLimiter(fixture);
    for (let i = 0; i < 50; i += 1) limiter.recordRequest("M3", 0);
    const snap = limiter.snapshot(0);
    const m3 = snap.find((s) => s.modelId === "M3");
    const glm = snap.find((s) => s.modelId === "glm-5.2");
    expect(m3?.activeInWindow).toBe(50);
    expect(glm?.activeInWindow).toBe(0);
    expect(glm?.rpm).toBeNull();
  });

  test("resetForTest clears all windows", () => {
    const limiter = new ModelRateLimiter(fixture);
    for (let i = 0; i < 200; i += 1) limiter.recordRequest("M3", 0);
    expect(limiter.check("M3", 0).allowed).toBe(false);
    limiter.resetForTest();
    expect(limiter.check("M3", 0).allowed).toBe(true);
  });
});

describe("routeWithRateLimit", () => {
  test("returns the first choice when rate is fine", () => {
    const limiter = new ModelRateLimiter(fixture);
    const result = routeWithRateLimit({
      catalog: fixture,
      limiter,
      requiredModalities: ["text"],
      firstChoiceModelId: "M3",
      now: 0,
    });
    expect(result.modelId).toBe("M3");
    expect(result.throttled).toBe(false);
    expect(result.alternateUsed).toBe(false);
  });

  test("sheds to a same-provider alternate when the primary is throttled", () => {
    const limiter = new ModelRateLimiter(fixture);
    // Fill M3 window (rpm=200)
    for (let i = 0; i < 200; i += 1) limiter.recordRequest("M3", 0);
    const result = routeWithRateLimit({
      catalog: fixture,
      limiter,
      requiredModalities: ["text"],
      firstChoiceModelId: "M3",
      now: 0,
    });
    expect(result.modelId).toBe("M2.7");
    expect(result.throttled).toBe(false);
    expect(result.alternateUsed).toBe(true);
    expect(result.reason).toContain("shed to M2.7");
  });

  test("does not cross providers — only same-provider alternates considered", () => {
    const limiter = new ModelRateLimiter(fixture);
    // Fill M3 window AND M2.7 window. Vision workload requires image,
    // which M2.7 cannot satisfy. Should fall back to throttled, not
    // spill to glm-5.2.
    for (let i = 0; i < 200; i += 1) limiter.recordRequest("M3", 0);
    for (let i = 0; i < 500; i += 1) limiter.recordRequest("M2.7", 0);
    const result = routeWithRateLimit({
      catalog: fixture,
      limiter,
      requiredModalities: ["image"],
      firstChoiceModelId: "M3",
      now: 0,
    });
    expect(result.modelId).toBe("M3");
    expect(result.throttled).toBe(true);
    expect(result.reason).toContain("no same-provider alternate");
  });

  test("against the production catalog, sheds M3 text to M2.7 when M3 is full", () => {
    const limiter = new ModelRateLimiter(realCatalog);
    for (let i = 0; i < 200; i += 1) limiter.recordRequest("MiniMax-M3", 0);
    const result = routeWithRateLimit({
      catalog: realCatalog,
      limiter,
      requiredModalities: ["text"],
      firstChoiceModelId: "MiniMax-M3",
      now: 0,
    });
    expect(result.alternateUsed).toBe(true);
    expect(result.modelId).toMatch(/^MiniMax-M2\./);
    expect(result.throttled).toBe(false);
  });
});
