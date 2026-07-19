/**
 * Per-Model Rate Limiter
 * ======================
 *
 * Closes the M3 RPM risk surfaced when the catalog started carrying
 * `rateLimits.rpm` per model. The catalog stores the limit; this module
 * enforces it via a sliding-window counter. Without this, the router
 * could route the operator's entire 5-hour MiniMax quota at M3 (200 RPM)
 * and stall on 429s while M2.7 (500 RPM) sat idle.
 *
 * Design:
 *   - Sliding 60-second window per model id
 *   - One timestamp per accepted request; expired entries evicted on
 *     every check (so memory is bounded by RPM × 60s × active models,
 *     which for this catalog is ~30k timestamps worst case — trivial)
 *   - When the chosen model would exceed its window, the caller asks for
 *     alternates via `findSameProviderAlternate` (runtime-resolver) and
 *     retries routing against a different entry
 *   - `null` RPM in the catalog = "no documented limit" — limiter never
 *     throttles. Z.AI's Coding Plan has prompt-window limits enforced
 *     server-side, not per-minute RPM, so catalog stores null.
 *
 * Thread-safety: Bun's single-threaded event loop means no mutex is
 * needed. The Map mutations here happen on the main tick; no `await`
 * occurs between check-and-record, so two concurrent requests cannot
 * race past the limit.
 *
 * NOT a quota tracker: this enforces per-minute RPM only. It does not
 * track 5-hour rolling windows or weekly windows — those are the
 * providers' responsibility to enforce via 429 responses, and the
 * harness's job is to back off when they do (handled by the existing
 * primary→backup failover path).
 */

import { findModelEntry, type ModelCatalog } from "./model-catalog";
import { findSameProviderAlternate } from "./runtime-resolver";

const WINDOW_MS = 60_000;

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; limit: number; windowMs: number; activeCount: number };

export class ModelRateLimiter {
  private readonly inflight = new Map<string, number[]>();
  private readonly catalog: ModelCatalog;

  constructor(catalog: ModelCatalog) {
    this.catalog = catalog;
  }

  /**
   * Check whether a model can accept a request right now. Does NOT record
   * the request — call `recordRequest` only when the request is actually
   * dispatched, so abandoned/throttled requests don't pollute the window.
   */
  check(modelId: string, now: number = Date.now()): RateLimitDecision {
    const entry = findModelEntry(this.catalog, modelId);
    const rpm = entry?.rateLimits.rpm ?? null;
    if (rpm === null) return { allowed: true };

    const timestamps = this.evictExpired(this.inflight.get(modelId) ?? [], now);
    this.inflight.set(modelId, timestamps);
    if (timestamps.length < rpm) return { allowed: true };
    return { allowed: false, limit: rpm, windowMs: WINDOW_MS, activeCount: timestamps.length };
  }

  /**
   * Record that a request was actually dispatched. Called by the agent
   * loop right before fetch(). Idempotent against duplicate calls within
   * the same tick — the caller does not need to deduplicate.
   */
  recordRequest(modelId: string, now: number = Date.now()): void {
    const entry = findModelEntry(this.catalog, modelId);
    if (!entry) return;
    if (entry.rateLimits.rpm === null) return;
    const current = this.evictExpired(this.inflight.get(modelId) ?? [], now);
    current.push(now);
    this.inflight.set(modelId, current);
  }

  /**
   * Snapshot for observability — surface this in the UI so the operator
   * can see how close each model is to its RPM cap.
   */
  snapshot(now: number = Date.now()): Array<{ modelId: string; rpm: number | null; activeInWindow: number }> {
    return this.catalog.models.map((entry) => ({
      modelId: entry.id,
      rpm: entry.rateLimits.rpm,
      activeInWindow: this.evictExpired(this.inflight.get(entry.id) ?? [], now).length,
    }));
  }

  /**
   * Test-only: reset all windows. Production never calls this.
   */
  resetForTest(): void {
    this.inflight.clear();
  }

  private evictExpired(timestamps: number[], now: number): number[] {
    const cutoff = now - WINDOW_MS;
    return timestamps.filter((t) => t > cutoff);
  }
}

/**
 * Choose a model for the request, respecting rate limits. Tries the
 * router's first choice; if throttled, looks for a same-provider
 * alternate with the required modalities; if that's also throttled or
 * no alternate exists, returns the original decision with a `throttled`
 * flag so the caller can decide to wait or fail.
 *
 * `routeFn` is the pure routing function (passed in so this module
 * doesn't depend on router.ts — avoids an import cycle, since router
 * already imports from model-catalog).
 */
export function routeWithRateLimit(args: {
  catalog: ModelCatalog;
  limiter: ModelRateLimiter;
  requiredModalities: string[];
  firstChoiceModelId: string;
  now?: number;
}): { modelId: string; throttled: boolean; reason: string; alternateUsed: boolean } {
  const { catalog, limiter, requiredModalities, firstChoiceModelId } = args;
  const now = args.now ?? Date.now();

  const firstCheck = limiter.check(firstChoiceModelId, now);
  if (firstCheck.allowed) {
    return { modelId: firstChoiceModelId, throttled: false, reason: "rate ok", alternateUsed: false };
  }

  // Same-provider alternate with same modalities
  const altEntry = findSameProviderAlternate(catalog, firstChoiceModelId, requiredModalities);
  if (altEntry) {
    const altCheck = limiter.check(altEntry.id, now);
    if (altCheck.allowed) {
      return {
        modelId: altEntry.id,
        throttled: false,
        reason: `primary ${firstChoiceModelId} at RPM cap (${firstCheck.limit}); shed to ${altEntry.id}`,
        alternateUsed: true,
      };
    }
  }

  return {
    modelId: firstChoiceModelId,
    throttled: true,
    reason: `primary ${firstChoiceModelId} at RPM cap and no same-provider alternate available`,
    alternateUsed: false,
  };
}
