import { describe, expect, test } from "bun:test";

import { routeAndValidate, routeRequest, type RoutingRequest } from "../src/router";
import { loadModelCatalog, type ModelCatalog } from "../src/model-catalog";

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
      rateLimits: { rpm: null, quotaTier: 1 },
      roles: ["primary-deep-reasoning"],
    },
    {
      id: "glm-4.5-air",
      displayName: "GLM-4.5 Air",
      provider: "zai",
      context: 131_072,
      maxOutput: 98_304,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { kind: "toggleable", budgetTokens: 512, effort: "low" },
      rateLimits: { rpm: null, quotaTier: 1 },
      roles: ["lightweight", "cheap"],
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

describe("capability router", () => {
  test("vision attachment forces vision-fallback model regardless of prompt", () => {
    const req: RoutingRequest = {
      prompt: "refactor this entire codebase",
      attachments: [{ name: "screenshot.png", size: 1024, type: "image/png" }],
    };
    const decision = routeRequest(fixture, req);
    // GLM-4.6v is not in this minimal fixture, so the image falls back to M3
    expect(decision.modelId).toBe("MiniMax-M3");
    expect(decision.provider).toBe("minimax");
    expect(decision.reason).toContain("image");
  });

  test("video attachment also routes to vision-fallback", () => {
    const decision = routeRequest(fixture, {
      prompt: "what is in this",
      attachments: [{ name: "clip.mp4", size: 100_000, type: "video/mp4" }],
    });
    expect(decision.modelId).toBe("MiniMax-M3");
    expect(decision.reason).toContain("video input");
  });

  test("explicit requestedModelId is honored when present in catalog", () => {
    const decision = routeRequest(fixture, {
      prompt: "anything",
      requestedModelId: "glm-4.5-air",
    });
    expect(decision.modelId).toBe("glm-4.5-air");
    expect(decision.reason).toContain("client requested");
  });

  test("unknown requestedModelId falls through silently to default routing", () => {
    const decision = routeRequest(fixture, {
      prompt: "summarize this",
      requestedModelId: "ghost-model",
    });
    // Lightweight verb should still fire
    expect(decision.modelId).toBe("glm-4.5-air");
  });

  test("deep-reasoning verbs trigger primary deep-reasoning model", () => {
    for (const verb of ["refactor this", "architect the migration", "debug this crash", "audit the auth flow"]) {
      const decision = routeRequest(fixture, { prompt: verb });
      expect(decision.modelId).toBe("glm-5.2");
      const firstWord = verb.split(" ")[0];
      if (firstWord) expect(decision.reason).toContain(firstWord);
    }
  });

  test("lightweight verbs trigger the cheap-tier model", () => {
    const decision = routeRequest(fixture, { prompt: "summarize this thread" });
    expect(decision.modelId).toBe("glm-4.5-air");
    expect(decision.reason).toContain("lightweight");
  });

  test("continuation picks a model from the prior provider", () => {
    const decision = routeRequest(fixture, {
      prompt: "next step please",
      priorProviderId: "minimax",
    });
    expect(decision.provider).toBe("minimax");
    expect(decision.reason).toContain("continuing");
  });

  test("plain prompt with no signal falls back to default primary", () => {
    const decision = routeRequest(fixture, { prompt: "hello world" });
    expect(decision.modelId).toBe("glm-5.2");
    expect(decision.reason).toContain("default primary");
  });

  test("routeAndValidate throws when routing picks a model that cannot handle an attachment", () => {
    // Force a mismatch: explicit request for text-only model with image attachment
    expect(() => routeAndValidate(fixture, {
      prompt: "look at this",
      requestedModelId: "glm-5.2",
      attachments: [{ name: "img.png", size: 1, type: "image/png" }],
    })).toThrow(/requires image input/);
  });

  test("routeAndValidate passes when the chosen model handles every attachment modality", () => {
    const decision = routeAndValidate(fixture, {
      prompt: "describe this",
      attachments: [{ name: "img.png", size: 1, type: "image/png" }],
    });
    expect(decision.modelId).toBe("MiniMax-M3");
  });
});

describe("capability router against production catalog", () => {
  test("the real backend/models.json routes the same way for canonical signals", () => {
    const realPath = new URL("../models.json", import.meta.url);
    const catalog = (() => {
      // Read & parse without going through the cached loader so the test is hermetic.
      const fs = require("node:fs");
      const text = fs.readFileSync(realPath, "utf8");
      const parsed = JSON.parse(text);
      // Validate minimally — full validation is the catalog module's tests.
      if (!parsed.models || !parsed.defaults) throw new Error("bad fixture");
      return parsed as ModelCatalog;
    })();

    expect(routeRequest(catalog, { prompt: "summarize this", attachments: [{ name: "i.png", size: 1, type: "image/png" }] }).modelId).toBe("glm-4.6v");
    expect(routeRequest(catalog, { prompt: "refactor the auth flow" }).modelId).toBe("glm-5.2");
    expect(routeRequest(catalog, { prompt: "describe", attachments: [{ name: "v.mp4", size: 1, type: "video/mp4" }] }).modelId).toBe("MiniMax-M3");
  });
});
