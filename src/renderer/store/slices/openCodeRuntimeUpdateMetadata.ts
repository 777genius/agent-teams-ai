import type { OpenCodeRuntimeStatus } from '@shared/types';

export function preserveOpenCodeRuntimeUpdateMetadata(
  status: OpenCodeRuntimeStatus | null
): Pick<OpenCodeRuntimeStatus, 'latestVersion' | 'updateAvailable'> {
  return {
    ...(status?.latestVersion ? { latestVersion: status.latestVersion } : {}),
    ...(status?.updateAvailable ? { updateAvailable: true } : {}),
  };
}
