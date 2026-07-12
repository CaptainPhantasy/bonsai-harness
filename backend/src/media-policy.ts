/**
 * Media Mode Policy
 * =================
 *
 * Closes the real #6 the right way: media tools (Hailuo video, Speech TTS,
 * Music gen, Image gen, Voice Clone/Design) draw from a FINITE Credits
 * pool and are NEVER invoked on inferred intent. The model does not parse
 * "draw a cat" and route to DALL-E. The user explicitly activates media
 * mode through a UI affordance (the "+" menu in the composer → pick
 * Image / Video / Audio / Music), which sets `mediaMode` on the outgoing
 * message. Only then are media tools eligible.
 *
 * This mirrors the contract of every production media harness
 * (ChatGPT/Gemini/Claude): explicit UI mode selector, never prose
 * inference. Anything less is "the model hearing a phrase and winging
 * it" — explicitly rejected by the operator.
 *
 * The model's permitted behavior when media is NOT activated:
 *   - It may ASK: "I think you might want an image of this. If so,
 *     activate Image mode and I'll generate it. Here's what I had in
 *     mind: [description]."
 *   - It may NOT call any media tool.
 *   - The Governor-0 prompt enforces this via instruction; this module
 *     enforces it via runtime gate. Prose persuades, code enforces.
 *
 * Architecture:
 *   - `MediaMode` — union of activated modes; undefined means no media
 *   - `isMediaToolName(toolName)` — pattern match against known media tools
 *   - `mediaToolMode(toolName)` — which MediaMode a tool belongs to, if any
 *   - `checkMediaGate(activeMode, toolName)` — runtime gate; throws nothing,
 *     returns a decision so the agent loop can format a tool-error result
 */

export type MediaMode = "image" | "video" | "audio" | "music";

export const ALL_MEDIA_MODES: readonly MediaMode[] = ["image", "video", "audio", "music"] as const;

export function isMediaMode(value: unknown): value is MediaMode {
  return typeof value === "string" && (ALL_MEDIA_MODES as readonly string[]).includes(value);
}

/**
 * Pattern → mode mapping. A tool name matching multiple patterns picks
 * the first match. Patterns are intentionally narrow: false positives
 * mean unintended Credit burn, false negatives just mean the user
 * activates the matching mode.
 */
const MEDIA_TOOL_PATTERNS: ReadonlyArray<{ mode: MediaMode; pattern: RegExp }> = [
  // Video first (more specific) — Hailuo, video_gen, text-to-video
  { mode: "video", pattern: /hailuo/i },
  { mode: "video", pattern: /video[_-]?gen/i },
  { mode: "video", pattern: /text[_-]?to[_-]?video/i },
  { mode: "video", pattern: /generate[_-]?video/i },
  // Audio: TTS, speech, narration. Use explicit boundary anchors
  // (^|[_-]) because \b treats underscore as a word character, which
  // breaks matches against tool names like "tts__speak".
  { mode: "audio", pattern: /text[_-]?to[_-]?speech/i },
  { mode: "audio", pattern: /(^|[_-])tts($|[_-])/i },
  { mode: "audio", pattern: /generate[_-]?speech/i },
  { mode: "audio", pattern: /(^|[_-])speech[_-]?(?:gen|synth)($|[_-])/i },
  // Music: distinct from speech
  { mode: "music", pattern: /music[_-]?gen/i },
  { mode: "music", pattern: /generate[_-]?music/i },
  { mode: "music", pattern: /(^|[_-])song[_-]?gen($|[_-])/i },
  // Voice: clone/design — treat as audio for gating purposes. Our
  // MediaMode union is fixed at 4 — voice clone/design is rare and
  // operator-explicit, route it under "audio" for gating.
  { mode: "audio", pattern: /voice[_-]?clone/i },
  { mode: "audio", pattern: /voice[_-]?design/i },
  // Image last (most generic noun)
  { mode: "image", pattern: /image[_-]?gen/i },
  { mode: "image", pattern: /text[_-]?to[_-]?image/i },
  { mode: "image", pattern: /generate[_-]?image/i },
  { mode: "image", pattern: /dall[_-]?e/i },
  { mode: "image", pattern: /stable[_-]?diffusion/i },
];

export function isMediaToolName(toolName: string): boolean {
  if (!toolName) return false;
  return MEDIA_TOOL_PATTERNS.some((p) => p.pattern.test(toolName));
}

export function mediaToolMode(toolName: string): MediaMode | undefined {
  if (!toolName) return undefined;
  return MEDIA_TOOL_PATTERNS.find((p) => p.pattern.test(toolName))?.mode;
}

export type MediaGateDecision =
  | { allowed: true }
  | { allowed: false; reason: string; toolMode: MediaMode | undefined; activeMode: MediaMode | undefined };

/**
 * Runtime gate. Called from executeMcpToolCall BEFORE the safety-mode
 * decision. Non-media tools always pass. Media tools require an active
 * MediaMode set explicitly by the client (via the composer's "+" menu).
 *
 * The gate is permissive about mode coverage: if the user activated
 * "image" mode and the model calls a "video" tool, we block — the user
 * asked for image work specifically. They can re-activate video mode if
 * that's what they actually wanted. This permissiveness is the point:
 * the user is in control of which finite-Credit pool is eligible to
 * burn, not the model.
 */
export function checkMediaGate(activeMode: MediaMode | undefined, toolName: string): MediaGateDecision {
  const toolMode = mediaToolMode(toolName);
  if (!toolMode) return { allowed: true };

  if (activeMode === undefined) {
    return {
      allowed: false,
      toolMode,
      activeMode: undefined,
      reason: `Media tool "${toolName}" blocked: no media mode is active. Media generation draws from finite Credits and must be explicitly activated by the user (composer "+" menu). If you believe the user wants ${toolMode} generation, ASK them to activate ${toolMode} mode — do not call the tool.`,
    };
  }

  if (activeMode !== toolMode) {
    return {
      allowed: false,
      toolMode,
      activeMode,
      reason: `Media tool "${toolName}" is a ${toolMode} tool but active media mode is ${activeMode}. The user explicitly activated ${activeMode} generation. Ask the user to switch modes if ${toolMode} is what they actually want.`,
    };
  }

  return { allowed: true };
}
