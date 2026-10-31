import {
  findOpenCodeModelsNotInV2Catalog,
  getOpenCodeGeneration,
  OPENCODE_MODEL_NOT_IN_V2_CATALOG_CODE,
} from '@features/runtime-provider-management';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { CliProviderStatus, TeamProvisioningPrepareIssue } from '@shared/types';

/**
 * OpenCode V2 runs only models from its own catalog, and the deep check would start a V2
 * server for a model it cannot read. Blocks the selected models that a loaded V2 catalog does
 * not list and returns the rest, which still go to strict deep verification. V1 passive status
 * carries no catalog, so it keeps the previous deferral without reading the runtime version.
 */
export async function blockOpenCodeModelsNotInV2Catalog(input: {
  provider: CliProviderStatus;
  modelIds: readonly string[];
  cwd: string;
  readOpenCodeRuntimeStatus?: () => Promise<{ version?: string }>;
  appendPreflightDebugLog: (event: string, data: Record<string, unknown>) => void;
  result: {
    details: string[];
    blockingMessages: string[];
    issues: TeamProvisioningPrepareIssue[];
  };
}): Promise<readonly string[]> {
  if (!input.provider.modelCatalog?.models.length || !input.readOpenCodeRuntimeStatus) {
    return input.modelIds;
  }
  let version: string | undefined;
  try {
    version = (await input.readOpenCodeRuntimeStatus()).version;
  } catch (error) {
    input.appendPreflightDebugLog('opencode_compatibility_runtime_version_unavailable', {
      cwd: input.cwd,
      error: getErrorMessage(error),
    });
    return input.modelIds;
  }
  const missing = findOpenCodeModelsNotInV2Catalog({
    generation: getOpenCodeGeneration(version),
    providerStatus: input.provider,
    modelIds: input.modelIds,
  });
  if (missing.length === 0) return input.modelIds;
  for (const { modelId, reason, message } of missing) {
    input.result.details.push(message);
    input.result.blockingMessages.push(message);
    input.result.issues.push({
      providerId: 'opencode',
      modelId,
      scope: 'model',
      severity: 'blocking',
      code: OPENCODE_MODEL_NOT_IN_V2_CATALOG_CODE,
      message: reason,
    });
  }
  input.appendPreflightDebugLog('opencode_compatibility_batch_v2_catalog_blocked', {
    cwd: input.cwd,
    modelIds: missing.map((entry) => entry.modelId),
  });
  const blocked = new Set(missing.map((entry) => entry.modelId));
  return input.modelIds.filter((modelId) => !blocked.has(modelId));
}
