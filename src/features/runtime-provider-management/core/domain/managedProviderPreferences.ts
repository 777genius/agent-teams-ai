export const MANAGED_MODEL_LIMIT_MAX_TOKENS = 100_000_000;
export interface ManagedModelLimitOverride extends Record<string, unknown> {
  contextTokens: number;
  outputTokens: number;
  updatedAt: string | null;
}
export interface ManagedProviderPreferences extends Record<string, unknown> {
  schemaVersion: 2;
  defaultModelId: string | null;
  modelLimitOverrides: Record<string, ManagedModelLimitOverride>;
  updatedAt: string | null;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved model preferences are invalid');
  return value as Record<string, unknown>;
};
export function validManagedModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    value.includes('/') &&
    value.trim() === value &&
    !/[\s\0]/.test(value) &&
    value.split('/').every(Boolean)
  );
}
export function validManagedModelLimits(context: unknown, output: unknown): boolean {
  return (
    [context, output].every(
      (value) =>
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MANAGED_MODEL_LIMIT_MAX_TOKENS
    ) && Number(output) <= Number(context)
  );
}
const date = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 128)
    throw new Error('Saved model preferences are invalid');
  return value;
};
export function emptyManagedPreferences(): ManagedProviderPreferences {
  return { schemaVersion: 2, defaultModelId: null, modelLimitOverrides: {}, updatedAt: null };
}

/** Read frozen v1/v2 data without losing unrelated fields. Corruption is never an empty profile. */
export function parseManagedPreferences(value: unknown): ManagedProviderPreferences {
  const record = object(value);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2)
    throw new Error('Saved model preferences version is unsupported');
  const model = record.defaultModelId ?? null;
  if (model !== null && !validManagedModelId(model))
    throw new Error('Saved default model is invalid');
  const overrides =
    record.modelLimitOverrides === undefined ? {} : object(record.modelLimitOverrides);
  if (Object.keys(overrides).length > 4096) throw new Error('Saved model preferences are invalid');
  const limits = Object.fromEntries(
    Object.entries(overrides).map(([modelId, raw]) => {
      const entry = object(raw);
      if (
        !validManagedModelId(modelId) ||
        !validManagedModelLimits(entry.contextTokens, entry.outputTokens)
      )
        throw new Error('Saved model limits are invalid');
      return [
        modelId,
        {
          ...entry,
          contextTokens: Number(entry.contextTokens),
          outputTokens: Number(entry.outputTokens),
          updatedAt: date(entry.updatedAt),
        },
      ];
    })
  );
  return {
    ...record,
    schemaVersion: 2,
    defaultModelId: model,
    modelLimitOverrides: limits,
    updatedAt: date(record.updatedAt),
  };
}

export function resolveManagedPreferences(
  project: ManagedProviderPreferences | null,
  global: ManagedProviderPreferences,
  nativeDefault: string | null
) {
  const modelId = project?.defaultModelId ?? global.defaultModelId ?? nativeDefault;
  return {
    projectDefaultModel: project?.defaultModelId ?? null,
    allProjectsDefaultModel: global.defaultModelId,
    defaultModel: modelId,
    fallbackModel: global.defaultModelId ?? nativeDefault,
    defaultModelSource: project?.defaultModelId
      ? ('project' as const)
      : global.defaultModelId
        ? ('all_projects' as const)
        : nativeDefault
          ? ('opencode_config' as const)
          : null,
    modelLimitOverrides: { ...global.modelLimitOverrides, ...project?.modelLimitOverrides },
  };
}
