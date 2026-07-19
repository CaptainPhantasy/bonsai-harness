/**
 * Per-project conversation log.
 * =============================
 *
 * Implements Decision 6 (LOCKED): memory is filesystem-scoped to PROJECT_ROOT,
 * never global. Each conversation is a JSONL file under
 * `<PROJECT_ROOT>/.bonsai/memory/conversations/<conversationId>.jsonl`.
 *
 * Why JSONL over JSON:
 *   - Append-only writes (no read-modify-write race).
 *   - One line per turn = `tail -f` works for live observation.
 *   - Partial corruption of the last line never invalidates earlier turns.
 *
 * Conversation IDs are stable across a single WebSocket session: the first
 * `send_message` mints an ID and the same ID is reused for every subsequent
 * message on that socket until close. This replaces the prior
 * `Chat-${Date.now()...}` scheme (W1 bug) which generated a fresh ID per
 * message and made threading impossible.
 *
 * Path safety: every path goes through resolveMemoryPath, which rejects
 * absolute paths and `..` traversal. Conversation IDs are also constrained
 * to `[A-Za-z0-9_-]+` so they cannot escape the conversations/ subtree
 * even with a malicious ID.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { getConversationsDir, resolveMemoryPath } from "./server-core";

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
  /** OpenAI tool_call_id when role === "tool". */
  tool_call_id?: string;
  /** ISO-8601 timestamp marking when the turn was persisted. */
  timestamp: string;
};

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Mint a new conversation ID. Format: `conv_<uuid-heap><yyyymmdd>`.
 * Stable for the lifetime of a WebSocket session.
 */
export function createConversationId(): string {
  const heap = randomUUID().replace(/-/g, "");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `conv_${heap}_${date}`;
}

/**
 * Return the absolute JSONL path for a conversation ID.
 * Rejects malformed IDs before they reach the filesystem.
 */
export function conversationLogPath(conversationId: string): string {
  if (!conversationId || !ID_PATTERN.test(conversationId)) {
    throw new Error(`conversationId must match ${ID_PATTERN.source}: got "${conversationId}"`);
  }
  return resolveMemoryPath(`conversations/${conversationId}.jsonl`);
}

/**
 * Load all persisted turns for a conversation. Returns an empty array if the
 * log does not yet exist (first message in a new conversation). Malformed
 * lines are skipped — a single corrupt append must never break the loop.
 */
export function loadConversation(conversationId: string): ConversationMessage[] {
  const path = conversationLogPath(conversationId);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const messages: ConversationMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed && typeof parsed === "object" && "role" in parsed && "content" in parsed
        && typeof (parsed as { role: unknown }).role === "string"
        && typeof (parsed as { content: unknown }).content === "string"
      ) {
        messages.push(parsed as ConversationMessage);
      }
    } catch {
      // Skip malformed line — partial last-line writes are expected on crash.
    }
  }
  return messages;
}

/**
 * Append a single turn to the conversation log. Creates the conversations/
 * directory tree on first write. The timestamp is set by this function so
 * callers cannot back-date turns.
 */
export function appendConversationTurn(
  conversationId: string,
  message: { role: ConversationRole; content: string; tool_call_id?: string },
): void {
  const path = conversationLogPath(conversationId);
  const dir = getConversationsDir();
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ...message, timestamp: new Date().toISOString() } satisfies ConversationMessage) + "\n";
  appendFileSync(path, line, "utf8");
}

/**
 * Convert persisted history into the OpenAI-compatible `messages` array
 * shape used by the agent loops. Drops tool messages that lack a paired
 * assistant tool_call (those would 400 the API); the conversation log is
 * for resuming context, not for replaying exact tool round-trips.
 */
export function historyToOpenAiMessages(
  history: ConversationMessage[],
): Array<{ role: string; content: string }> {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}
