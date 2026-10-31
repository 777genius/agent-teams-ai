import {
  findOpenCodeModelsBlockedOnV2,
  getOpenCodeGeneration,
  OPENCODE_MODEL_NOT_IN_V2_CATALOG_CODE,
  readLoadedOpenCodeV2Catalog,
} from '@features/runtime-provider-management';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { CliProviderStatus, TeamProvisioningPrepareIssue } from '@shared/types';

/**
 * OpenCode V2 runs only models it can read, and the deep check would start a V2 server for a
 * model it cannot. Blocks the selected models that V2 provably cannot run (see
 * findOpenCodeModelsBlockedOnV2) and returns the rest, which still go to strict deep
 * verification. The status is the fresh model_only read for this project folder; a V1 passive
 * status carries no catalog, so it keeps the previous deferral without a runtime version read.
 */
export async function blockOpenCodeModelsNotRunnableOnV2(input: {
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
  const catalog = readLoadedOpenCodeV2Catalog(input.provider);
  if (!catalog || !input.readOpenCodeRuntimeStatus) return input.modelIds;
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
  const blocked = findOpenCodeModelsBlockedOnV2({
    generation: getOpenCodeGeneration(version),
    catalog,
    modelIds: input.modelIds,
  });
  if (blocked.length === 0) return input.modelIds;
  for (const { modelId, reason, message } of blocked) {
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
  input.appendPreflightDebugLog('opencode_compatibility_batch_v2_models_blocked', {
    cwd: input.cwd,
    modelIds: blocked.map((entry) => entry.modelId),
  });
  const blockedIds = new Set(blocked.map((entry) => entry.modelId));
  return input.modelIds.filter((modelId) => !blockedIds.has(modelId));
}
