import { getLatestQualifiedOpenCodeV2Version } from '@features/opencode-compatibility';
import { chooseOpenCodeInstallGeneration } from '@features/opencode-runtime-installer';
import { selectOpenCodeRootPackage } from '@features/opencode-runtime-installer/main';
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

/** Offer the same CLI release as installation, not the separate V2 engine version. */
export async function resolveLatestOpenCodeVersion(installedVersion?: string): Promise<string> {
  const qualifiedV2Version = getLatestQualifiedOpenCodeV2Version(process.platform, process.arch);
  const generation = chooseOpenCodeInstallGeneration(undefined, installedVersion, qualifiedV2Version);
  const metadata = await selectOpenCodeRootPackage(
    generation,
    qualifiedV2Version,
    (name, version) => fetchOpenCodePackageMetadata(name, version, 3_000)
  );
  return metadata.version;
}
