import { describe, expect, test } from 'bun:test'

import { apiFetch, isOpenCodeZenRequest, resolveHarnessWebSocketUrl } from './api'

describe('same-origin OpenCode gateway client', () => {
  test('recognizes only the exact OpenCode Zen path boundary', () => {
    expect(isOpenCodeZenRequest('https://opencode.ai/zen/v1/models')).toBe(true)
    expect(isOpenCodeZenRequest('https://opencode.ai/zen/v1')).toBe(true)
    expect(isOpenCodeZenRequest('https://opencode.ai/zen/v1evil/models')).toBe(false)
    expect(isOpenCodeZenRequest('https://example.test/zen/v1/models')).toBe(false)
  })

  test('intercepts an OpenCode request and sends it only to the relative gateway route', async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = []
    const response = await apiFetch('https://opencode.ai/zen/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'X-Drop': 'untrusted' },
      body: '{"model":"smoke"}',
    }, async (input, init) => {
      calls.push({ input, init })
      return new Response('ok')
    })

    expect(await response.text()).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe('/gateway')
    expect(calls[0]?.init?.method).toBe('POST')
    const payload = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(payload.targetUrl).toBe('https://opencode.ai/zen/v1/chat/completions')
    expect(payload.headers).toEqual({ authorization: 'Bearer test-key' })
  })

  test('passes local paths through unchanged and derives a same-origin WebSocket URL', async () => {
    let input = ''
    await apiFetch('/health', {}, async (url) => {
      input = String(url)
      return new Response('ok')
    })

    expect(input).toBe('/health')
    expect(resolveHarnessWebSocketUrl('http://127.0.0.1:11432')).toBe('ws://127.0.0.1:11432/ws')
    expect(resolveHarnessWebSocketUrl('https://harness.example.test')).toBe('wss://harness.example.test/ws')
  })
})
