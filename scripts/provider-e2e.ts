/**
 * Provider-neutral WebSocket E2E check for a running, configured harness.
 *
 * Usage:
 *   HARNESS_SMOKE_URL=http://localhost:11431 bun run provider:e2e
 */

const baseUrl = process.env.HARNESS_SMOKE_URL ?? "http://localhost:11431";
const wsUrl = baseUrl.replace(/^http/, "ws");
const timeoutMs = 120_000;

const healthResponse = await fetch(`${baseUrl}/health`);
if (!healthResponse.ok) throw new Error(`health failed: ${healthResponse.status}`);
const health = (await healthResponse.json()) as Record<string, unknown>;
console.log("health", JSON.stringify(health));

if (health.ok !== true) throw new Error(`Provider configuration is not ready: ${String(health.error ?? "unknown error")}`);
if (health.runtimeKind !== "openai-compatible" && health.runtimeKind !== "anthropic") {
  throw new Error(`Unsupported runtime: ${String(health.runtimeKind)}`);
}

const received: string[] = [];
const result = await new Promise<{ output: string }>((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => {
    ws.close();
    reject(new Error(`Provider E2E timed out after ${timeoutMs / 1000}s`));
  }, timeoutMs);

  let inferenceOutput = "";
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      action: "spawn_agent",
      agentId: "Provider-E2E",
      prompt: "Reply with the word ready.",
      modelId: process.env.HARNESS_E2E_MODEL_ID ?? health.modelId,
      runtimeKind: health.runtimeKind,
    }));
  });
  ws.addEventListener("message", (event) => {
    const raw = String(event.data);
    received.push(raw);
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data.type === "inference" && typeof data.payload === "string") inferenceOutput += data.payload;
      if (data.type === "agent_exit") {
        clearTimeout(timer);
        ws.close();
        if (inferenceOutput.trim().length === 0) reject(new Error("Provider E2E received no inference output"));
        else resolve({ output: inferenceOutput });
      }
    } catch {
      // Ignore malformed third-party diagnostic output.
    }
  });
  ws.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("WebSocket error"));
  });
});

console.log("websocket events:", received.length);
console.log("inference output:", result.output.trim());
console.log("PROVIDER E2E PASSED");
