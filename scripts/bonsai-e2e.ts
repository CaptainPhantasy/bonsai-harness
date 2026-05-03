/**
 * Bonsai E2E test: spawns a real Bonsai model inference via the harness
 * backend and verifies the response contains actual model output.
 *
 * Prerequisites:
 *   - Backend running with BONSAI model + mlx_lm binary
 *   - Model cached at HARNESS_MODEL_CACHE_DIR
 *
 * Usage:
 *   HARNESS_SMOKE_URL=http://localhost:11431 bun scripts/bonsai-e2e.ts
 */

const baseUrl = process.env.HARNESS_SMOKE_URL ?? "http://localhost:11431";
const wsUrl = baseUrl.replace(/^http/, "ws");
const TIMEOUT_MS = 120_000;

// 1. Health check
const healthResponse = await fetch(`${baseUrl}/health`);
if (!healthResponse.ok) {
  throw new Error(`health failed: ${healthResponse.status}`);
}
const health = (await healthResponse.json()) as Record<string, unknown>;
console.log("health", JSON.stringify(health));

if (health.modelId !== "prism-ml/Ternary-Bonsai-8B-mlx-2bit") {
  throw new Error(`Expected Bonsai model, got: ${health.modelId}`);
}
if (health.runnerBinaryPresent !== true) {
  throw new Error("Runner binary not found");
}

// 2. Spawn Bonsai inference via WebSocket
const received: string[] = [];
const ws = new WebSocket(wsUrl);

const result = await new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Bonsai E2E timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      action: "spawn_agent",
      agentId: "Bonsai-E2E",
      prompt: "2+2=",
      modelId: "prism-ml/Ternary-Bonsai-8B-mlx-2bit",
      runtimeKind: "local-command",
    }));
  });

  let inferenceOutput = "";

  ws.addEventListener("message", (event) => {
    const raw = String(event.data);
    received.push(raw);

    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data.type === "inference" && typeof data.payload === "string") {
        // Skip HuggingFace cache verification progress bar lines
        if (data.payload.includes("Fetching") && data.payload.includes("%")) return;
        inferenceOutput = data.payload;
      }
      if (data.type === "agent_exit") {
        clearTimeout(timer);
        ws.close();
        resolve({ ok: inferenceOutput.length > 0, output: inferenceOutput });
      }
    } catch {
      // Ignore non-JSON
    }
  });

  ws.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("WebSocket error"));
  });
});

console.log("websocket events:", received.length);
console.log("inference output:", result.output.trim());

if (!result.ok || result.output.trim().length === 0) {
  throw new Error("Bonsai E2E failed: no inference output received");
}

console.log("\nBONSAI E2E PASSED");
