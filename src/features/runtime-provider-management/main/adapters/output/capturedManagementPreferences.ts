import {
  emptyManagedPreferences,
  resolveManagedPreferences,
  validManagedModelId,
} from '../../../core/domain/managedProviderPreferences';
import { FileManagedProviderPreferences } from '../../infrastructure/FileManagedProviderPreferences';

import { managementValue } from './capturedManagementCatalog';

import type { RuntimeProviderModelDto } from '../../../contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

export function nativeDefaultModel(raw: unknown): string | null {
  const catalog = managementValue(raw);
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog))
    throw new Error('Provider catalog unavailable');
  const value = (catalog as Record<string, unknown>).configuredDefaultModelId;
  if (value === undefined || value === null) return null;
  if (!validManagedModelId(value)) throw new Error('Native default model is invalid');
  return value;
}
export async function selectedPreferences(
  target: CapturedProviderManagement,
  nativeDefault: string | null
) {
  if (!target.isCurrent()) throw new Error('Provider preferences context changed');
  if (!target.preferences)
    return {
      store: null,
      resolved: resolveManagedPreferences(null, emptyManagedPreferences(), nativeDefault),
    };
  const store = await FileManagedProviderPreferences.capture(target.preferences, () =>
    target.isCurrent()
  );
  const saved = await store.read();
  if (!target.isCurrent()) throw new Error('Provider preferences context changed');
  return { store, resolved: resolveManagedPreferences(saved.project, saved.global, nativeDefault) };
}
export function preferenceModelRows(
  rows: RuntimeProviderModelDto[],
  resolved: ReturnType<typeof resolveManagedPreferences>
): RuntimeProviderModelDto[] {
  return rows.map((row) => {
    const override = resolved.modelLimitOverrides[row.modelId];
    return {
      ...row,
      default: row.modelId === resolved.defaultModel,
      ...(override
        ? {
            managedContextTokens: override.contextTokens,
            managedOutputTokens: override.outputTokens,
            managedUpdatedAt: override.updatedAt,
          }
        : {}),
    };
  });
}
