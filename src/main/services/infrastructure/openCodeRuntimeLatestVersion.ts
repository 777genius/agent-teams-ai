import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { isVersionOlder } from '@shared/utils/version';

import type { OpenCodeRuntimeStatus } from '@shared/types';

const logger = createLogger('OpenCodeRuntimeInstallerService');

export async function withLatestOpenCodeVersion(
  status: OpenCodeRuntimeStatus,
  resolveLatestVersion: () => Promise<string>,
  knownLatestVersion?: string | null
): Promise<OpenCodeRuntimeStatus> {
  try {
    const latestVersion = await resolveLatestVersion();
    return {
      ...status,
      latestVersion,
      updateAvailable: Boolean(status.version && isVersionOlder(status.version, latestVersion)),
    };
  } catch (error) {
    logger.warn('Failed to resolve latest OpenCode version:', getErrorMessage(error));
    return preserveKnownOpenCodeUpdate(status, knownLatestVersion) ?? status;
  }
}

export function preserveKnownOpenCodeUpdate(
  status: OpenCodeRuntimeStatus | null,
  knownLatestVersion: string | null | undefined
): OpenCodeRuntimeStatus | null {
  if (!status || !knownLatestVersion) return status;
  return {
    ...status,
    latestVersion: knownLatestVersion,
    updateAvailable: Boolean(status.version && isVersionOlder(status.version, knownLatestVersion)),
  };
}
