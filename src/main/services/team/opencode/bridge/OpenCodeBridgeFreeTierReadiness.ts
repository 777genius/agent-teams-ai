import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { hasExplicitFreeOpenCodeModelId } from '@shared/utils/opencodeModelRoute';
import {
  isOpenCodeFreeTierVersionOutdated,
  MINIMUM_OPENCODE_FREE_TIER_VERSION,
} from '@shared/utils/version';

import {
  buildOpenCodeFreeTierVersionMessage,
  formatOpenCodeFreeTierVersionFailure,
} from '../readiness/OpenCodeFailureDiagnostics';

export interface OpenCodeFreeTierRuntimeStatus {
  installed: boolean;
  version?: string;
  binaryOverrideEnvName?: string;
}

export async function getKnownOpenCodeFreeTierVersionFailure(
  modelId: string | null,
  readRuntimeStatus?: () => Promise<OpenCodeFreeTierRuntimeStatus>
): Promise<{ failure: string | null; runtimeStatus: OpenCodeFreeTierRuntimeStatus | null }> {
  if (
    !modelId ||
    parseOpenCodeQualifiedModelRef(modelId)?.sourceId !== 'opencode' ||
    !hasExplicitFreeOpenCodeModelId(modelId) ||
    !readRuntimeStatus
  ) {
    return { failure: null, runtimeStatus: null };
  }
  const status = await readRuntimeStatus().catch(() => null);
  return {
    failure:
      status?.installed && isOpenCodeFreeTierVersionOutdated(status.version)
        ? buildOpenCodeFreeTierVersionMessage(
            MINIMUM_OPENCODE_FREE_TIER_VERSION,
            status.version,
            status.binaryOverrideEnvName
          )
        : null,
    runtimeStatus: status,
  };
}

export function findOpenCodeFreeTierVersionFailure(
  diagnostics: readonly string[],
  installedVersion?: string | null,
  binaryOverrideEnvName?: string
): string | null {
  return (
    diagnostics
      .map((diagnostic) =>
        formatOpenCodeFreeTierVersionFailure(diagnostic, installedVersion, binaryOverrideEnvName)
      )
      .find((diagnostic) => diagnostic !== null) ?? null
  );
}
