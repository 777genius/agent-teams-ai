import { openCodeManagedPreferencesSchema } from '@agent-teams/legacy-agent-host/runtime-sources';

import { resolveManagedPreferences } from '../../core/domain/managedProviderPreferences';
import { FileManagedProviderPreferences } from '../infrastructure/FileManagedProviderPreferences';

import type { ManagedPreferencePaths } from '../infrastructure/FileManagedProviderPreferences';
import type { OpenCodeManagedPreferences } from '@agent-teams/legacy-agent-host/runtime-sources';

/** Read through the sole existing preference owner before a new captured source publication. */
export async function captureManagedProviderRuntimePreferences(
  paths: ManagedPreferencePaths,
  isCurrent: () => boolean
): Promise<OpenCodeManagedPreferences> {
  const store = await FileManagedProviderPreferences.capture(paths, isCurrent);
  const saved = await store.read();
  if (!isCurrent()) throw new Error('Provider preferences context changed');
  const resolved = resolveManagedPreferences(saved.project, saved.global, null);
  return openCodeManagedPreferencesSchema.parse({
    defaultModelId: resolved.defaultModel,
    modelLimitOverrides: Object.fromEntries(Object.entries(resolved.modelLimitOverrides).map(
      ([modelId, { contextTokens, outputTokens }]) => [modelId, { contextTokens, outputTokens }]
    )),
  });
}
