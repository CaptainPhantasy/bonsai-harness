/**
 * Model Catalog Loader
 * ====================
 *
 * Data-driven reasoning config per Decision 3 (LOCKED): the catalog file at
 * `<PROJECT_ROOT>/backend/models.json` is the single source of truth for
 * model identity, endpoints, modalities, reasoning budget, and rate limits.
 * No `if (model === ...)` branches in runtime code — every per-model
 * behavior is a JSON path lookup.
 *
 * Why a sibling module and not in server-core.ts:
 *   server-core.ts owns protocol/runtime-shape concerns; the catalog is a
 *   pure-data accessor with its own validation surface. Keeping them
 *   separate prevents server-core from accreting catalog-specific tests.
 *
 * The catalog is read once at first access and cached for the lifetime of
 * the process. Hot-reload is not provided — a catalog change requires a
 * server restart. This is deliberate: a model going away mid-conversation
 * would be worse than a refused start.
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PROJECT_ROOT } from "./server-core";

export type ModelReasoningKind = "always-on" | "toggleable" | "off";
export type ModelReasoningEffort = "low" | "medium" | "high" | "max" | "none";

export type ModelCatalogModalities = {
  input: string[];
  output: string[];
};

export type ModelCatalogReasoning = {
  kind: ModelReasoningKind;
  budgetTokens: number;
  effort: ModelReasoningEffort;
};

export type ModelCatalogRateLimits = {
  rpm: number | null;
  quotaTier: 1 | 2 | 3;
  peakMultiplier?: number;
  offPeakMultiplier?: number;
};

export type ModelCatalogProvider = {
  displayName: string;
  runtimeKind: "openai-compatible" | "anthropic";
  apiBaseUrl: string;
  apiPath: string;
  credentialEnv: string;
  authBrokerProvider: string;
  subscription: string;
};

export type ModelCatalogEntry = {
  id: string;
  displayName: string;
  provider: string;
  context: number;
  maxOutput: number;
  modalities: ModelCatalogModalities;
  reasoning: ModelCatalogReasoning;
  rateLimits: ModelCatalogRateLimits;
  roles: string[];
  notes?: string;
  planCoverage?: "verified" | "unverified";
};

export type ModelCatalogDefaults = {
  primaryModelId: string;
  backupModelId: string;
  visionFallbackModelId: string;
  reasoningBudgetTokens: number;
  maxAgentToolRounds: number;
};

export type ModelCatalog = {
  version: number;
  generatedAt: string;
  source?: string;
  notes?: string;
  providers: Record<string, ModelCatalogProvider>;
  models: ModelCatalogEntry[];
  defaults: ModelCatalogDefaults;
};

const CATALOG_PATH = join(PROJECT_ROOT, "backend", "models.json");

let cached: ModelCatalog | null = null;

/**
 * Load (and cache) the model catalog. Reads from disk on first access,
 * returns the cached value thereafter. Throws on missing file, malformed
 * JSON, or schema violation — fail-closed at startup beats a silent
 * fallback at runtime.
 */
export function loadModelCatalog(): ModelCatalog {
  if (cached) return cached;
  if (!existsSync(CATALOG_PATH)) {
    throw new Error(`Model catalog not found at ${CATALOG_PATH}`);
  }
  const text = readFileSync(CATALOG_PATH, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Model catalog JSON is malformed: ${String(error)}`);
  }
  cached = validateCatalog(parsed);
  return cached;
}

/**
 * Drop the cache. Tests use this to swap in a fixture catalog; production
 * never calls it.
 */
export function resetModelCatalogCache(): void {
  cached = null;
}

/**
 * Load the catalog from an explicit path, bypassing the cache. Used by
 * tests that need to validate a fixture without polluting the global
 * cache. Production code uses loadModelCatalog().
 */
export function loadModelCatalogFromPath(absolutePath: string): ModelCatalog {
  if (!existsSync(absolutePath)) {
    throw new Error(`Model catalog not found at ${absolutePath}`);
  }
  const text = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  return validateCatalog(parsed);
}

export function findModelEntry(catalog: ModelCatalog, id: string): ModelCatalogEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

export function getDefaultModel(catalog: ModelCatalog): ModelCatalogEntry {
  const primary = findModelEntry(catalog, catalog.defaults.primaryModelId);
  if (!primary) {
    throw new Error(`Default primary model "${catalog.defaults.primaryModelId}" is not present in catalog`);
  }
  return primary;
}

export function getBackupModel(catalog: ModelCatalog): ModelCatalogEntry {
  const backup = findModelEntry(catalog, catalog.defaults.backupModelId);
  if (!backup) {
    throw new Error(`Default backup model "${catalog.defaults.backupModelId}" is not present in catalog`);
  }
  return backup;
}

export function getVisionFallbackModel(catalog: ModelCatalog): ModelCatalogEntry {
  const vision = findModelEntry(catalog, catalog.defaults.visionFallbackModelId);
  if (!vision) {
    throw new Error(`Vision fallback model "${catalog.defaults.visionFallbackModelId}" is not present in catalog`);
  }
  return vision;
}

export function getProvider(catalog: ModelCatalog, providerId: string): ModelCatalogProvider {
  const provider = catalog.providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider "${providerId}". Known: ${Object.keys(catalog.providers).join(", ")}`);
  }
  return provider;
}

