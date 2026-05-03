/**
 * MCP Server Registry
 * ===================
 * Catalog of every MCP server known to the bonsai-harness, sourced from:
 *   - /Volumes/Storage/MCP        (local stdio servers shipped via the Floyd toolkit)
 *   - /Applications/Desktop Commander.app  (bundled Electron / MCP node entry)
 *   - /Volumes/SanDisk1Tb/ATerm    (external aterm MCP)
 *
 * Dedup rule: when both a v1 and v2 of a server exist on disk, the v2 form is
 * the only entry registered here. Build status of the underlying source is
 * recorded in the `MCP_SERVERS_CONFIG.json` baseline at
 * /Volumes/Storage/MCP/MCP_SERVERS_CONFIG.json (timestamp 2026-04-06) and was
 * sanity-checked at registry-build time via stdio handshake.
 *
 * Each entry is purely descriptive: nothing here spawns a process. The
 * harness uses this catalog to (a) tell the frontend which servers are
 * available to connect, (b) know how to spawn each one safely with the
 * correct command/args/env, and (c) enforce safety modes.
 */

export type McpTransport = "stdio" | "stdio+http";
export type McpSource = "local-storage" | "desktop-app" | "aterm";

export interface McpServerEntry {
  /** Stable machine-readable name used as the registry key. */
  readonly name: string;
  /** Human display name used in the UI. */
  readonly displayName: string;
  /** One-line description shown next to the server in the sidebar. */
  readonly description: string;
  /** Executable to spawn (absolute path or PATH-resolvable name). */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args: readonly string[];
  /** Extra env vars merged into the child process environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Optional working directory. */
  readonly cwd?: string;
  /** Wire transport. */
  readonly transport: McpTransport;
  /** Reported version from the upstream package.json or manifest. */
  readonly version: string;
  /** Tool count reported by the upstream catalog (informational). */
  readonly toolCount: number;
  /** Where the server lives on disk. */
  readonly source: McpSource;
}

const STORAGE_ROOT = "/Volumes/Storage/MCP";
const DC_ROOT = "/Applications/Desktop Commander.app/Contents/Resources/bundled-mcpb";

/**
 * Single source of truth for every MCP the harness knows about.
 *
 * IMPORTANT: when an MCP has both v1 and v2 directories on disk, only the
 * v2 entry appears here. Anything else is a bug in this file.
 */
