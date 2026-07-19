/**
 * Catalog-Driven Runtime Resolver
 * ===============================
 *
 * Closes the architectural debt surfaced when the router (I-10) picked a
 * model from the catalog but the runtime was still constructed from
 * scattered env vars (HARNESS_API_KEY, HARNESS_BACKUP_API_KEY). The
 * catalog is now the single source of truth per Decision 3 (LOCKED):
 * provider endpoint, API path, credential env-var name, and per-model
 * reasoning config all flow from the catalog into a typed runtime.
 *
 * Why a separate module from server-core.ts:
 *   server-core owns protocol shapes (OpenAiCompatibleRuntime,
 *   AnthropicRuntime). Catalog-driven construction depends on the catalog
 *   types, which would create an import cycle if it lived in server-core.
 *   Keeping it here means server-core stays catalog-agnostic and the
 *   dependency flows one direction: runtime-resolver → server-core +
 *   model-catalog.
 *
 * Credential lookup: the provider declares `credentialEnv` (the env var
 * name). This function looks it up at call time. The credential is never
 * cached on the runtime object — the runtime carries only the URL/path/
 * token budget; the key is passed alongside. This avoids accidentally
 * serializing credentials in logs that print the runtime object.
 */

import type { ModelRuntime, OpenAiCompatibleRuntime, AnthropicRuntime } from "./server-core";
import {
  DEFAULT_ANTHROPIC_API_MAX_TOKENS,
  DEFAULT_ANTHROPIC_API_TEMPERATURE,
  DEFAULT_API_TEMPERATURE,
} from "./server-core";
import {
  findModelEntry,
  getProvider,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogProvider,
} from "./model-catalog";

export type ResolvedRuntime = {
  runtime: ModelRuntime;
  /** API key resolved from the provider's `credentialEnv` env var. */
  key: string;
  /** The catalog entry the runtime was built from. */
  entry: ModelCatalogEntry;
  /** The catalog provider the runtime was built from. */
  provider: ModelCatalogProvider;
};

/**
 * Build a runtime + credential for a specific catalog entry. This is the
 * ONLY sanctioned way to construct a runtime from the catalog. Throws
 * when the credential env var is unset, when the provider is unknown, or
 * when the entry doesn't exist in the catalog — fail-closed at startup
 * beats a silent fallback at request time.
 *
 * @param catalog The loaded model catalog.
 * @param modelId The model entry id (must be present in the catalog).
 * @param env The environment to resolve credentials from.
 */
export function runtimeFromCatalogEntry(
  catalog: ModelCatalog,
  modelId: string,
  env: NodeJS.ProcessEnv,
): ResolvedRuntime {
  const entry = findModelEntry(catalog, modelId);
  if (!entry) {
    throw new Error(`runtimeFromCatalogEntry: model "${modelId}" not in catalog`);
  }
  const provider = getProvider(catalog, entry.provider);
  const key = resolveCredential(provider, env);

  if (provider.runtimeKind === "anthropic") {
    const runtime: AnthropicRuntime = {
      kind: "anthropic",
      modelId: entry.id,
      apiBaseUrl: stripTrailingSlash(provider.apiBaseUrl),
      maxTokens: clampMaxTokens(entry.maxOutput, DEFAULT_ANTHROPIC_API_MAX_TOKENS),
      temperature: DEFAULT_ANTHROPIC_API_TEMPERATURE,
    };
    return { runtime, key, entry, provider };
  }

  const runtime: OpenAiCompatibleRuntime = {
    kind: "openai-compatible",
    modelId: entry.id,
    apiBaseUrl: stripTrailingSlash(provider.apiBaseUrl),
    apiPath: provider.apiPath,
    maxTokens: clampMaxTokens(entry.maxOutput, entry.maxOutput),
    temperature: DEFAULT_API_TEMPERATURE,
  };
  return { runtime, key, entry, provider };
}

/**
 * Build the backup runtime from the catalog's `defaults.backupModelId`.
 * Returns null when the catalog has no backup (or it equals the primary
 * model). The agent loop uses this instead of the old
 * `resolveBackupOpenAiRuntime` env-var path.
 *
 * For now, the backup is always the catalog's declared default. A future
 * revision may pick a per-primary backup based on modality (e.g. M3's
 * backup is M2.7, not glm-5.2). That logic lives here when it's added.
 */
export function backupRuntimeFromCatalog(
  catalog: ModelCatalog,
  primaryModelId: string,
  env: NodeJS.ProcessEnv,
): ResolvedRuntime | null {
  if (catalog.defaults.backupModelId === primaryModelId) return null;
  return runtimeFromCatalogEntry(catalog, catalog.defaults.backupModelId, env);
}

/**
 * Find an alternate model in the same provider when a rate limiter
 * throttles the chosen model. Returns null when no same-modality sibling
 * exists with available rate-limit headroom (caller decides whether to
 * retry the original or fail).
 *
 * Selection criteria, in order:
 *   1. Same provider (so credential lookup is identical)
 *   2. Accepts every modality the request needs
 *   3. Highest RPM among the candidates
 *
 * Does NOT cross providers — cross-provider failover requires re-resolving
 * credentials and is the job of the agent loop's primary→backup path,
 * not this function.
 */
export function findSameProviderAlternate(
  catalog: ModelCatalog,
  chosenModelId: string,
  requiredModalities: string[],
): ModelCatalogEntry | null {
  const chosen = findModelEntry(catalog, chosenModelId);
  if (!chosen) return null;
  const candidates = catalog.models.filter((m) =>
    m.provider === chosen.provider
    && m.id !== chosen.id
    && requiredModalities.every((mod) => m.modalities.input.includes(mod)),
  );
  if (candidates.length === 0) return null;
  // Prefer highest RPM; null RPM means "no documented limit" — treat as infinity.
  candidates.sort((a, b) => (b.rateLimits.rpm ?? Number.MAX_SAFE_INTEGER) - (a.rateLimits.rpm ?? Number.MAX_SAFE_INTEGER));
  return candidates[0] ?? null;
}

function resolveCredential(provider: ModelCatalogProvider, env: NodeJS.ProcessEnv): string {
  const varName = provider.credentialEnv;
  const raw = env[varName]?.trim();
  if (!raw) {
    throw new Error(
      `Credential env var "${varName}" (declared by provider "${provider.displayName}") is not set`,
    );
  }
  return raw;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Clamp the runtime's maxTokens to the model's declared maxOutput.
 * Catalog entries are authoritative — if the catalog says 8192 max output,
 * we never ask for more, even if a downstream caller would have.
 */
function clampMaxTokens(catalogMax: number, fallback: number): number {
  if (!Number.isFinite(catalogMax) || catalogMax <= 0) return fallback;
  return Math.min(catalogMax, fallback);
}
