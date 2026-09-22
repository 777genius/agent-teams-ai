export const DEFAULT_PROVIDER_MODEL_SELECTION = '__provider_default__';

export function isDefaultProviderModelSelection(value: string | undefined): boolean {
  return value?.trim() === DEFAULT_PROVIDER_MODEL_SELECTION;
}