export const MCP_REGISTRY: readonly McpServerEntry[] = [
  // ─── Desktop Commander (bundled with /Applications/Desktop Commander.app) ───
  // Real filesystem + terminal access. This is the surface that lets the
  // harness's spawned agents perform actual code edits.
  {
    name: "desktop-commander",
    displayName: "Desktop Commander",
    description: "Filesystem + terminal access for real code edits",
    command: "node",
    args: [`${DC_ROOT}/dist/index.js`],
    env: { MCP_DXT: "true", NODE_ENV: "production" },
    transport: "stdio",
    version: "0.2.38",
    toolCount: 38,
    source: "desktop-app",
  },

  // ─── /Volumes/Storage/MCP (deduped, V2 preferred) ──────────────────────────
  {
    name: "context-singularity-v2",
    displayName: "Context Singularity v2",
    description: "Codebase ingest, ask, search, impact analysis",
    command: "node",
    args: [`${STORAGE_ROOT}/context-singularity-v2/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "2.0.0",
    toolCount: 10,
    source: "local-storage",
  },
  {
    name: "floyd-devtools-server",
    displayName: "Floyd DevTools",
    description: "TypeScript dependency, schema migration, build correlator, test gen",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-devtools-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 10,
    source: "local-storage",
  },
  {
    name: "floyd-explorer-mcp",
    displayName: "Floyd Explorer",
    description: "Codebase exploration and structural search",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-explorer-mcp/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 5,
    source: "local-storage",
  },
  {
    name: "floyd-git-mcp",
    displayName: "Floyd Git",
    description: "Git status, diff, branch, log, bisect operations",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-git-mcp/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 8,
    source: "local-storage",
  },
  {
    name: "floyd-http-server",
    displayName: "Floyd HTTP",
    description: "HTTP request and webhook tools",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-http-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 7,
    source: "local-storage",
  },
  {
    name: "floyd-patch-mcp",
    displayName: "Floyd Patch",
    description: "Unified-diff apply, range edit, insert/delete with risk assessment",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-patch-mcp/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 5,
    source: "local-storage",
  },
  {
    name: "floyd-runner-mcp",
    displayName: "Floyd Runner",
    description: "Detect/run tests, format, lint, build for any project",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-runner-mcp/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 6,
    source: "local-storage",
  },
  {
    name: "floyd-safe-ops-server",
    displayName: "Floyd Safe Ops",
    description: "Refactor with rollback, impact simulation, verification",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-safe-ops-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 3,
    source: "local-storage",
  },
  {
    name: "floyd-supercache-server",
    displayName: "Floyd Supercache",
    description: "Tiered cache: project / reasoning / vault",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-supercache-server/dist/index.js`],
    env: {},
    transport: "stdio+http",
    version: "1.0.0",
    toolCount: 12,
    source: "local-storage",
  },
  {
    name: "floyd-terminal-server",
    displayName: "Floyd Terminal",
    description: "Persistent terminal sessions, process management, file info",
    command: "node",
    args: [`${STORAGE_ROOT}/floyd-terminal-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 10,
    source: "local-storage",
  },
  {
    name: "gemini-tools-server",
    displayName: "Gemini Tools",
    description: "Gemini-flavored utility tools",
    command: "node",
    args: [`${STORAGE_ROOT}/gemini-tools-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 3,
    source: "local-storage",
  },
  {
    name: "hivemind-v2",
    displayName: "Hivemind v2",
    description: "Multi-agent task board, claim/complete, consensus",
    command: "node",
    args: [`${STORAGE_ROOT}/hivemind-v2/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "2.0.0",
    toolCount: 14,
    source: "local-storage",
  },
  {
    name: "lab-lead-server",
    displayName: "Lab Lead",
    description: "MCP lab inventory, find tool, server info, sub-agent spawn",
    command: "node",
    args: [`${STORAGE_ROOT}/lab-lead-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 6,
    source: "local-storage",
  },
  {
    name: "mcp-dashboard-server",
    displayName: "MCP Dashboard",
    description: "Cross-server visibility and control plane",
    command: "node",
    args: [`${STORAGE_ROOT}/mcp-dashboard-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "1.0.0",
    toolCount: 4,
    source: "local-storage",
  },
  {
    name: "novel-concepts-server",
    displayName: "Novel Concepts",
    description: "Concept-web weaver, episodic memory, analogy synthesis",
    command: "node",
    args: [`${STORAGE_ROOT}/novel-concepts-server/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "0.2.0",
    toolCount: 10,
    source: "local-storage",
  },
  {
    name: "omega-v2",
    displayName: "Omega v2",
    description: "Strategize, RLM reasoning, conflict adjudication",
    command: "node",
    args: [`${STORAGE_ROOT}/omega-v2/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "2.0.0",
    toolCount: 8,
    source: "local-storage",
  },
  {
    name: "pattern-crystallizer-v2",
    displayName: "Pattern Crystallizer v2",
    description: "Detect, validate, and crystallize reusable code patterns",
    command: "node",
    args: [`${STORAGE_ROOT}/pattern-crystallizer-v2/dist/index.js`],
    env: {},
    transport: "stdio",
    version: "2.0.0",
    toolCount: 7,
    source: "local-storage",
  },
  {
    name: "prompt-library-server",
    displayName: "Prompt Library",
    description: "Curated prompt templates and search",
    command: "node",
    args: [`${STORAGE_ROOT}/prompt-library-server/dist/index.js`],
    env: {},
    transport: "stdio+http",
    version: "2.0.0",
    toolCount: 5,
    source: "local-storage",
  },
];

/**
 * Look up a registry entry by name. Returns undefined if the name is not
 * known to the harness.
 */
export function findMcpServer(name: string): McpServerEntry | undefined {
  return MCP_REGISTRY.find((s) => s.name === name);
}

/**
 * Public summary safe to ship to the frontend (no env vars / cwd leak).
 */
export interface McpServerSummary {
  name: string;
  displayName: string;
  description: string;
  transport: McpTransport;
  version: string;
  toolCount: number;
  source: McpSource;
}

export function listMcpServerSummaries(): McpServerSummary[] {
  return MCP_REGISTRY.map((s) => ({
    name: s.name,
    displayName: s.displayName,
    description: s.description,
    transport: s.transport,
    version: s.version,
    toolCount: s.toolCount,
    source: s.source,
  }));
}
