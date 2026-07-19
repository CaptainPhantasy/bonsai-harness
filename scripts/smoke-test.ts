const baseUrl = process.env.HARNESS_SMOKE_URL ?? "http://localhost:11431";
const wsUrl = baseUrl.replace(/^http/, "ws");

const healthResponse = await fetch(`${baseUrl}/health`);
if (!healthResponse.ok) {
  throw new Error(`health failed: ${healthResponse.status}`);
}
const health = await healthResponse.json();
console.log("health", JSON.stringify(health));

if (health.ok !== true) {
  throw new Error(`provider configuration is not ready: ${String(health.error ?? "unknown error")}`);
}
if (health.runtimeKind !== "openai-compatible" && health.runtimeKind !== "anthropic") {
  throw new Error(`unsupported runtime: ${String(health.runtimeKind)}`);
}

const received: string[] = [];
const ws = new WebSocket(wsUrl);

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket smoke timed out")), 60_000);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      action: "spawn_agent",
      agentId: "Smoke-01",
      prompt: "smoke prompt",
      modelId: process.env.HARNESS_SMOKE_MODEL_ID ?? health.modelId,
      runtimeKind: health.runtimeKind,
    }));
  });

  ws.addEventListener("message", (event) => {
    received.push(String(event.data));
    if (received.some((line) => line.includes('"type":"inference"') || line.includes('"type":"agent_exit"'))) {
      clearTimeout(timer);
      ws.close();
      resolve();
    }
  });

  ws.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("websocket error"));
  });
});

console.log("websocket", JSON.stringify(received));
