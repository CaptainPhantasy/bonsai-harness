import { describe, expect, test } from "bun:test";

import { handleOpenCodeGatewayRequest, isOpenCodeZenTarget } from "../src/opencode-gateway";

function gatewayRequest(payload: unknown, method = "POST"): Request {
  return new Request("http://127.0.0.1:11431/gateway", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("OpenCode Zen gateway", () => {
  test("accepts only the exact OpenCode Zen path boundary", () => {
    expect(isOpenCodeZenTarget(new URL("https://opencode.ai/zen/v1/models"))).toBe(true);
    expect(isOpenCodeZenTarget(new URL("https://opencode.ai/zen/v1"))).toBe(true);
    expect(isOpenCodeZenTarget(new URL("https://opencode.ai/zen/v1evil/models"))).toBe(false);
    expect(isOpenCodeZenTarget(new URL("https://opencode.ai/zen/v11/models"))).toBe(false);
    expect(isOpenCodeZenTarget(new URL("https://example.test/zen/v1/models"))).toBe(false);
  });

  test("forwards an allowed request through the fixed upstream and strips unsafe headers", async () => {
    let upstreamUrl = "";
    let upstreamInit: RequestInit | undefined;
    const response = await handleOpenCodeGatewayRequest(gatewayRequest({
      targetUrl: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { Authorization: "Bearer gateway-test", "Content-Type": "application/json", "X-Unsafe": "drop-me" },
      body: "{\"model\":\"test\"}",
    }), async (url, init) => {
      upstreamUrl = String(url);
      upstreamInit = init;
      return new Response("gateway-ok", {
        status: 429,
        headers: { "content-type": "text/plain", "retry-after": "3", "set-cookie": "must-not-pass" },
      });
    });

    expect(upstreamUrl).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(upstreamInit?.method).toBe("POST");
    expect(new Headers(upstreamInit?.headers).get("authorization")).toBe("Bearer gateway-test");
    expect(new Headers(upstreamInit?.headers).get("x-unsafe")).toBeNull();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe("gateway-ok");
  });

  test("rejects an arbitrary upstream, unsupported method, and malformed forwarded input", async () => {
    const arbitrary = await handleOpenCodeGatewayRequest(gatewayRequest({ targetUrl: "https://example.test/" }));
    const unsupportedMethod = await handleOpenCodeGatewayRequest(gatewayRequest({ targetUrl: "https://opencode.ai/zen/v1/models", method: "DELETE" }));
    const malformedHeaders = await handleOpenCodeGatewayRequest(gatewayRequest({
      targetUrl: "https://opencode.ai/zen/v1/models",
      headers: { authorization: "Bearer safe\nInjected: bad" },
    }));

    expect(arbitrary.status).toBe(400);
    expect(await arbitrary.json()).toEqual({ error: "Gateway only allows requests to https://opencode.ai/zen/v1" });
    expect(unsupportedMethod.status).toBe(400);
    expect(malformedHeaders.status).toBe(400);
  });

  test("maps an aborted upstream request to a bounded timeout response", async () => {
    const response = await handleOpenCodeGatewayRequest(gatewayRequest({
      targetUrl: "https://opencode.ai/zen/v1/models",
      method: "GET",
    }), async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Gateway request timed out" });
  });
});
