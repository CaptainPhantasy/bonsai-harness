import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Cpu, FolderGit2, HardDrive, Radio, Terminal, Zap } from 'lucide-react'

type Agent = { id: string; status: 'idle' | 'active' | 'exited' | 'error'; modelId?: string; runtimeKind?: RuntimeKind }
type RuntimeKind = 'local-command' | 'openai-compatible'
type HarnessEvent =
  | { type: 'status'; payload: string }
  | { type: 'error'; payload: string; agentId?: string }
  | { type: 'inference'; agentId: string; payload: string }
  | { type: 'agent_exit'; agentId: string; code: number | null; signal: string | null }
  | { type: 'mcp_response'; server: string; payload: string }
  | { type: 'sandbox_write'; path: string; payload: string }

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HEALTH_POLL_MS = 5_000

const MAX_LOGS = 250
const DEFAULT_BACKEND_URL = 'http://localhost:11431'
const DEFAULT_MODEL_ID = 'prism-ml/Ternary-Bonsai-8B-mlx-2bit'
const DEFAULT_PROMPT = 'You are a deterministic code generation agent optimized for concise inference.'

function appendBoundedLog(lines: string[], line: string) {
  const next = [...lines, line]
  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
}

function resolveBackendWebSocketUrl(rawBackendUrl: string | undefined) {
  const raw = rawBackendUrl?.trim() || DEFAULT_BACKEND_URL
  const url = new URL(raw)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported backend URL protocol: ${url.protocol}`)
  }
  return url.toString().replace(/\/$/, '')
}

export default function HarnessDashboard() {
  const [logs, setLogs] = useState<string[]>(['[SYSTEM] Dashboard initialized'])
  const [agents, setAgents] = useState<Agent[]>([{ id: 'CodeGen-01', status: 'idle' }])
  const [connected, setConnected] = useState(false)
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID)
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>('local-command')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS)
  const backendWsUrl = useMemo(() => resolveBackendWebSocketUrl(import.meta.env.VITE_HARNESS_BACKEND_URL), [])
  const backendHttpUrl = useMemo(() => import.meta.env.VITE_HARNESS_BACKEND_URL?.trim() || DEFAULT_BACKEND_URL, [])

  const formatEvent = useCallback((event: HarnessEvent) => {
    switch (event.type) {
      case 'inference':
        return `[${event.agentId}] ${event.payload}`
      case 'agent_exit':
        return `[${event.agentId}] exited code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`
      case 'mcp_response':
        return `[MCP:${event.server}] ${event.payload}`
      case 'sandbox_write':
        return `[SANDBOX] ${event.payload}`
      case 'error':
        return `[ERROR${event.agentId ? `:${event.agentId}` : ''}] ${event.payload}`
      case 'status':
        return `[SYSTEM] ${event.payload}`
    }
  }, [])


  useEffect(() => {
    let disposed = false

    function connect() {
      if (disposed) return
      const ws = new WebSocket(backendWsUrl)
      socketRef.current = ws

      ws.onopen = () => {
        if (disposed) return
        reconnectDelayRef.current = RECONNECT_BASE_MS
        setConnected(true)
        setLogs((prev) => appendBoundedLog(prev, '[WS] Connected to backend orchestrator'))
      }

      ws.onmessage = (event) => {
        if (disposed) return
        let data: HarnessEvent
        try {
          data = JSON.parse(event.data) as HarnessEvent
        } catch {
          setLogs((prev) => appendBoundedLog(prev, `[ERROR] Ignored malformed backend event: ${String(event.data)}`))
          return
        }

        if (data.type === 'agent_exit') {
          setAgents((prev) => prev.map((agent) => agent.id === data.agentId ? { ...agent, status: 'exited' } : agent))
        }
        if (data.type === 'error' && data.agentId) {
          setAgents((prev) => prev.map((agent) => agent.id === data.agentId ? { ...agent, status: 'error' } : agent))
        }
        setLogs((prev) => appendBoundedLog(prev, formatEvent(data)))
      }

      ws.onclose = () => {
        if (disposed) return
        setConnected(false)
        setLogs((prev) => appendBoundedLog(prev, '[WS] Disconnected, reconnecting...'))
        const delay = reconnectDelayRef.current
        reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS)
        setTimeout(connect, delay)
      }

      ws.onerror = () => {
        if (disposed) return
        setConnected(false)
      }
    }

    connect()
    return () => { disposed = true; socketRef.current?.close() }
  }, [backendWsUrl, formatEvent])

  // Health polling
  useEffect(() => {
    let disposed = false
    function poll() {
      if (disposed) return
      fetch(`${backendHttpUrl}/health`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (!disposed && data) setHealth(data as Record<string, unknown>) })
        .catch(() => { if (!disposed) setHealth(null) })
    }
    poll()
    const id = setInterval(poll, HEALTH_POLL_MS)
    return () => { disposed = true; clearInterval(id) }
  }, [backendHttpUrl])

  const activeCount = useMemo(() => agents.filter((agent) => agent.status === 'active').length, [agents])
  const canSpawn = connected && modelId.trim().length > 0 && prompt.trim().length > 0

  const spawnAgent = () => {
    const nextId = `Worker-${agents.length + 1}`
    const trimmedModelId = modelId.trim()
    const trimmedPrompt = prompt.trim()
    setAgents((prev) => [...prev, { id: nextId, status: 'active', modelId: trimmedModelId, runtimeKind }])
    socketRef.current?.send(JSON.stringify({
      action: 'spawn_agent',
      agentId: nextId,
      prompt: trimmedPrompt,
      modelId: trimmedModelId,
      runtimeKind,
    }))
  }

  return (
    <main className="flex h-screen overflow-hidden bg-tokyo-bg text-tokyo-text">
      <aside className="flex w-80 shrink-0 flex-col border-r border-tokyo-border bg-tokyo-panel/95 p-4 shadow-neon">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="flex items-center text-sm font-bold uppercase tracking-[0.24em] text-tokyo-pink">
            <Cpu className="mr-2" size={18} aria-hidden="true" /> Cluster
          </h2>
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-tokyo-cyan shadow-[0_0_16px_#7dcfff]' : 'bg-tokyo-border'}`} aria-label={connected ? 'backend connected' : 'backend disconnected'} />
        </div>

        <form className="mb-5 space-y-3" onSubmit={(event) => { event.preventDefault(); if (canSpawn) spawnAgent() }}>
          <label className="block text-xs font-bold uppercase tracking-[0.18em] text-tokyo-border" htmlFor="model-id">
            Model ID
          </label>
          <input
            id="model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            className="w-full rounded border border-tokyo-border bg-tokyo-bg px-3 py-2 text-xs text-tokyo-text outline-none transition focus:border-tokyo-cyan focus:ring-2 focus:ring-tokyo-cyan/40"
            aria-describedby="model-id-help"
          />
          <p id="model-id-help" className="text-[11px] leading-5 text-tokyo-border">Any local or API model identifier accepted by the selected runtime.</p>

          <label className="block text-xs font-bold uppercase tracking-[0.18em] text-tokyo-border" htmlFor="runtime-kind">
            Runtime
          </label>
          <select
            id="runtime-kind"
            value={runtimeKind}
            onChange={(event) => setRuntimeKind(event.target.value as RuntimeKind)}
            className="w-full rounded border border-tokyo-border bg-tokyo-bg px-3 py-2 text-xs text-tokyo-text outline-none transition focus:border-tokyo-cyan focus:ring-2 focus:ring-tokyo-cyan/40"
          >
            <option value="local-command">Local command</option>
            <option value="openai-compatible">OpenAI-compatible API</option>
          </select>

          <label className="block text-xs font-bold uppercase tracking-[0.18em] text-tokyo-border" htmlFor="agent-prompt">
            Prompt
          </label>
          <textarea
            id="agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            className="w-full resize-none rounded border border-tokyo-border bg-tokyo-bg px-3 py-2 text-xs text-tokyo-text outline-none transition focus:border-tokyo-cyan focus:ring-2 focus:ring-tokyo-cyan/40"
          />

          <button
            type="submit"
            disabled={!canSpawn}
            className="w-full rounded border border-tokyo-purple bg-tokyo-purple/15 px-4 py-2 text-left text-sm font-bold text-tokyo-purple transition hover:bg-tokyo-purple hover:text-tokyo-bg focus:outline-none focus:ring-2 focus:ring-tokyo-purple/60 disabled:cursor-not-allowed disabled:opacity-45"
          >
            + Spawn Model Worker
          </button>
        </form>

        <div className="grid grid-cols-2 gap-2 pb-4 text-xs">
          <Metric label="Active" value={String(activeCount)} />
          <Metric label="Max" value={String(health?.maxActiveAgents ?? '-')} />
          <Metric label="Model" value={health?.runnerBinaryPresent ? '\u2713' : '\u2717'} />
          <Metric label="Log cap" value={String(MAX_LOGS)} />
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" aria-label="Cluster nodes">
          {agents.map((agent) => (
            <div key={agent.id} className="rounded border border-tokyo-border bg-tokyo-bg/80 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">{agent.id}</span>
                <Activity size={15} className={agent.status === 'active' ? 'animate-pulse text-tokyo-cyan' : agent.status === 'error' ? 'text-tokyo-pink' : 'text-tokyo-border'} aria-hidden="true" />
              </div>
              {agent.modelId ? <div className="mt-2 break-all text-[11px] leading-4 text-tokyo-border">{agent.runtimeKind}: {agent.modelId}</div> : null}
            </div>
          ))}
        </div>

        <div className="mt-4 border-t border-tokyo-border pt-4">
          <h3 className="mb-2 text-xs uppercase tracking-[0.2em] text-tokyo-border">MCP bus</h3>
          <div className="flex items-center text-sm text-tokyo-cyan"><FolderGit2 size={14} className="mr-2" aria-hidden="true" /> Local-FS-Server</div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-tokyo-border px-6">
          <h1 className="text-lg font-black uppercase tracking-[0.32em] text-tokyo-purple drop-shadow-[0_0_10px_rgba(187,154,247,0.55)]">
            Legacy AI // Model Harness
          </h1>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-tokyo-cyan">
            <Radio size={14} aria-hidden="true" /> {backendWsUrl}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-6" role="log" aria-live="polite">
          <div className="space-y-2 rounded border border-tokyo-border bg-[#15161e]/80 p-4 shadow-inner">
            {logs.map((log, index) => (
              <div key={`${index}-${log.slice(0, 16)}`} className="whitespace-pre-wrap break-words text-sm leading-6">
                <span className="mr-2 text-tokyo-pink">➜</span>{log}
              </div>
            ))}
          </div>
        </div>
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l border-tokyo-border bg-tokyo-panel/95 p-4">
        <h2 className="mb-4 flex items-center text-sm font-bold uppercase tracking-[0.2em] text-tokyo-cyan">
          <HardDrive className="mr-2" size={18} aria-hidden="true" /> SanDisk1Tb
        </h2>
        <div className="flex-1 rounded border border-tokyo-border bg-tokyo-bg p-3 text-xs leading-6 text-tokyo-border">
          drwxr-xr-x sandbox/<br />
          drwxr-xr-x models/<br />
          drwxr-xr-x logs/<br />
          -rw-r--r-- telemetry.json
        </div>
        <div className="mt-4 h-48 overflow-y-auto rounded border border-tokyo-border bg-[#15161e] p-3">
          <div className="mb-2 flex items-center text-xs uppercase tracking-[0.18em] text-tokyo-border"><Terminal size={12} className="mr-2" aria-hidden="true" /> Runtime config</div>
          <p className="text-sm text-tokyo-text">Local command mode uses <code className="text-tokyo-cyan">HARNESS_RUNNER_BINARY</code> and <code className="text-tokyo-cyan">HARNESS_RUNNER_ARGS_TEMPLATE</code>. API keys stay on the backend.</p>
          <div className="mt-4 flex items-center text-xs text-tokyo-purple"><Zap size={12} className="mr-2" aria-hidden="true" /> bounded log stream prevents UI memory blowups</div>
        </div>
      </aside>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-tokyo-border bg-tokyo-bg px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-tokyo-border">{label}</div>
      <div className="text-lg font-bold text-tokyo-cyan">{value}</div>
    </div>
  )
}

