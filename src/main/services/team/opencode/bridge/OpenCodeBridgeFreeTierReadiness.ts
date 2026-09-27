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

export async function getKnownOpenCodeFreeTierVersionFailure(
  modelId: string | null,
  readRuntimeStatus?: () => Promise<{ installed: boolean; version?: string }>
): Promise<string | null> {
  if (
    !modelId ||
    parseOpenCodeQualifiedModelRef(modelId)?.sourceId !== 'opencode' ||
    !hasExplicitFreeOpenCodeModelId(modelId) ||
    !readRuntimeStatus
  ) {
    return null;
  }
  const status = await readRuntimeStatus().catch(() => null);
  return status?.installed && isOpenCodeFreeTierVersionOutdated(status.version)
    ? buildOpenCodeFreeTierVersionMessage(MINIMUM_OPENCODE_FREE_TIER_VERSION, status.version)
    : null;
}

export function findOpenCodeFreeTierVersionFailure(
  diagnostics: readonly string[],
  installedVersion?: string | null
): string | null {
  return (
    diagnostics
      .map((diagnostic) => formatOpenCodeFreeTierVersionFailure(diagnostic, installedVersion))
      .find((diagnostic) => diagnostic !== null) ?? null
  );
}