/**
 * Return true if the model accepts the named input modality (e.g. "image").
 * Used by the capability router to filter candidates for attachment-shaped
 * prompts.
 */
export function modelAcceptsInput(catalog: ModelCatalog, modelId: string, modality: string): boolean {
  const entry = findModelEntry(catalog, modelId);
  return entry ? entry.modalities.input.includes(modality) : false;
}

/**
 * Validate the raw parsed JSON against the catalog schema. Permissive on
 * optional fields; strict on required shape. Returns a typed catalog or
 * throws with a precise message naming the violated invariant.
 */
function validateCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object") {
    throw new Error("Model catalog must be a JSON object");
  }
  const root = value as Record<string, unknown>;
  if (typeof root.version !== "number" || !Number.isFinite(root.version)) {
    throw new Error("Model catalog: missing or invalid `version`");
  }
  if (typeof root.generatedAt !== "string" || root.generatedAt.length === 0) {
    throw new Error("Model catalog: missing or invalid `generatedAt`");
  }
  const providers = validateProviders(root.providers);
  const models = validateModels(root.models, providers);
  const defaults = validateDefaults(root.defaults, models);
  const source = typeof root.source === "string" ? root.source : undefined;
  const notes = typeof root.notes === "string" ? root.notes : undefined;
  return {
    version: root.version,
    generatedAt: root.generatedAt,
    ...(source !== undefined ? { source } : {}),
    ...(notes !== undefined ? { notes } : {}),
    providers,
    models,
    defaults,
  };
}

