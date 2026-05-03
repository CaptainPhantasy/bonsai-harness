import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ChevronDown, Circle, Cpu, FolderOpen, HardDrive,
  CalendarCheck, ListChecks, WandSparkles, Archive,
  Plus, Send, Settings, Terminal, Zap, X, Search, Sun, Moon,
  Copy, Check, ThumbsUp, ThumbsDown, Download, Keyboard, Maximize2, Minimize2,
  Square, Trash2, Pencil, Paperclip, Sparkles, AlertCircle, FileText,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { useLocalStorage, useSystemTheme, useScrollPosition } from './hooks/useLocalStorage'

/* ── Types ── */
type Agent = { id: string; status: 'idle' | 'active' | 'exited' | 'error'; modelId?: string; runtimeKind?: RuntimeKind }
type RuntimeKind = 'local-command' | 'openai-compatible'
type HarnessEvent =
  | { type: 'status'; payload: string }
  | { type: 'error'; payload: string; agentId?: string }
  | { type: 'inference'; agentId: string; payload: string }
  | { type: 'agent_exit'; agentId: string; code: number | null; signal: string | null }
  | { type: 'mcp_response'; server: string; payload: string }
  | { type: 'sandbox_write'; path: string; payload: string }

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  feedback?: 'up' | 'down' | null
  timestamp: number
  attachments?: AttachedFile[]
}

type AttachedFile = { id: string; name: string; size: number; type: string }

type Conversation = {
  id: string
  name: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

/* ── Constants ── */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HEALTH_POLL_MS = 5_000
const MAX_LOGS = 250
const MAX_INPUT_CHARS = 8_000
const DEFAULT_BACKEND_URL = 'http://localhost:11431'
const DEFAULT_MODEL_ID = 'prism-ml/Ternary-Bonsai-8B-mlx-2bit'
const DEFAULT_PROMPT = 'You are a deterministic code generation agent optimized for concise inference.'

const PRESET_MODELS = [
  { id: 'prism-ml/Ternary-Bonsai-8B-mlx-2bit', label: 'Ternary Bonsai 8B', description: '2-bit MLX, low memory' },
  { id: 'mlx-community/Llama-3.2-3B-Instruct-4bit', label: 'Llama 3.2 3B', description: 'Fast inference, instruct-tuned' },
  { id: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', label: 'Qwen2.5 Coder 7B', description: 'Code-specialized' },
  { id: 'mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit', label: 'DeepSeek R1 7B', description: 'Reasoning-focused' },
] as const

const SUGGESTED_PROMPTS = [
  { icon: '🔍', label: 'Explain this codebase', prompt: 'Walk me through the architecture of this codebase. Start with entry points.' },
  { icon: '🐛', label: 'Find bugs', prompt: 'Review the most recently modified files and surface likely bugs.' },
  { icon: '✨', label: 'Refactor for clarity', prompt: 'Identify the most tangled module and propose a refactor plan.' },
  { icon: '📝', label: 'Write tests', prompt: 'Find untested logic and propose unit tests for the highest-value paths.' },
] as const

/* ── Utilities ── */
function generateId() {
  return Math.random().toString(36).substring(2, 9)
}

function appendBoundedLog(lines: string[], line: string) {
  const next = [...lines, line]
  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
}

function resolveBackendWebSocketUrl(rawBackendUrl: string | undefined) {
  const raw = rawBackendUrl?.trim() || DEFAULT_BACKEND_URL
  const url = new URL(raw)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`Unsupported protocol: ${url.protocol}`)
  return url.toString().replace(/\/$/, '')
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ── Sub-components ── */

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick?: () => void }) {
  return (
    <div className="mb-0.5">
      <button
        onClick={onClick}
        className={`nav-item-transition flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] ${
          active ? 'bg-mm-surface-active text-mm-text' : 'text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text'
        }`}
      >
        {icon} {label}
      </button>
    </div>
  )
}

function SectionHeader({ label, actionIcon, onAction }: { label: string; actionIcon?: React.ReactNode; onAction?: () => void }) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-mm-text-tertiary">{label}</span>
      {actionIcon && onAction && (
        <button onClick={onAction} className="nav-item-transition text-mm-text-tertiary hover:text-mm-text-secondary">
          {actionIcon}
        </button>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[13px] font-medium text-mm-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-mm-text-tertiary">{hint}</p>}
    </div>
  )
}

