import {
  applyProjectDirectoryLeaseAtProviderBoundaryWithLease,
  projectDirectoryLeaseForRequest,
} from './TeamProvisioningProjectDirectoryLease';

import type { SpawnOptions } from 'child_process';

export async function resolveProviderDiagnosticsSpawnOptions(
  cwd: string,
  options: SpawnOptions,
  fallbackCwd = cwd
): Promise<SpawnOptions> {
  const lease = projectDirectoryLeaseForRequest({ cwd });
  return lease
    ? applyProjectDirectoryLeaseAtProviderBoundaryWithLease(lease, cwd, options)
    : { ...options, cwd: fallbackCwd };
}
