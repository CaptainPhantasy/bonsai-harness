export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type GatewayRequest = {
  targetUrl: string
  method: string
  headers: Record<string, string>
  body?: string
}

const OPENCODE_ZEN_ORIGIN = new URL(OPENCODE_ZEN_BASE_URL).origin
const OPENCODE_ZEN_PATH = new URL(OPENCODE_ZEN_BASE_URL).pathname
const FORWARDED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-api-key'])

export function resolveHarnessWebSocketUrl(origin = window.location.origin): string {
  const url = new URL('/ws', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function isOpenCodeZenRequest(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === OPENCODE_ZEN_ORIGIN
      && (parsed.pathname === OPENCODE_ZEN_PATH || parsed.pathname.startsWith(`${OPENCODE_ZEN_PATH}/`))
  } catch {
    return false
  }
}

export async function apiFetch(url: string, init: RequestInit = {}, fetchImpl: FetchLike = fetch): Promise<Response> {
  if (!isOpenCodeZenRequest(url)) return fetchImpl(url, init)

  if (init.body !== undefined && typeof init.body !== 'string') {
    throw new Error('The OpenCode gateway accepts only string request bodies')
  }

  const request: GatewayRequest = {
    targetUrl: url,
    method: (init.method ?? 'POST').toUpperCase(),
    headers: extractForwardedHeaders(init.headers),
    ...(typeof init.body === 'string' ? { body: init.body } : {}),
  }
  return fetchImpl('/gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
}

function extractForwardedHeaders(value: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(value)
  const forwarded: Record<string, string> = {}
  headers.forEach((headerValue, headerName) => {
    if (FORWARDED_HEADERS.has(headerName.toLowerCase())) forwarded[headerName] = headerValue
  })
  return forwarded
}
