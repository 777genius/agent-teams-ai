import {
  classifyNativeVersion,
  getLatestQualifiedOpenCodeV2Version,
} from '@features/opencode-compatibility';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { isVersionOlder } from '@shared/utils/version';

import { fetchOpenCodePackageMetadata } from './openCodeRuntimePackageMetadata';

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

export async function resolveLatestOpenCodeVersion(installedVersion?: string): Promise<string> {
  if (installedVersion?.startsWith('2.')) {
    const qualified = getLatestQualifiedOpenCodeV2Version(process.platform, process.arch);
    if (!qualified) throw new Error('No compatible OpenCode V2 is qualified for this platform');
    return qualified;
  }
  const metadata = await fetchOpenCodePackageMetadata('opencode-ai', 'latest', 3_000);
  const classification = classifyNativeVersion(metadata.version!);
  if (classification.kind !== 'recognized' || classification.generation !== 'v1')
    throw new Error('No compatible stable OpenCode V1 update is available');
  return metadata.version!;
}
