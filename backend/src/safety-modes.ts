/**
 * Safety Modes
 * ============
 * Four-tier safety policy that gates MCP tool invocations made by agents
 * spawned through the harness:
 *
 *   plan : Read-only. Reads are allowed; writes/exec are blocked outright.
 *          Useful for "what would happen if I let this agent run?".
 *   ask  : Every tool call requires explicit user approval before it runs.
 *   auto : Read tools auto-execute; writes/exec require approval.
 *   yolo : No approvals. Tools execute immediately. Use with caution.
 *
 * The classifier here is intentionally conservative: anything that doesn't
 * match a known read-only pattern is treated as a write/exec for gating
 * purposes. The classifier returns an explicit decision per call so the
 * caller can either run the tool, request approval, or hard-block it.
 */

export type SafetyMode = "plan" | "ask" | "auto" | "yolo";

export const ALL_SAFETY_MODES: readonly SafetyMode[] = ["plan", "ask", "auto", "yolo"] as const;

export const DEFAULT_SAFETY_MODE: SafetyMode = "ask";

export interface SafetyModeMeta {
  readonly mode: SafetyMode;
  readonly label: string;
  readonly description: string;
  readonly emoji: string;
  /** True when the mode is allowed to spawn write/exec tools at all. */
  readonly allowsWrites: boolean;
  /** True when human approval is required before invoking *any* tool. */
  readonly requiresApprovalAlways: boolean;
  /** True when human approval is required before write/exec tools. */
  readonly requiresApprovalOnWrites: boolean;
}

export const SAFETY_MODE_META: Readonly<Record<SafetyMode, SafetyModeMeta>> = {
  plan: {
    mode: "plan",
    label: "Plan Only",
    description:
      "Read-only mode. The agent can inspect the workspace but writes and shell exec are blocked. Useful for review-before-act.",
    emoji: "🗒️",
    allowsWrites: false,
    requiresApprovalAlways: false,
    requiresApprovalOnWrites: false,
  },
  ask: {
    mode: "ask",
    label: "Always Ask",
    description:
      "Every tool call pauses for explicit human approval. Highest friction, highest safety.",
    emoji: "🤚",
    allowsWrites: true,
    requiresApprovalAlways: true,
    requiresApprovalOnWrites: true,
  },
  auto: {
    mode: "auto",
    label: "Auto",
    description:
      "Read-only tools execute automatically. Writes and shell exec still require human approval. Sensible default for active work.",
    emoji: "⚙️",
    allowsWrites: true,
    requiresApprovalAlways: false,
    requiresApprovalOnWrites: true,
  },
  yolo: {
    mode: "yolo",
    label: "YOLO",
    description:
      "No approvals. The agent executes any tool without prompting. Use only in throw-away sandboxes.",
    emoji: "🔥",
    allowsWrites: true,
    requiresApprovalAlways: false,
    requiresApprovalOnWrites: false,
  },
};

/**
 * Heuristic patterns that mark a tool as side-effect-free. Tools whose name
 * starts with these prefixes (or matches these full names) are treated as
 * read-only by the classifier.
 *
 * The harness errs on the side of "this is a write tool" so unknown names
 * always require approval in `ask`/`auto` and are blocked in `plan`.
 */
const READ_ONLY_NAME_PATTERNS: readonly RegExp[] = [
  /^read(_|$)/i,
  /^get(_|$)/i,
  /^list(_|$)/i,
  /^search(_|$)/i,
  /^find(_|$)/i,
  /^query(_|$)/i,
  /^view(_|$)/i,
  /^show(_|$)/i,
  /^inspect(_|$)/i,
  /^describe(_|$)/i,
  /^trace(_|$)/i,
  /^explain(_|$)/i,
  /^summari[sz]e(_|$)/i,
  /^stat(_|s|$)/i,
  /^status(_|$)/i,
  /^analy[sz]e(_|$)/i,
  /^observe(_|$)/i,
  /^ask(_|$)/i,
  /^retrieve(_|$)/i,
  /^load(_|$)/i,
  /^cache_retrieve$/i,
  /^cache_search$/i,
  /^cache_list$/i,
  /^cache_stats$/i,
];

const ALWAYS_DESTRUCTIVE_NAMES: readonly RegExp[] = [
  /^kill_/i,
  /^delete_/i,
  /^remove_/i,
  /^drop_/i,
  /^force_/i,
  /^terminate_/i,
  /^cache_clear$/i,
  /^clear_index$/i,
];

export function classifyTool(toolName: string): { readOnly: boolean; destructive: boolean } {
  const destructive = ALWAYS_DESTRUCTIVE_NAMES.some((re) => re.test(toolName));
  if (destructive) return { readOnly: false, destructive: true };
  const readOnly = READ_ONLY_NAME_PATTERNS.some((re) => re.test(toolName));
  return { readOnly, destructive: false };
}

export type SafetyDecision =
  | { effect: "allow"; reason: string }
  | { effect: "ask"; reason: string }
  | { effect: "block"; reason: string };

/**
 * Decide what to do with a tool call given the current safety mode.
 *
 *   - "allow": run the tool right now without prompting.
 *   - "ask"  : suspend, ask the human for approval, run only if approved.
 *   - "block": refuse to run; tell the agent the tool is forbidden in this mode.
 */
export function decideToolCall(mode: SafetyMode, toolName: string): SafetyDecision {
  const { readOnly, destructive } = classifyTool(toolName);
  const meta = SAFETY_MODE_META[mode];

  if (mode === "plan") {
    if (readOnly && !destructive) {
      return { effect: "allow", reason: "plan: read-only tool" };
    }
    return { effect: "block", reason: `plan mode blocks "${toolName}" (write/exec)` };
  }

  if (mode === "yolo") {
    return { effect: "allow", reason: "yolo: no gating" };
  }

  if (mode === "ask") {
    return { effect: "ask", reason: "ask: every call requires approval" };
  }

  // auto
  if (readOnly && !destructive) {
    return { effect: "allow", reason: "auto: read-only tool, auto-approved" };
  }
  return { effect: "ask", reason: "auto: write/exec tool, approval required" };
  void meta;
}

export function isSafetyMode(value: unknown): value is SafetyMode {
  return typeof value === "string" && (ALL_SAFETY_MODES as readonly string[]).includes(value);
}

export function safetyModePublicSummary() {
  return ALL_SAFETY_MODES.map((m) => {
    const meta = SAFETY_MODE_META[m];
    return {
      mode: meta.mode,
      label: meta.label,
      description: meta.description,
      emoji: meta.emoji,
      allowsWrites: meta.allowsWrites,
      requiresApprovalAlways: meta.requiresApprovalAlways,
      requiresApprovalOnWrites: meta.requiresApprovalOnWrites,
    };
  });
}
