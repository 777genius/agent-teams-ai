import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

export function parseStrictQualifiedModelRef(modelId: string | null | undefined) {
  const parsed = parseOpenCodeQualifiedModelRef(modelId);
  return parsed && parsed.raw.split('/').every((segment) => segment.length > 0) ? parsed : null;
}

export function qualifyModelId(providerId: string, modelId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (
    !normalizedProviderId ||
    !normalizedModelId ||
    normalizedModelId !== modelId ||
    /\s/.test(normalizedModelId)
  ) {
    return '';
  }
  if (normalizedModelId.includes('/')) {
    const parsed = parseStrictQualifiedModelRef(normalizedModelId);
    if (!parsed) {
      return '';
    }
    return parsed.sourceId === normalizedProviderId ? parsed.raw : '';
  }
  const parsed = parseStrictQualifiedModelRef(`${normalizedProviderId}/${normalizedModelId}`);
  return parsed?.sourceId === normalizedProviderId ? parsed.raw : '';
}
