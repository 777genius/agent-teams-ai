import type { CodexAppServerModelLike } from './normalizeCodexAppServerModel';

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isHiddenVisibility(value: unknown): boolean {
  const visibility = asTrimmedString(value)?.toLowerCase();
  return visibility === 'hide' || visibility === 'hidden';
}

/**
 * Local Codex catalogs (mixin / cursor-proxy JSON) use `slug`, snake_case
 * fields, and `{id, name}` rows. App-server `model/list` uses camelCase `id`.
 */
export function coerceCodexCatalogModelInput(raw: unknown): CodexAppServerModelLike | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const id =
    asTrimmedString(record.id) ?? asTrimmedString(record.model) ?? asTrimmedString(record.slug);
  if (!id) {
    return null;
  }

  const displayName =
    asTrimmedString(record.displayName) ??
    asTrimmedString(record.display_name) ??
    asTrimmedString(record.name) ??
    undefined;
  const hidden = record.hidden === true || isHiddenVisibility(record.visibility);
  const supportedReasoningEfforts =
    record.supportedReasoningEfforts ?? record.supported_reasoning_levels;
  const defaultReasoningEffort =
    record.defaultReasoningEffort ??
    record.default_reasoning_effort ??
    record.default_reasoning_level;
  const inputModalities = record.inputModalities ?? record.input_modalities;
  const additionalSpeedTiers = record.additionalSpeedTiers ?? record.additional_speed_tiers;
  const serviceTiers = record.serviceTiers ?? record.service_tiers;
  const supportedServiceTiers = record.supportedServiceTiers ?? record.supported_service_tiers;

  return {
    id,
    model: asTrimmedString(record.model) ?? id,
    displayName,
    hidden,
    supportedReasoningEfforts: Array.isArray(supportedReasoningEfforts)
      ? supportedReasoningEfforts
      : undefined,
    defaultReasoningEffort,
    additionalSpeedTiers,
    serviceTiers,
    supportedServiceTiers,
    supportsFastMode: asBoolean(record.supportsFastMode) ?? asBoolean(record.supports_fast_mode),
    inputModalities,
    supportsPersonality:
      asBoolean(record.supportsPersonality) ?? asBoolean(record.supports_personality),
    isDefault: asBoolean(record.isDefault) ?? asBoolean(record.is_default),
    upgrade: record.upgrade,
    availabilityNux: record.availabilityNux ?? record.availability_nux,
  };
}

export function extractCodexCatalogModelRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = readRecord(payload);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.models)) {
    return record.models;
  }
  if (Array.isArray(record.data)) {
    return record.data;
  }
  return [];
}

const MODEL_CATALOG_JSON_ASSIGNMENT = /^\s*model_catalog_json\s*=\s*(?:"([^"]+)"|'([^']+)')/m;

export function parseCodexModelCatalogJsonPathFromToml(toml: string): string | null {
  const match = MODEL_CATALOG_JSON_ASSIGNMENT.exec(toml);
  const configured = match?.[1] ?? match?.[2] ?? null;
  return configured?.trim() || null;
}