function validateProviders(value: unknown): Record<string, ModelCatalogProvider> {
  if (!value || typeof value !== "object") {
    throw new Error("Model catalog: `providers` must be an object");
  }
  const out: Record<string, ModelCatalogProvider> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Provider "${id}" must be an object`);
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.displayName !== "string") throw new Error(`Provider "${id}": missing displayName`);
    if (p.runtimeKind !== "openai-compatible" && p.runtimeKind !== "anthropic") {
      throw new Error(`Provider "${id}": runtimeKind must be openai-compatible or anthropic`);
    }
    if (typeof p.apiBaseUrl !== "string") throw new Error(`Provider "${id}": missing apiBaseUrl`);
    if (typeof p.apiPath !== "string") throw new Error(`Provider "${id}": missing apiPath`);
    if (typeof p.credentialEnv !== "string") throw new Error(`Provider "${id}": missing credentialEnv`);
    if (typeof p.authBrokerProvider !== "string") throw new Error(`Provider "${id}": missing authBrokerProvider`);
    if (typeof p.subscription !== "string") throw new Error(`Provider "${id}": missing subscription`);
    out[id] = {
      displayName: p.displayName,
      runtimeKind: p.runtimeKind,
      apiBaseUrl: p.apiBaseUrl,
      apiPath: p.apiPath,
      credentialEnv: p.credentialEnv,
      authBrokerProvider: p.authBrokerProvider,
      subscription: p.subscription,
    };
  }
  return out;
}

function validateModels(
  value: unknown,
  providers: Record<string, ModelCatalogProvider>,
): ModelCatalogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Model catalog: `models` must be an array");
  }
  const seen = new Set<string>();
  const out: ModelCatalogEntry[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    if (!raw || typeof raw !== "object") {
      throw new Error(`Model catalog: models[${i}] must be an object`);
    }
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) throw new Error(`Model catalog: models[${i}].id missing`);
    if (seen.has(m.id)) throw new Error(`Model catalog: duplicate model id "${m.id}"`);
    seen.add(m.id);
    if (typeof m.provider !== "string" || !providers[m.provider]) {
      throw new Error(`Model "${m.id}": unknown provider "${String(m.provider)}"`);
    }
    if (typeof m.displayName !== "string") throw new Error(`Model "${m.id}": missing displayName`);
    if (typeof m.context !== "number" || m.context <= 0) throw new Error(`Model "${m.id}": invalid context`);
    if (typeof m.maxOutput !== "number" || m.maxOutput <= 0) throw new Error(`Model "${m.id}": invalid maxOutput`);
    out.push({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      context: m.context,
      maxOutput: m.maxOutput,
      modalities: validateModalities(m.modalities, m.id),
      reasoning: validateReasoning(m.reasoning, m.id),
      rateLimits: validateRateLimits(m.rateLimits, m.id),
      roles: validateRoles(m.roles, m.id),
      ...(typeof m.notes === "string" ? { notes: m.notes } : {}),
      ...(m.planCoverage === "verified" || m.planCoverage === "unverified" ? { planCoverage: m.planCoverage } : {}),
    });
  }
  return out;
}

function validateModalities(value: unknown, modelId: string): ModelCatalogModalities {
  if (!value || typeof value !== "object") {
    throw new Error(`Model "${modelId}": modalities must be an object`);
  }
  const m = value as Record<string, unknown>;
  if (!Array.isArray(m.input) || !m.input.every((v) => typeof v === "string")) {
    throw new Error(`Model "${modelId}": modalities.input must be a string array`);
  }
  if (!Array.isArray(m.output) || !m.output.every((v) => typeof v === "string")) {
    throw new Error(`Model "${modelId}": modalities.output must be a string array`);
  }
  return { input: m.input as string[], output: m.output as string[] };
}

function validateReasoning(value: unknown, modelId: string): ModelCatalogReasoning {
  if (!value || typeof value !== "object") {
    throw new Error(`Model "${modelId}": reasoning must be an object`);
  }
  const r = value as Record<string, unknown>;
  if (r.kind !== "always-on" && r.kind !== "toggleable" && r.kind !== "off") {
    throw new Error(`Model "${modelId}": reasoning.kind must be always-on, toggleable, or off`);
  }
  if (typeof r.budgetTokens !== "number" || r.budgetTokens < 0) {
    throw new Error(`Model "${modelId}": reasoning.budgetTokens must be a non-negative number`);
  }
  if (r.effort !== "low" && r.effort !== "medium" && r.effort !== "high" && r.effort !== "max" && r.effort !== "none") {
    throw new Error(`Model "${modelId}": reasoning.effort is invalid`);
  }
  return {
    kind: r.kind,
    budgetTokens: r.budgetTokens,
    effort: r.effort,
  };
}

function validateRateLimits(value: unknown, modelId: string): ModelCatalogRateLimits {
  if (!value || typeof value !== "object") {
    throw new Error(`Model "${modelId}": rateLimits must be an object`);
  }
  const r = value as Record<string, unknown>;
  if (r.rpm !== null && typeof r.rpm !== "number") {
    throw new Error(`Model "${modelId}": rateLimits.rpm must be a number or null`);
  }
  if (r.quotaTier !== 1 && r.quotaTier !== 2 && r.quotaTier !== 3) {
    throw new Error(`Model "${modelId}": rateLimits.quotaTier must be 1, 2, or 3`);
  }
  return {
    rpm: r.rpm as number | null,
    quotaTier: r.quotaTier as 1 | 2 | 3,
    ...(typeof r.peakMultiplier === "number" ? { peakMultiplier: r.peakMultiplier } : {}),
    ...(typeof r.offPeakMultiplier === "number" ? { offPeakMultiplier: r.offPeakMultiplier } : {}),
  };
}

function validateRoles(value: unknown, modelId: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`Model "${modelId}": roles must be a string array`);
  }
  return value as string[];
}

function validateDefaults(
  value: unknown,
  models: ModelCatalogEntry[],
): ModelCatalogDefaults {
  if (!value || typeof value !== "object") {
    throw new Error("Model catalog: `defaults` must be an object");
  }
  const d = value as Record<string, unknown>;
  const ids = new Set(models.map((m) => m.id));
  if (typeof d.primaryModelId !== "string" || !ids.has(d.primaryModelId)) {
    throw new Error(`defaults.primaryModelId "${String(d.primaryModelId)}" not in models`);
  }
  if (typeof d.backupModelId !== "string" || !ids.has(d.backupModelId)) {
    throw new Error(`defaults.backupModelId "${String(d.backupModelId)}" not in models`);
  }
  if (typeof d.visionFallbackModelId !== "string" || !ids.has(d.visionFallbackModelId)) {
    throw new Error(`defaults.visionFallbackModelId "${String(d.visionFallbackModelId)}" not in models`);
  }
  if (typeof d.reasoningBudgetTokens !== "number" || d.reasoningBudgetTokens <= 0) {
    throw new Error("defaults.reasoningBudgetTokens must be a positive number");
  }
  if (typeof d.maxAgentToolRounds !== "number" || d.maxAgentToolRounds <= 0) {
    throw new Error("defaults.maxAgentToolRounds must be a positive number");
  }
  return {
    primaryModelId: d.primaryModelId,
    backupModelId: d.backupModelId,
    visionFallbackModelId: d.visionFallbackModelId,
    reasoningBudgetTokens: d.reasoningBudgetTokens,
    maxAgentToolRounds: d.maxAgentToolRounds,
  };
}
