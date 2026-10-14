export function normalizeProviderModelListModels(
  provider: { defaultModel?: string | null; models?: (string | { id?: string; label?: string })[] } | undefined
): Set<string> {
  const models = new Set<string>();
  const defaultModel = provider?.defaultModel?.trim();
  if (defaultModel) {
    models.add(defaultModel);
  }
  for (const entry of provider?.models ?? []) {
    const modelId = typeof entry === 'string' ? entry : entry.id;
    const trimmed = modelId?.trim();
    if (trimmed) {
      models.add(trimmed);
    }
  }
  return models;
}
