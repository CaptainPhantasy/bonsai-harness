/**
 * Verdict Parser
 * ==============
 *
 * Closes the contract leak in I-08: the Governor-0 prompt tells the model
 * to emit a JSON verdict on the last line:
 *
 *   {"passed": true|false, "reason": "evidence pointer", "nextAction": "stop"|"retry"|"escalate"}
 *
 * Until now the runtime ignored it. This parser extracts the verdict and
 * returns a routing decision the agent loop acts on.
 *
 * Pure function — no IO, no mutation. Failures are silent (returns null);
 * a missing or malformed verdict does not break the response, it just
 * means the runtime treats the turn as a plain reply.
 *
 * Tolerances:
 *   - Verdict may be wrapped in ```json fences (some models wrap).
 *   - Verdict may have trailing text on the same line.
 *   - Verdict must be the LAST non-empty line.
 *   - `nextAction` must be exactly one of the three known values;
 *     anything else is treated as "stop".
 */

export type VerdictNextAction = "stop" | "retry" | "escalate";

export type AgentVerdict = {
  passed: boolean;
  reason: string;
  nextAction: VerdictNextAction;
};

const VERDICT_ACTION_VALUES: ReadonlySet<string> = new Set(["stop", "retry", "escalate"]);

/**
 * Extract a verdict from assistant content. Returns null when no verdict
 * is present or when the verdict is structurally invalid.
 *
 * The verdict must appear on the last non-empty line. This is the
 * contract the Governor-0 prompt establishes; a verdict in the middle
 * of the response is treated as prose, not a real verdict.
 */
export function extractVerdict(content: string): AgentVerdict | null {
  if (!content || content.trim().length === 0) return null;

  const jsonText = findLastVerdictBlock(content);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (typeof obj.reason !== "string" || obj.reason.length === 0) return null;
  // Missing nextAction = invalid verdict (required field). Only present-but-
  // unknown values get coerced to "stop" (permissive on the enum).
  if (typeof obj.nextAction !== "string") return null;
  if (!VERDICT_ACTION_VALUES.has(obj.nextAction)) {
    obj.nextAction = "stop";
  }

  return {
    passed: obj.passed as boolean,
    reason: obj.reason as string,
    nextAction: obj.nextAction as VerdictNextAction,
  };
}

/**
 * Strip the verdict line from assistant content. Returns the content with
 * the verdict removed (and any trailing whitespace/newlines trimmed).
 * The agent loop uses this so the stored conversation turn and the
 * broadcast `inference` event show the user-facing prose, not the
 * machine-readable verdict line.
 */
export function stripVerdictLine(content: string): string {
  if (!content) return content;
  // Find the verdict block (single line or fenced) at the end and remove it.
  // We scan from the end for either a closing ``` fence line, a bare JSON
  // object line, or nothing.
  const lines = content.split("\n");

  // Multi-line ```json ... ``` fence case: scan back for the matching opening
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]?.trim() ?? "";
    if (trimmed === "```") {
      // Find the opening ```json or ``` above
      for (let j = i - 1; j >= 0; j -= 1) {
        const openTrimmed = lines[j]?.trim() ?? "";
        if (openTrimmed === "```json" || openTrimmed === "```") {
          // Verify the inner content parses as a verdict
          const inner = lines.slice(j + 1, i).join("\n").trim();
          if (extractJsonObject(inner)) {
            const before = lines.slice(0, j).join("\n").replace(/\s+$/, "");
            return before;
          }
          break;
        }
      }
      break;
    }
    if (trimmed.length === 0) continue;
    // First non-empty, non-``` line from the end: try as bare JSON
    if (extractJsonObject(trimmed)) {
      const before = lines.slice(0, i).join("\n").replace(/\s+$/, "");
      return before;
    }
    break;
  }
  return content;
}

function findLastNonEmptyLine(content: string): string | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]?.trim() ?? "";
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Find the last verdict-shaped block: either a single line containing a
 * balanced {...} object, or a ```json ... ``` fence block. Returns the raw
 * JSON text (caller parses), or null when no candidate is found.
 */
function findLastVerdictBlock(content: string): string | null {
  const lines = content.split("\n");
  // Scan back for either a closing fence or a bare JSON line.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]?.trim() ?? "";
    if (trimmed === "```") {
      for (let j = i - 1; j >= 0; j -= 1) {
        const openTrimmed = lines[j]?.trim() ?? "";
        if (openTrimmed === "```json" || openTrimmed === "```") {
          const inner = lines.slice(j + 1, i).join("\n").trim();
          if (extractJsonObject(inner)) return extractJsonObject(inner);
          return null;
        }
      }
      return null;
    }
    if (trimmed.length === 0) continue;
    return extractJsonObject(trimmed);
  }
  return null;
}

/**
 * Pull the first {...} JSON object out of a line, handling ```json fences.
 * Returns null if no balanced object is found. Does not parse — caller
 * does that and handles parse failures.
 */
function extractJsonObject(line: string): string | null {
  // Strip ```json ... ``` or ``` ... ``` fences if present
  const fenceMatch = line.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) return inner;
  }

  // Otherwise extract the first balanced {...} on the line
  const start = line.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < line.length; i += 1) {
    const ch = line[i];
    if (!ch) continue;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return line.slice(start, i + 1);
    }
  }
  return null;
}
