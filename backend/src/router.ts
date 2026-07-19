/**
 * Capability Router
 * =================
 *
 * Picks the right model from the catalog for an incoming request. Routes by:
 *   - Attachment shape (image/video input forces a multimodal model)
 *   - Prompt verbs (deep-reasoning triggers vs. lightweight triggers)
 *   - Conversation context (continuation sticks with the prior turn's
 *     provider unless a hard constraint forces a switch)
 *
 * The router is a pure function: same inputs always produce the same
 * `RoutingDecision`. No state, no IO. This is the catalog-driven
 * discipline (Decision 3) — routing logic lives in one file and is
 * exercised by tests; no `if (prompt.includes(...))` branches scattered
 * through the agent loops.
 *
 * Decision precedence (highest first):
 *   1. Explicit modelId in the request → honor it (user override);
 *      routeAndValidate will still throw if the override is incompatible
 *      with the attachment shape (e.g. text-only model + image attachment)
 *   2. Image/video attachment → vision-capable model (per catalog defaults)
 *   3. Deep-reasoning verbs in prompt → primary deep-reasoning model
 *   4. Lightweight verbs in prompt → catalog's lightweight tier
 *   5. Continuation of a prior conversation → stay on prior provider
 *   6. Default → catalog default primary model
 *
 * Vision routing: GLM-4.6v is UNVERIFIED for Coding Plan coverage per the
 * catalog. Until verification, all image/video input routes to
 * `defaults.visionFallbackModelId` (currently MiniMax-M3).
 *
 * The router does NOT enforce rate limits or quota. That's a future
 * concern (snapshot §7); for now we pick the right model and let the
 * runtime fail over on 429s via the existing backup path.
 */

import {
  findModelEntry,
  getDefaultModel,
  getVisionFallbackModel,
  modelAcceptsInput,
  type ModelCatalog,
} from "./model-catalog";

export type RoutingRequest = {
  /** User's prompt text. Lowercased for verb matching. */
  prompt: string;
  /** Attachments from the WebSocket message. */
  attachments?: Array<{ name: string; size: number; type: string }>;
  /** Optional explicit model override from the client. */
  requestedModelId?: string;
  /** Optional prior-provider id, used to continue on the same provider. */
  priorProviderId?: string;
};

export type RoutingDecision = {
  modelId: string;
  provider: string;
  reason: string;
};

const DEEP_REASONING_VERBS = [
  "refactor",
  "architect",
  "design",
  "audit",
  "migrate",
  "rewrite",
  "analyze",
  "diagnose",
  "debug",
  "investigate",
  "trace",
  "verify",
];

const LIGHTWEIGHT_VERBS = [
  "summarize",
  "tl;dr",
  "what is",
  "what's",
  "explain",
  "describe",
  "list",
  "show",
];

/**
 * Route a request to a model from the catalog. Pure function — no side
 * effects, no IO. Throws only when the catalog is corrupt (e.g. default
 * model missing) — never when the request is unusual.
 */