function PlaceholderPanel({ title, icon, onBack }: { title: string; icon: React.ReactNode; onBack: () => void }) {
  return (
    <div className="panel-animate-in flex-1 overflow-y-auto px-8 py-6 custom-scrollbar">
      <div className="mx-auto max-w-xl">
        <button onClick={onBack} className="nav-item-transition mb-6 flex items-center gap-1.5 text-[13px] text-mm-text-secondary hover:text-mm-text">
          ← Back
        </button>
        <div className="flex flex-col items-center justify-center py-16">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-mm-surface text-mm-text-secondary">
            {icon}
          </div>
          <h2 className="mb-2 text-[18px] font-semibold text-mm-text">{title}</h2>
          <p className="text-[14px] text-mm-text-secondary">Coming soon — this section is under active development.</p>
        </div>
      </div>
    </div>
  )
}

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false)
  const code = String(children).replace(/\n$/, '')
  const language = className?.replace('language-', '') || ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      toast.success('Code copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not access clipboard')
    }
  }

  return (
    <div className="relative group my-2">
      {language && (
        <div className="absolute left-3 top-2 text-[10px] font-mono uppercase tracking-wider text-mm-text-tertiary">
          {language}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-mm-surface-hover"
        title={copied ? 'Copied!' : 'Copy code'}
        aria-label="Copy code"
      >
        {copied ? <Check size={14} className="text-mm-green" /> : <Copy size={14} />}
      </button>
      <pre className={`overflow-x-auto rounded-lg bg-mm-surface-hover p-3 pr-10 text-[13px] ${language ? 'pt-8' : ''}`}>
        <code className={className}>{code}</code>
      </pre>
    </div>
  )
}

function MessageActions({
  message, onCopy, onFeedback,
}: {
  message: ChatMessage
  onCopy: () => void
  onFeedback: (feedback: 'up' | 'down' | null) => void
}) {
  return (
    <div className="absolute -top-3 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button onClick={onCopy} className="rounded bg-mm-surface p-1 shadow-sm hover:bg-mm-surface-hover" title="Copy message" aria-label="Copy message">
        <Copy size={12} />
      </button>
      {message.role === 'assistant' && (
        <>
          <button
            onClick={() => onFeedback(message.feedback === 'up' ? null : 'up')}
            className={`rounded p-1 shadow-sm ${message.feedback === 'up' ? 'bg-mm-accent text-white' : 'bg-mm-surface hover:bg-mm-surface-hover'}`}
            title="Good response"
            aria-label="Good response"
          >
            <ThumbsUp size={12} />
          </button>
          <button
            onClick={() => onFeedback(message.feedback === 'down' ? null : 'down')}
            className={`rounded p-1 shadow-sm ${message.feedback === 'down' ? 'bg-mm-red text-white' : 'bg-mm-surface hover:bg-mm-surface-hover'}`}
            title="Poor response"
            aria-label="Poor response"
          >
            <ThumbsDown size={12} />
          </button>
        </>
      )}
    </div>
  )
}

function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { keys: ['⌘', 'K'], description: 'Open command palette' },
    { keys: ['⌘', 'N'], description: 'New conversation' },
    { keys: ['⌘', ','], description: 'Open settings' },
    { keys: ['⌘', 'Enter'], description: 'Send message' },
    { keys: ['⌘', 'B'], description: 'Toggle sidebar' },
    { keys: ['⌘', 'L'], description: 'Clear chat' },
    { keys: ['⌘', 'E'], description: 'Export conversation' },
    { keys: ['⌘', 'Shift', '?'], description: 'Show shortcuts' },
    { keys: ['Escape'], description: 'Close modal/palette/stop generation' },
    { keys: ['↑', '↓'], description: 'Navigate palette' },
    { keys: ['Enter'], description: 'Select palette item' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-mm-border bg-mm-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold text-mm-text">
            <Keyboard size={20} /> Keyboard Shortcuts
          </h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-mm-surface-hover" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((shortcut, i) => (
            <div key={i} className="flex items-center justify-between py-1.5">
              <span className="text-[13px] text-mm-text-secondary">{shortcut.description}</span>
              <div className="flex gap-1">
                {shortcut.keys.map((key, j) => (
                  <kbd key={j} className="rounded bg-mm-surface-hover px-2 py-1 text-[12px] font-medium text-mm-text">
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ConfirmModal({
  title, message, confirmLabel, onConfirm, onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-xl border border-mm-border bg-mm-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <AlertCircle size={20} className="text-mm-red" />
          <h2 className="text-[15px] font-semibold text-mm-text">{title}</h2>
        </div>
        <p className="mb-5 text-[13px] text-mm-text-secondary">{message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-[13px] text-mm-text-secondary hover:bg-mm-surface-hover">
            Cancel
          </button>
          <button onClick={onConfirm} className="rounded-lg bg-mm-red px-4 py-2 text-[13px] font-medium text-white hover:opacity-90">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className, node, ...rest } = props as { children: React.ReactNode; className?: string; node?: unknown }
            void node
            const isBlock = className?.startsWith('language-')
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>
            }
            return (
              <code {...rest} className="rounded bg-mm-surface-hover px-1.5 py-0.5 font-mono text-[12px] text-mm-accent">
                {children}
              </code>
            )
          },
          a({ children, href, ...rest }) {
            return (
              <a {...rest} href={href} target="_blank" rel="noreferrer" className="text-mm-accent underline hover:opacity-80">
                {children}
              </a>
            )
          },
          ul({ children }) {
            return <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>
          },
          ol({ children }) {
            return <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>
          },
          h1({ children }) { return <h1 className="mb-2 mt-3 text-[18px] font-semibold">{children}</h1> },
          h2({ children }) { return <h2 className="mb-2 mt-3 text-[16px] font-semibold">{children}</h2> },
          h3({ children }) { return <h3 className="mb-1 mt-2 text-[14px] font-semibold">{children}</h3> },
          p({ children }) { return <p className="mb-2 last:mb-0">{children}</p> },
          blockquote({ children }) {
            return <blockquote className="my-2 border-l-2 border-mm-border pl-3 italic text-mm-text-secondary">{children}</blockquote>
          },
          table({ children }) {
            return <table className="my-2 w-full border-collapse text-[13px]">{children}</table>
          },
          th({ children }) {
            return <th className="border border-mm-border bg-mm-surface-hover px-2 py-1 text-left">{children}</th>
          },
          td({ children }) {
            return <td className="border border-mm-border px-2 py-1">{children}</td>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function FileChip({ file, onRemove }: { file: AttachedFile; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-mm-surface-hover px-2 py-1 text-[12px] text-mm-text-secondary">
      <FileText size={12} />
      <span className="max-w-[200px] truncate min-w-0" title={file.name}>{file.name}</span>
      <span className="text-[10px] text-mm-text-tertiary">{formatBytes(file.size)}</span>
      <button onClick={onRemove} className="rounded hover:bg-mm-surface" aria-label={`Remove ${file.name}`}>
        <X size={12} />
      </button>
    </div>
  )
}

function ConversationItem({
  conv, active, onSelect, onDelete, onRename,
}: {
  conv: Conversation
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.name)

  const commitRename = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== conv.name) onRename(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="mb-0.5 flex items-center gap-2 px-3 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setDraft(conv.name); setEditing(false) }
          }}
          className="flex-1 rounded border border-mm-accent bg-mm-main-bg px-2 py-1 text-[13px] text-mm-text outline-none"
        />
      </div>
    )
  }

  return (
    <div className="group mb-0.5 flex items-center gap-1">
      <button
        onClick={onSelect}
        className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-[13px] focus:outline-none focus:ring-1 focus:ring-mm-accent/50 ${active ? 'bg-mm-surface-active text-mm-text' : 'text-mm-text-secondary hover:bg-mm-surface-hover'}`}
        title={conv.name}
      >
        {conv.name}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setEditing(true) }}
        className="rounded p-1 opacity-0 hover:bg-mm-surface-hover group-hover:opacity-100"
        title="Rename"
        aria-label="Rename conversation"
      >
        <Pencil size={12} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="rounded p-1 opacity-0 hover:bg-mm-surface-hover group-hover:opacity-100"
        title="Delete"
        aria-label="Delete conversation"
      >
        <X size={12} />
      </button>
    </div>
  )
}

/* ── Main App ── */

type PaletteItem = { id: string; label: string; icon: React.ReactNode; shortcut?: string; action: () => void }

export default function HarnessDashboard() {
  /* ── State ── */
  const [logs, setLogs] = useState<string[]>(['[SYSTEM] Dashboard initialized'])
  const [agents, setAgents] = useState<Agent[]>([{ id: 'CodeGen-01', status: 'idle' }])
  const [connected, setConnected] = useState(false)
  const [modelId, setModelId] = useLocalStorage<string>('bonsai-model-id', DEFAULT_MODEL_ID)
  const [runtimeKind, setRuntimeKind] = useLocalStorage<RuntimeKind>('bonsai-runtime-kind', 'local-command')
  const [prompt, setPrompt] = useLocalStorage<string>('bonsai-system-prompt', DEFAULT_PROMPT)
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const [inputMessage, setInputMessage] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [sidebarView, setSidebarView] = useState<'agents' | 'settings' | 'skills' | 'schedules' | 'archived'>('agents')
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [theme, setTheme] = useLocalStorage<'minimax' | 'bonsai'>('bonsai-theme', 'minimax')
  const [isLight, setIsLight] = useLocalStorage<boolean>('bonsai-light-mode', false)
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>('bonsai-sidebar-open', true)
  const [logsExpanded, setLogsExpanded] = useLocalStorage<boolean>('bonsai-logs-expanded', false)
  const [conversations, setConversations] = useLocalStorage<Conversation[]>('bonsai-conversations', [])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const systemTheme = useSystemTheme()
  const effectiveLight = isLight || (theme !== 'bonsai' && systemTheme === 'light')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const isScrolledUp = useScrollPosition(chatContainerRef)

  const backendWsUrl = useMemo(() => resolveBackendWebSocketUrl(import.meta.env.VITE_HARNESS_BACKEND_URL), [])
  const backendHttpUrl = useMemo(() => import.meta.env.VITE_HARNESS_BACKEND_URL?.trim() || DEFAULT_BACKEND_URL, [])

  /* ── Formatters ── */
  const formatEvent = useCallback((event: HarnessEvent) => {
    switch (event.type) {
      case 'inference': return `[${event.agentId}] ${event.payload}`
      case 'agent_exit': return `[${event.agentId}] exited code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`
      case 'mcp_response': return `[MCP:${event.server}] ${event.payload}`
      case 'sandbox_write': return `[SANDBOX] ${event.payload}`
      case 'error': return `[ERROR${event.agentId ? `:${event.agentId}` : ''}] ${event.payload}`
      case 'status': return `[SYSTEM] ${event.payload}`
    }
  }, [])

  /* ── WebSocket Connection ── */
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
        try { data = JSON.parse(event.data) as HarnessEvent } catch { return }
        if (data.type === 'inference') {
          setIsStreaming(true)
          setChatMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: last.content + data.payload }]
            }
            return [...prev, { id: generateId(), role: 'assistant', content: data.payload, timestamp: Date.now() }]
          })
        }
        if (data.type === 'agent_exit') {
          setAgents((prev) => prev.map((a) => a.id === data.agentId ? { ...a, status: 'exited' } : a))
          setIsStreaming(false)
        }
        if (data.type === 'error') {
          setIsStreaming(false)
          if (data.agentId) {
            setAgents((prev) => prev.map((a) => a.id === data.agentId ? { ...a, status: 'error' } : a))
          }
          toast.error(data.payload)
        }
        setLogs((prev) => appendBoundedLog(prev, formatEvent(data)))
      }
      ws.onclose = () => {
        if (disposed) return
        setConnected(false)
        setIsStreaming(false)
        setLogs((prev) => appendBoundedLog(prev, '[WS] Disconnected, reconnecting...'))
        const delay = reconnectDelayRef.current
        reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS)
        setTimeout(connect, delay)
      }
      ws.onerror = () => { if (!disposed) setConnected(false) }
    }
    connect()
    return () => { disposed = true; socketRef.current?.close() }
  }, [backendWsUrl, formatEvent])

  /* ── Health Polling ── */
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

  /* ── Auto-scroll with user override ── */
  useEffect(() => {
    if (!isScrolledUp && chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [chatMessages, isScrolledUp])

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  /* ── Persist active conversation as it grows ── */
  useEffect(() => {
    if (!activeConversationId || chatMessages.length === 0) return
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversationId ? { ...c, messages: chatMessages, updatedAt: Date.now() } : c
      )
    )
  }, [chatMessages, activeConversationId, setConversations])

  /* ── Computed ── */
  const activeCount = useMemo(() => agents.filter((a) => a.status === 'active').length, [agents])
  const canSpawn = connected && modelId.trim().length > 0 && prompt.trim().length > 0
  const inputCharsRemaining = MAX_INPUT_CHARS - inputMessage.length
  const inputAtLimit = inputCharsRemaining <= 100

  /* ── Stable action callbacks ── */
  const spawnAgent = useCallback(() => {
    const nextId = `Worker-${agents.length + 1}`
    const trimmedModelId = modelId.trim()
    const trimmedPrompt = prompt.trim()
    setAgents((prev) => [...prev, { id: nextId, status: 'active', modelId: trimmedModelId, runtimeKind }])
    socketRef.current?.send(JSON.stringify({
      action: 'spawn_agent', agentId: nextId, prompt: trimmedPrompt, modelId: trimmedModelId, runtimeKind,
    }))
    toast.success(`Spawned ${nextId}`)
  }, [agents.length, modelId, prompt, runtimeKind])

  const handleSend = useCallback(() => {
    const trimmed = inputMessage.trim()
    if (!trimmed || !connected || isStreaming) return
    if (trimmed.length > MAX_INPUT_CHARS) {
      toast.error(`Message too long (max ${MAX_INPUT_CHARS} chars)`)
      return
    }
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      attachments: pendingFiles.length > 0 ? pendingFiles : undefined,
    }
    setChatMessages((prev) => [...prev, userMessage])
    setIsStreaming(true)
    socketRef.current?.send(JSON.stringify({
      action: 'send_message',
      payload: trimmed,
      attachments: pendingFiles.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    }))
    setInputMessage('')
    setPendingFiles([])
  }, [inputMessage, connected, isStreaming, pendingFiles])

  const stopGeneration = useCallback(() => {
    if (!isStreaming) return
    socketRef.current?.send(JSON.stringify({ action: 'stop_generation' }))
    setIsStreaming(false)
    toast.info('Stopped generation')
  }, [isStreaming])

  const toggleTheme = useCallback(() => {
    setTheme((t) => t === 'minimax' ? 'bonsai' : 'minimax')
  }, [setTheme])

  const toggleLight = useCallback(() => {
    setIsLight((v) => !v)
  }, [setIsLight])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => !v)
  }, [setSidebarOpen])

  /* ── Message Actions ── */
  const copyMessage = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Could not access clipboard')
    }
  }, [])

  const setFeedback = useCallback((messageId: string, feedback: 'up' | 'down' | null) => {
    setChatMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, feedback } : m))
  }, [])

  /* ── Conversation Management ── */
  const saveConversation = useCallback(() => {
    if (chatMessages.length === 0) return null
    const name = chatMessages[0]?.content.slice(0, 40) || 'Untitled'
    const newConv: Conversation = {
      id: generateId(),
      name,
      messages: chatMessages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setConversations((prev) => [newConv, ...prev])
    return newConv.id
  }, [chatMessages, setConversations])

  const loadConversation = useCallback((id: string) => {
    const conv = conversations.find((c) => c.id === id)
    if (conv) {
      setChatMessages(conv.messages)
      setActiveConversationId(id)
    }
  }, [conversations])

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeConversationId === id) {
      setActiveConversationId(null)
      setChatMessages([])
    }
    toast.success('Conversation deleted')
  }, [activeConversationId, setConversations])

  const renameConversation = useCallback((id: string, newName: string) => {
    setConversations((prev) =>
      prev.map((c) => c.id === id ? { ...c, name: newName, updatedAt: Date.now() } : c)
    )
  }, [setConversations])

  const newConversation = useCallback(() => {
    if (chatMessages.length > 0 && !activeConversationId) {
      saveConversation()
    }
    setChatMessages([])
    setActiveConversationId(null)
    setPendingFiles([])
  }, [chatMessages.length, activeConversationId, saveConversation])

  const clearChat = useCallback(() => {
    setChatMessages([])
    setActiveConversationId(null)
    setPendingFiles([])
    setShowClearConfirm(false)
    toast.success('Chat cleared')
  }, [])

  const exportConversation = useCallback(() => {
    if (chatMessages.length === 0) {
      toast.error('Nothing to export')
      return
    }
    const markdown = chatMessages
      .map((m) => `**${m.role === 'user' ? 'User' : 'Assistant'}** (${formatTimestamp(m.timestamp)})\n\n${m.content}`)
      .join('\n\n---\n\n')

    const blob = new Blob(
      [`# Bonsai Conversation\n\nExported: ${new Date().toLocaleString()}\n\n${markdown}`],
      { type: 'text/markdown' }
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bonsai-conversation-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Conversation exported')
  }, [chatMessages])

  /* ── File Handling ── */
  const addFiles = useCallback((files: FileList | File[]) => {
    const newFiles: AttachedFile[] = Array.from(files).map((f) => ({
      id: generateId(),
      name: f.name,
      size: f.size,
      type: f.type,
    }))
    setPendingFiles((prev) => [...prev, ...newFiles])
    toast.success(`Attached ${newFiles.length} file${newFiles.length === 1 ? '' : 's'}`)
  }, [])

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  /* ── Drag and Drop ── */
  useEffect(() => {
    const node = dropZoneRef.current
    if (!node) return

    let dragCounter = 0
    const handleEnter = (e: DragEvent) => {
      e.preventDefault()
      dragCounter++
      if (e.dataTransfer?.types.includes('Files')) setIsDragOver(true)
    }
    const handleLeave = (e: DragEvent) => {
      e.preventDefault()
      dragCounter--
      if (dragCounter <= 0) { dragCounter = 0; setIsDragOver(false) }
    }
    const handleOver = (e: DragEvent) => { e.preventDefault() }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      dragCounter = 0
      setIsDragOver(false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files)
      }
    }

    node.addEventListener('dragenter', handleEnter)
    node.addEventListener('dragleave', handleLeave)
    node.addEventListener('dragover', handleOver)
    node.addEventListener('drop', handleDrop)

    return () => {
      node.removeEventListener('dragenter', handleEnter)
      node.removeEventListener('dragleave', handleLeave)
      node.removeEventListener('dragover', handleOver)
      node.removeEventListener('drop', handleDrop)
    }
  }, [addFiles])

  /* ── Keyboard Shortcuts ── */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === 'k') {
        e.preventDefault(); setShowPalette((v) => !v); setPaletteQuery(''); setPaletteIndex(0); return
      }
      if (mod && e.key === 'n') { e.preventDefault(); newConversation(); return }
      if (mod && e.key === ',') { e.preventDefault(); setSidebarView((v) => v === 'settings' ? 'agents' : 'settings'); return }
      if (mod && e.key === 'Enter') { e.preventDefault(); handleSend(); return }
      if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); return }
      if (mod && e.key === 'l') { e.preventDefault(); if (chatMessages.length > 0) setShowClearConfirm(true); return }
      if (mod && e.key === 'e') { e.preventDefault(); exportConversation(); return }
      if (mod && e.shiftKey && e.key === '?') { e.preventDefault(); setShowShortcuts(true); return }
      if (e.key === 'Escape') {
        if (showPalette) { setShowPalette(false); return }
        if (showShortcuts) { setShowShortcuts(false); return }
        if (showClearConfirm) { setShowClearConfirm(false); return }
        if (isStreaming) { stopGeneration(); return }
        if (sidebarView === 'settings') { setSidebarView('agents'); return }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    showPalette, showShortcuts, showClearConfirm, isStreaming, sidebarView,
    chatMessages.length, newConversation, handleSend, toggleSidebar,
    exportConversation, stopGeneration,
  ])

  /* ── Focus palette input when opened ── */
  useEffect(() => {
    if (showPalette) {
      setTimeout(() => paletteInputRef.current?.focus(), 0)
    }
  }, [showPalette])

  /* ── Close model dropdown on outside click ── */
  useEffect(() => {
    if (!showModelDropdown) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-model-dropdown]')) setShowModelDropdown(false)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [showModelDropdown])

  /* ── Palette items ── */
  const paletteItems: PaletteItem[] = useMemo(() => [
    { id: 'new-conversation', label: 'New Conversation', icon: <Plus size={16} />, shortcut: '⌘N', action: () => { newConversation(); setShowPalette(false) } },
    { id: 'spawn', label: 'Spawn Worker Agent', icon: <Sparkles size={16} />, action: () => { if (canSpawn) spawnAgent(); setShowPalette(false) } },
    { id: 'settings', label: 'Settings', icon: <Settings size={16} />, shortcut: '⌘,', action: () => { setSidebarView('settings'); setShowPalette(false) } },
    { id: 'harness', label: 'Harness Dashboard', icon: <WandSparkles size={16} />, action: () => { setSidebarView('agents'); setShowPalette(false) } },
    { id: 'skills', label: 'Skills', icon: <ListChecks size={16} />, action: () => { setSidebarView('skills'); setShowPalette(false) } },
    { id: 'schedules', label: 'Schedules', icon: <CalendarCheck size={16} />, action: () => { setSidebarView('schedules'); setShowPalette(false) } },
    { id: 'export', label: 'Export Conversation', icon: <Download size={16} />, shortcut: '⌘E', action: () => { exportConversation(); setShowPalette(false) } },
    { id: 'clear', label: 'Clear Chat', icon: <Trash2 size={16} />, shortcut: '⌘L', action: () => { if (chatMessages.length > 0) { setShowClearConfirm(true) }; setShowPalette(false) } },
    { id: 'toggle-theme', label: theme === 'minimax' ? 'Switch to Bonsai Theme' : 'Switch to MiniMax Theme', icon: <Zap size={16} />, action: () => { toggleTheme(); setShowPalette(false) } },
    { id: 'toggle-mode', label: effectiveLight ? 'Switch to Dark Mode' : 'Switch to Light Mode', icon: effectiveLight ? <Moon size={16} /> : <Sun size={16} />, action: () => { toggleLight(); setShowPalette(false) } },
    { id: 'toggle-sidebar', label: sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar', icon: sidebarOpen ? <Minimize2 size={16} /> : <Maximize2 size={16} />, shortcut: '⌘B', action: () => { toggleSidebar(); setShowPalette(false) } },
    { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: <Keyboard size={16} />, shortcut: '⌘?', action: () => { setShowShortcuts(true); setShowPalette(false) } },
    ...agents.map((a) => ({
      id: `agent-${a.id}`,
      label: a.id,
      icon: <Cpu size={16} />,
      action: () => { setSelectedAgent(a.id); setSidebarView('agents'); setShowPalette(false) },
    })),
  ], [
    theme, effectiveLight, agents, canSpawn, sidebarOpen, chatMessages.length,
    newConversation, spawnAgent, exportConversation, toggleTheme, toggleLight, toggleSidebar,
  ])

  const filteredPalette = useMemo(() => {
    if (!paletteQuery.trim()) return paletteItems
    const q = paletteQuery.toLowerCase()
    return paletteItems.filter((item) => item.label.toLowerCase().includes(q))
  }, [paletteItems, paletteQuery])

  const handlePaletteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex((i) => Math.min(i + 1, filteredPalette.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && filteredPalette[paletteIndex]) { e.preventDefault(); filteredPalette[paletteIndex].action() }
  }

  /* ── Theme classes ── */
  const themeClasses = [
    theme === 'bonsai' ? 'theme-bonsai' : '',
    effectiveLight ? 'theme-light' : '',
  ].filter(Boolean).join(' ')

  /* ── Render ── */
  return (
    <div
      ref={dropZoneRef}
      className={`window-frame relative flex h-screen overflow-hidden bg-mm-sidebar text-mm-font theme-crossfade ${themeClasses}`}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-mm-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-mm-accent bg-mm-surface p-8 text-center">
            <Paperclip size={32} className="mx-auto mb-3 text-mm-accent" />
            <div className="text-[16px] font-semibold text-mm-text">Drop files to attach</div>
            <div className="mt-1 text-[12px] text-mm-text-secondary">They'll be sent with your next message</div>
          </div>
        </div>
      )}

      {/* ══════════ Sidebar ══════════ */}
      {sidebarOpen && (
        <aside className="vibrancy-sidebar flex w-[260px] shrink-0 flex-col">
          <div className="drag-zone flex items-center gap-2.5 px-5 py-4">
            <div className="traffic-lights">
              <span className="traffic-light traffic-light-close" />
              <span className="traffic-light traffic-light-minimize" />
              <span className="traffic-light traffic-light-maximize" />
            </div>
            <div className="ml-2 flex items-center gap-2">
              <img src="/bonsailogo.png" alt="Bonsai" className="h-6 w-6 rounded-md object-cover" />
              <span className="text-[14px] font-semibold tracking-tight text-mm-text">Bonsai</span>
            </div>
          </div>

          <div className="px-3 pb-2">
            <button
              onClick={newConversation}
              className="nav-item-transition flex w-full items-center gap-2 rounded-lg bg-mm-surface-active px-3 py-2 text-[13px] font-medium text-mm-text hover:bg-mm-surface-hover"
            >
              <Plus size={16} /> New Chat
              <span className="ml-auto kbd-hint">⌘N</span>
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto px-3 custom-scrollbar">
            <NavItem icon={<ListChecks size={16} />} label="Skills" active={sidebarView === 'skills'} onClick={() => setSidebarView('skills')} />
            <NavItem icon={<CalendarCheck size={16} />} label="Schedules" active={sidebarView === 'schedules'} onClick={() => setSidebarView('schedules')} />
            <NavItem icon={<WandSparkles size={16} />} label="Harness" active={sidebarView === 'agents'} onClick={() => setSidebarView('agents')} />

            <div className="my-3 h-px bg-mm-border" />

            <SectionHeader label="Conversations" />
            {conversations.length === 0 ? (
              <p className="px-3 text-[12px] text-mm-text-tertiary">No saved conversations</p>
            ) : (
              conversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  active={activeConversationId === conv.id}
                  onSelect={() => loadConversation(conv.id)}
                  onDelete={() => deleteConversation(conv.id)}
                  onRename={(name) => renameConversation(conv.id, name)}
                />
              ))
            )}

            <div className="my-3 h-px bg-mm-border" />

            <SectionHeader label="Agent Team" actionIcon={<Plus size={14} />} onAction={canSpawn ? spawnAgent : undefined} />
            {agents.map((agent) => (
              <div key={agent.id} className="mb-0.5">
                <button
                  onClick={() => { setSelectedAgent(agent.id); setSidebarView('agents') }}
                  className={`nav-item-transition flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] ${selectedAgent === agent.id ? 'bg-mm-surface-active text-mm-text' : 'text-mm-text-secondary hover:bg-mm-surface-hover'}`}
                >
                  <Cpu size={16} />
                  <span className="flex-1 truncate">{agent.id}</span>
                  {agent.status === 'active' && <Circle size={6} className="shrink-0 fill-mm-accent text-mm-accent pulse-dot" />}
                  {agent.status === 'error' && <Circle size={6} className="shrink-0 fill-mm-red text-mm-red" />}
                </button>
              </div>
            ))}

            <SectionHeader label="MCP Bus" />
            <div className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-mm-text-secondary">
              <FolderOpen size={16} /> Local-FS-Server
            </div>

            <div className="mt-4">
              <button
                onClick={() => setSidebarView('archived')}
                className={`nav-item-transition flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] ${sidebarView === 'archived' ? 'bg-mm-surface-active text-mm-text' : 'text-mm-text-tertiary hover:text-mm-text-secondary'}`}
              >
                <Archive size={16} /> Archived
              </button>
            </div>
          </nav>

          <div className="bg-mm-surface/30 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-mm-purple text-[13px] font-semibold text-white">DT</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-mm-text">Douglas Talley</div>
                <div className="text-[11px] text-mm-text-tertiary">
                  {connected ? (
                    <span className="flex items-center gap-1"><Circle size={6} className="fill-mm-green text-mm-green pulse-dot" /> Connected</span>
                  ) : (
                    <span className="flex items-center gap-1"><Circle size={6} className="fill-mm-red text-mm-red" /> Offline</span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button onClick={toggleTheme} className="nav-item-transition flex items-center gap-1.5 rounded-full bg-mm-surface px-3 py-1 text-[11px] text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text">
                <img src="/bonsailogo.png" alt="" className="h-3 w-3 rounded-sm object-cover" />
                {theme === 'minimax' ? 'Bonsai' : 'MiniMax'}
              </button>
              <button onClick={toggleLight} className="nav-item-transition flex items-center gap-1.5 rounded-full bg-mm-surface px-3 py-1 text-[11px] text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text" aria-label="Toggle light/dark mode">
                {effectiveLight ? <Sun size={11} /> : <Moon size={11} />}
                {effectiveLight ? 'Light' : 'Dark'}
              </button>
            </div>
          </div>
        </aside>
      )}

      {/* ══════════ Main Content ══════════ */}
      <main className="flex min-w-0 flex-1 flex-col bg-mm-main-bg">
        <header className="vibrancy-header drag-zone flex h-12 items-center justify-between px-6">
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {!sidebarOpen && (
              <button onClick={toggleSidebar} className="nav-item-transition rounded-lg p-2 text-mm-text-secondary hover:bg-mm-surface-hover" title="Show sidebar (⌘B)" aria-label="Show sidebar">
                <Maximize2 size={16} />
              </button>
            )}
            <button onClick={() => setShowPalette(true)} className="nav-item-transition flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] text-mm-text-tertiary hover:bg-mm-surface-hover hover:text-mm-text-secondary">
              <Search size={14} /> Search
              <span className="kbd-hint">⌘K</span>
            </button>
          </div>
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {chatMessages.length > 0 && (
              <>
                <button onClick={() => setShowClearConfirm(true)} className="nav-item-transition rounded-lg p-2 text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text" title="Clear chat (⌘L)" aria-label="Clear chat">
                  <Trash2 size={16} />
                </button>
                <button onClick={exportConversation} className="nav-item-transition rounded-lg p-2 text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text" title="Export conversation (⌘E)" aria-label="Export conversation">
                  <Download size={16} />
                </button>
              </>
            )}
            <button onClick={() => setShowShortcuts(true)} className="nav-item-transition rounded-lg p-2 text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text" title="Keyboard shortcuts (⌘⇧?)" aria-label="Keyboard shortcuts">
              <Keyboard size={16} />
            </button>
            <button onClick={() => setSidebarView(sidebarView === 'settings' ? 'agents' : 'settings')} className="nav-item-transition rounded-lg p-2 text-mm-text-secondary hover:bg-mm-surface-hover hover:text-mm-text" title="Settings (⌘,)" aria-label="Settings">
              <Settings size={16} />
            </button>
          </div>
        </header>

        {sidebarView === 'settings' ? (
          <SettingsPanel
            modelId={modelId} setModelId={setModelId}
            runtimeKind={runtimeKind} setRuntimeKind={setRuntimeKind}
            prompt={prompt} setPrompt={setPrompt}
            health={health} activeCount={activeCount} canSpawn={canSpawn} onSpawn={spawnAgent}
            onBack={() => setSidebarView('agents')}
          />
        ) : sidebarView === 'skills' ? (
          <PlaceholderPanel title="Skills" icon={<ListChecks size={20} />} onBack={() => setSidebarView('agents')} />
        ) : sidebarView === 'schedules' ? (
          <PlaceholderPanel title="Schedules" icon={<CalendarCheck size={20} />} onBack={() => setSidebarView('agents')} />
        ) : sidebarView === 'archived' ? (
          <PlaceholderPanel title="Archived Tasks" icon={<Archive size={20} />} onBack={() => setSidebarView('agents')} />
        ) : (
          <>
            {chatMessages.length > 0 ? (
              <div ref={chatContainerRef} className="flex flex-1 flex-col overflow-y-auto px-6 py-4 custom-scrollbar">
                <div className="mx-auto w-full max-w-3xl space-y-4">
                  {chatMessages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`group relative max-w-[85%] min-w-0 rounded-2xl px-4 py-2.5 ${msg.role === 'user' ? 'bg-mm-accent text-white' : 'bg-mm-surface text-mm-text'}`}>
                        <MessageActions
                          message={msg}
                          onCopy={() => copyMessage(msg.content)}
                          onFeedback={(f) => setFeedback(msg.id, f)}
                        />
                        {msg.role === 'assistant' ? (
                          <MarkdownMessage content={msg.content} />
                        ) : (
                          <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed">{msg.content}</pre>
                        )}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {msg.attachments.map((att) => (
                              <div key={att.id} className="flex items-center gap-1 rounded bg-black/20 px-2 py-0.5 text-[11px]">
                                <FileText size={10} className="shrink-0" /> <span className="truncate max-w-[200px]" title={att.name}>{att.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="mt-1 text-[10px] opacity-50">
                          {formatTimestamp(msg.timestamp)}
                        </div>
                      </div>
                    </div>
                  ))}
                  {isStreaming && (
                    <div className="flex justify-start">
                      <div className="flex items-center gap-2 rounded-2xl bg-mm-surface px-4 py-3 text-mm-text">
                        <div className="flex gap-1">
                          <span className="h-2 w-2 animate-bounce rounded-full bg-mm-text-secondary" style={{ animationDelay: '0ms' }} />
                          <span className="h-2 w-2 animate-bounce rounded-full bg-mm-text-secondary" style={{ animationDelay: '150ms' }} />
                          <span className="h-2 w-2 animate-bounce rounded-full bg-mm-text-secondary" style={{ animationDelay: '300ms' }} />
                        </div>
                        <span className="text-[12px] text-mm-text-secondary">Thinking...</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-8">
                <img src="/bonsailogo.png" alt="Bonsai" className="mb-5 h-14 w-14 rounded-2xl object-cover" />
                <h1 className="mb-3 text-[24px] font-semibold tracking-tight text-mm-text">
                  Bonsai makes your work easier.
                </h1>
                <p className="mb-6 text-[14px] text-mm-text-secondary">Try one of these to get started, or ask anything.</p>
                <div className="grid w-full max-w-3xl grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {SUGGESTED_PROMPTS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => setInputMessage(s.prompt)}
                      className="nav-item-transition flex items-start gap-3 rounded-xl border border-mm-border bg-mm-surface px-4 py-3 text-left hover:border-mm-accent/40 hover:bg-mm-surface-hover focus:outline-none focus:ring-2 focus:ring-mm-accent/40"
                    >
                      <span className="mt-0.5 shrink-0 text-[18px] leading-none">{s.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-mm-text">{s.label}</div>
                        <div className="mt-1 text-[11px] leading-snug text-mm-text-tertiary line-clamp-2 break-words">{s.prompt}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Chat Input */}
            <div className="px-6 pb-4">
              <div className="mx-auto max-w-3xl">
                {pendingFiles.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {pendingFiles.map((f) => (
                      <FileChip key={f.id} file={f} onRemove={() => removeFile(f.id)} />
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2 rounded-2xl bg-mm-surface px-4 py-3">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="nav-item-transition shrink-0 rounded-lg p-1.5 text-mm-text-tertiary hover:bg-mm-surface-hover hover:text-mm-text-secondary"
                    aria-label="Attach files"
                    title="Attach files"
                  >
                    <Paperclip size={18} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        addFiles(e.target.files)
                        e.target.value = ''
                      }
                    }}
                  />
                  <textarea
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value.slice(0, MAX_INPUT_CHARS))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                    placeholder="Enter message... (Shift+Enter for newline)"
                    rows={1}
                    className="min-h-[24px] max-h-[160px] flex-1 resize-none bg-transparent text-[14px] text-mm-text placeholder-mm-text-tertiary outline-none"
                  />
                  <div className="relative" data-model-dropdown>
                    <button
                      onClick={() => setShowModelDropdown((v) => !v)}
                      className="nav-item-transition flex max-w-[200px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mm-text-secondary hover:bg-mm-surface-hover focus:outline-none focus:ring-1 focus:ring-mm-accent/50"
                      title={modelId}
                    >
                      <span className="truncate">{PRESET_MODELS.find(m => m.id === modelId)?.label ?? modelId.split('/').pop() ?? 'Model'}</span>
                      <ChevronDown size={12} className="shrink-0" />
                    </button>
                    {showModelDropdown && (
                      <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-xl border border-mm-border bg-mm-surface p-2 shadow-lg">
                        <div className="mb-2 px-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-mm-text-tertiary">Preset Models</div>
                        {PRESET_MODELS.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => { setModelId(m.id); setShowModelDropdown(false); toast.success(`Switched to ${m.label}`) }}
                            className={`mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-mm-surface-hover ${modelId === m.id ? 'bg-mm-surface-active' : ''}`}
                          >
                            <div className="flex w-full items-center justify-between">
                              <span className="text-[13px] font-medium text-mm-text">{m.label}</span>
                              {modelId === m.id && <Check size={12} className="text-mm-accent" />}
                            </div>
                            <span className="text-[11px] text-mm-text-tertiary">{m.description}</span>
                          </button>
                        ))}
                        <div className="mt-2 border-t border-mm-border pt-2">
                          <label className="mb-1 block px-2 text-[10px] font-medium uppercase tracking-wider text-mm-text-tertiary">Custom</label>
                          <input
                            value={modelId}
                            onChange={(e) => setModelId(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') setShowModelDropdown(false) }}
                            className="w-full rounded-lg border border-mm-border bg-mm-main-bg px-3 py-2 text-[12px] text-mm-text outline-none focus:border-mm-accent"
                            placeholder="org/model-name"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  {isStreaming ? (
                    <button
                      onClick={stopGeneration}
                      className="send-btn-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mm-red p-0 text-white hover:opacity-90"
                      aria-label="Stop generation"
                      title="Stop generation (Esc)"
                    >
                      <Square size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={!connected || !inputMessage.trim()}
                      className="send-btn-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mm-accent p-0 text-white hover:bg-mm-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="Send"
                      title="Send (⌘Enter)"
                    >
                      <Send size={16} />
                    </button>
                  )}
                </div>

                <div className="mt-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button onClick={canSpawn ? spawnAgent : undefined} disabled={!canSpawn} className="nav-item-transition flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-mm-text-secondary hover:bg-mm-surface-hover disabled:opacity-40">
                      <Activity size={14} /> Agent team
                    </button>
                    {chatMessages.length > 0 && (
                      <button onClick={exportConversation} className="nav-item-transition flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-mm-text-secondary hover:bg-mm-surface-hover">
                        <Download size={14} /> Export
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {isScrolledUp && (
                      <button
                        onClick={() => chatContainerRef.current?.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' })}
                        className="text-[11px] text-mm-accent hover:underline"
                      >
                        ↓ Jump to latest
                      </button>
                    )}
                    <span className={`text-[11px] ${inputAtLimit ? 'text-mm-red' : 'text-mm-text-tertiary'}`}>
                      {inputMessage.length} / {MAX_INPUT_CHARS}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Log Panel — collapsible, default collapsed; not needed for chat */}
        {logs.length > 1 && sidebarView === 'agents' && (
          <div className="border-t border-mm-border">
            <button
              onClick={() => setLogsExpanded((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2 text-left transition-colors hover:bg-mm-surface/30"
              aria-expanded={logsExpanded}
              aria-controls="output-log-panel"
              title={logsExpanded ? 'Collapse output (logs are not required for chat)' : 'Expand output'}
            >
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-mm-text-tertiary">
                <ChevronDown
                  size={12}
                  className={`shrink-0 transition-transform ${logsExpanded ? 'rotate-0' : '-rotate-90'}`}
                />
                <Terminal size={12} /> Output
              </span>
              <span className="text-[11px] text-mm-text-tertiary">
                {logs.length} {logs.length === 1 ? 'line' : 'lines'}
                {!logsExpanded && ' · click to expand'}
              </span>
            </button>
            {logsExpanded && (
              <div id="output-log-panel" className="max-h-[200px] overflow-y-auto bg-mm-surface/50 px-4 py-2 custom-scrollbar">
                {logs.map((log, i) => (
                  <div key={`${i}-${log.slice(0, 16)}`} className="log-entry-animate whitespace-pre-wrap break-words py-0.5 text-[12px] leading-5 text-mm-text-secondary">
                    {log}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        )}
      </main>

      {/* ══════════ Modals ══════════ */}
      {showPalette && (
        <div className="search-overlay" onClick={() => setShowPalette(false)}>
          <div className="search-palette" onClick={(e) => e.stopPropagation()} onKeyDown={handlePaletteKeyDown}>
            <input
              ref={paletteInputRef}
              value={paletteQuery}
              onChange={(e) => { setPaletteQuery(e.target.value); setPaletteIndex(0) }}
              placeholder="Search commands, agents, settings..."
              className="search-palette-input"
            />
            <div className="search-palette-results">
              {filteredPalette.length === 0 && (
                <div className="px-4 py-6 text-center text-[13px] text-mm-text-tertiary">No results</div>
              )}
              {filteredPalette.map((item, i) => (
                <div
                  key={item.id}
                  className={`search-result-item ${i === paletteIndex ? 'active' : ''}`}
                  onClick={item.action}
                  onMouseEnter={() => setPaletteIndex(i)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.shortcut && <span className="search-result-kbd">{item.shortcut}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}

      {showClearConfirm && (
        <ConfirmModal
          title="Clear current chat?"
          message="This will remove all messages from the current conversation. This cannot be undone."
          confirmLabel="Clear"
          onConfirm={clearChat}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  )
}

/* ── Settings Panel ── */
function SettingsPanel({
  modelId, setModelId, runtimeKind, setRuntimeKind, prompt, setPrompt,
  health, activeCount, canSpawn, onSpawn, onBack,
}: {
  modelId: string; setModelId: (v: string) => void
  runtimeKind: RuntimeKind; setRuntimeKind: (v: RuntimeKind) => void
  prompt: string; setPrompt: (v: string) => void
  health: Record<string, unknown> | null; activeCount: number
  canSpawn: boolean; onSpawn: () => void; onBack: () => void
}) {
  return (
    <div className="panel-animate-in flex-1 overflow-y-auto px-8 py-6 custom-scrollbar">
      <div className="mx-auto max-w-xl">
        <button onClick={onBack} className="nav-item-transition mb-6 flex items-center gap-1.5 text-[13px] text-mm-text-secondary hover:text-mm-text">
          ← Back
        </button>

        <h2 className="mb-6 text-[18px] font-semibold text-mm-text">Agent Configuration</h2>

        <div className="space-y-5">
          <Field label="Model ID" hint="Any local or API model identifier accepted by the selected runtime.">
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full rounded-xl border border-mm-border bg-mm-surface px-4 py-2.5 text-[14px] text-mm-text outline-none transition focus:border-mm-accent"
            />
          </Field>

          <Field label="Runtime">
            <select
              value={runtimeKind}
              onChange={(e) => setRuntimeKind(e.target.value as RuntimeKind)}
              className="w-full rounded-xl border border-mm-border bg-mm-surface px-4 py-2.5 text-[14px] text-mm-text outline-none transition focus:border-mm-accent"
            >
              <option value="local-command">Local command</option>
              <option value="openai-compatible">OpenAI-compatible API</option>
            </select>
          </Field>

          <Field label="System Prompt">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="w-full resize-none rounded-xl border border-mm-border bg-mm-surface px-4 py-2.5 text-[14px] text-mm-text outline-none transition focus:border-mm-accent"
            />
          </Field>

          <button
            onClick={onSpawn}
            disabled={!canSpawn}
            className="nav-item-transition w-full rounded-xl bg-mm-accent px-4 py-2.5 text-[14px] font-medium text-white hover:bg-mm-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            + Spawn Model Worker
          </button>

          <div className="mt-8 rounded-xl bg-mm-surface p-5">
            <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-mm-text-tertiary">
              <Terminal size={14} /> System Health
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <div className="flex min-w-0 items-center justify-between gap-2"><span className="truncate text-mm-text-secondary">Active agents</span><span className="shrink-0 font-mono text-mm-text">{activeCount}</span></div>
              <div className="flex min-w-0 items-center justify-between gap-2"><span className="truncate text-mm-text-secondary">Max agents</span><span className="shrink-0 font-mono text-mm-text">{String(health?.maxActiveAgents ?? '-')}</span></div>
              <div className="flex min-w-0 items-center justify-between gap-2"><span className="truncate text-mm-text-secondary">Runner binary</span><span className="shrink-0 font-mono text-mm-text">{health?.runnerBinaryPresent ? '✓' : '✗'}</span></div>
              <div className="flex min-w-0 items-center justify-between gap-2"><span className="truncate text-mm-text-secondary">Log buffer</span><span className="shrink-0 font-mono text-mm-text">{MAX_LOGS}</span></div>
            </div>
          </div>

          <div className="rounded-xl bg-mm-surface p-5">
            <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-mm-text-tertiary">
              <HardDrive size={14} /> SanDisk1Tb
            </h3>
            <div className="space-y-1 font-mono text-[13px] text-mm-text-secondary">
              <div>drwxr-xr-x sandbox/</div>
              <div>drwxr-xr-x models/</div>
              <div>drwxr-xr-x logs/</div>
              <div>-rw-r--r-- telemetry.json</div>
            </div>
          </div>

          <div className="rounded-xl bg-mm-surface p-5">
            <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-mm-text-tertiary">
              <Zap size={14} /> Runtime Config
            </h3>
            <p className="text-[13px] leading-5 text-mm-text-secondary">
              Local command mode uses <code className="rounded bg-mm-surface-hover px-1.5 py-0.5 text-mm-accent">HARNESS_RUNNER_BINARY</code> and{' '}
              <code className="rounded bg-mm-surface-hover px-1.5 py-0.5 text-mm-accent">HARNESS_RUNNER_ARGS_TEMPLATE</code>. API keys stay on the backend.
            </p>
            <div className="mt-3 flex items-center gap-1.5 text-[12px] text-mm-text-tertiary">
              <Zap size={12} /> Bounded log stream prevents UI memory blowups
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
