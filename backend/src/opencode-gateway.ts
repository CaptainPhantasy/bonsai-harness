const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ORIGIN = new URL(OPENCODE_ZEN_BASE_URL).origin;
const OPENCODE_ZEN_PATH = new URL(OPENCODE_ZEN_BASE_URL).pathname;
const GATEWAY_TIMEOUT_MS = 120_000;
const ALLOWED_METHODS = new Set(["GET", "POST"]);
const FORWARDED_HEADERS = new Set(["authorization", "content-type", "accept", "x-api-key"]);
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

export type GatewayFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type GatewayPayload = {
  targetUrl: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

export function isOpenCodeZenTarget(target: URL): boolean {
  return target.origin === OPENCODE_ZEN_ORIGIN
    && (target.pathname === OPENCODE_ZEN_PATH || target.pathname.startsWith(`${OPENCODE_ZEN_PATH}/`));
}

export async function handleOpenCodeGatewayRequest(req: Request, upstreamFetch: GatewayFetch = fetch): Promise<Response> {
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let payload: GatewayPayload;
  try {
    payload = parseGatewayPayload(await req.json());
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Invalid JSON body", 400);
  }

  let target: URL;
  try {
    target = new URL(payload.targetUrl);
  } catch {
    return errorResponse("targetUrl must be an absolute URL", 400);
  }
  if (!isOpenCodeZenTarget(target)) {
    return errorResponse("Gateway only allows requests to https://opencode.ai/zen/v1", 400);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await upstreamFetch(target, {
      method: payload.method,
      headers: sanitizeGatewayHeaders(payload.headers),
      ...(payload.method === "POST" && payload.body !== undefined ? { body: payload.body } : {}),
      signal: controller.signal,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: selectResponseHeaders(response.headers),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return errorResponse(isTimeout ? "Gateway request timed out" : "Gateway request failed", isTimeout ? 504 : 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseGatewayPayload(value: unknown): GatewayPayload {
  if (!isRecord(value)) throw new Error("Gateway request body must be a JSON object");
  const allowedKeys = new Set(["targetUrl", "method", "headers", "body"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("Gateway request contains an unsupported field");
  if (typeof value.targetUrl !== "string" || value.targetUrl.trim().length === 0) {
    throw new Error("targetUrl must be a non-empty string");
  }

  const method = typeof value.method === "string" ? value.method.toUpperCase() : "POST";
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Unsupported method ${method}`);

  const body = value.body === undefined ? undefined : parseBody(value.body);
  if (method === "GET" && body !== undefined) throw new Error("GET gateway requests must not include a body");
  return {
    targetUrl: value.targetUrl.trim(),
    method: method as GatewayPayload["method"],
    headers: parseHeaders(value.headers),
    ...(body === undefined ? {} : { body }),
  };
}

function parseBody(value: unknown): string {
  if (typeof value !== "string") throw new Error("body must be a string when provided");
  if (new TextEncoder().encode(value).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new Error(`body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  return value;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("headers must be an object when provided");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("headers must not contain more than 32 entries");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (typeof headerValue !== "string" || name.length === 0 || name.length > 128 || headerValue.length > 8_192 || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(headerValue)) {
      throw new Error("headers must contain single-line string names and values");
    }
    headers[name] = headerValue;
  }
  return headers;
}

function sanitizeGatewayHeaders(rawHeaders: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

function selectResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