export function routeRequest(catalog: ModelCatalog, request: RoutingRequest): RoutingDecision {
  // 1. Explicit user override — honor as long as it exists in the catalog.
  //    (If the override is incompatible with attachments, routeAndValidate
  //    catches it after routing. We don't preempt the operator's choice.)
  if (request.requestedModelId) {
    const requested = findModelEntry(catalog, request.requestedModelId);
    if (requested) {
      return {
        modelId: requested.id,
        provider: requested.provider,
        reason: `client requested explicit model ${requested.id}`,
      };
    }
    // Unknown override → fall through with a reason that explains the ignore
    // (do NOT throw — the user's prompt still needs an answer)
  }

  // 2. Vision / multimodal attachments force a multimodal model when no
  //    explicit override was provided (or the override was unknown).
  //    Image input → prefer GLM-4.6v (Coding Plan Max, renewable quota,
  //    verified 2026-07-11). Video input → MiniMax-M3 (only model with
  //    video input modality).
  const imageAttachment = request.attachments?.find((a) => isImageType(a.type));
  const videoAttachment = request.attachments?.find((a) => isVideoType(a.type));
  if (videoAttachment) {
    const fallback = getVisionFallbackModel(catalog);
    return {
      modelId: fallback.id,
      provider: fallback.provider,
      reason: `attachment "${videoAttachment.name}" (${videoAttachment.type}) requires video input — only ${fallback.id} accepts video`,
    };
  }
  if (imageAttachment) {
    // Prefer a verified plan-covered vision model from the renewable tier;
    // fall back to visionFallbackModelId if none exists in the catalog.
    const imageCapable = catalog.models.find(
      (m) => modelAcceptsInput(catalog, m.id, "image")
        && m.planCoverage === "verified"
        && m.rateLimits.quotaTier === 1,
    );
    const chosen = imageCapable ?? getVisionFallbackModel(catalog);
    return {
      modelId: chosen.id,
      provider: chosen.provider,
      reason: `attachment "${imageAttachment.name}" (${imageAttachment.type}) requires image input — routing to ${chosen.id} (${imageCapable ? "renewable tier preferred" : "fallback"})`,
    };
  }

  // 3. Deep-reasoning verbs → primary deep-reasoning model
  const promptLower = request.prompt.toLowerCase();
  const deepVerb = DEEP_REASONING_VERBS.find((v) => promptLower.includes(v));
  if (deepVerb) {
    const primary = getDefaultModel(catalog);
    return {
      modelId: primary.id,
      provider: primary.provider,
      reason: `prompt verb "${deepVerb}" triggered deep-reasoning primary ${primary.id}`,
    };
  }

  // 4. Lightweight verbs → find a model with the "lightweight" or "cheap" role
  const lightVerb = LIGHTWEIGHT_VERBS.find((v) => promptLower.includes(v));
  if (lightVerb) {
    const cheap = catalog.models.find((m) => m.roles.includes("lightweight") || m.roles.includes("cheap") || m.roles.includes("disposable"));
    if (cheap) {
      return {
        modelId: cheap.id,
        provider: cheap.provider,
        reason: `prompt verb "${lightVerb}" triggered lightweight ${cheap.id}`,
      };
    }
  }

  // 5. Continuation — stick with prior provider when known
  if (request.priorProviderId) {
    const sameProvider = catalog.models.find((m) => m.provider === request.priorProviderId && m.id === catalog.defaults.primaryModelId)
      ?? catalog.models.find((m) => m.provider === request.priorProviderId);
    if (sameProvider) {
      return {
        modelId: sameProvider.id,
        provider: sameProvider.provider,
        reason: `continuing on prior provider ${request.priorProviderId} → ${sameProvider.id}`,
      };
    }
  }

  // 6. Default fallback
  const primary = getDefaultModel(catalog);
  return {
    modelId: primary.id,
    provider: primary.provider,
    reason: "no routing signal matched — using catalog default primary",
  };
}

/**
 * Convenience: route and verify the chosen model accepts every attachment's
 * modality. Returns the same RoutingDecision if all checks pass; throws
 * with a precise message if the routing picked a model that cannot handle
 * an attachment. This is the runtime guard that catches catalog routing
 * bugs (e.g. a vision attachment routed to a text-only model).
 */
export function routeAndValidate(catalog: ModelCatalog, request: RoutingRequest): RoutingDecision {
  const decision = routeRequest(catalog, request);
  for (const attachment of request.attachments ?? []) {
    const modality = modalityFromMime(attachment.type);
    if (modality && !modelAcceptsInput(catalog, decision.modelId, modality)) {
      throw new Error(
        `Routing picked ${decision.modelId} but attachment "${attachment.name}" (${attachment.type}) requires ${modality} input`,
      );
    }
  }
  return decision;
}

function isImageType(mime: string): boolean {
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(mime);
}

function isVideoType(mime: string): boolean {
  return mime.startsWith("video/") || /\.(mp4|mov|avi|webm|mkv)$/i.test(mime);
}

function modalityFromMime(mime: string): string | undefined {
  if (isImageType(mime)) return "image";
  if (isVideoType(mime)) return "video";
  if (mime.startsWith("text/")) return "text";
  return undefined;
}
