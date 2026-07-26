import { GetRuntimeSnapshotUseCase } from '../../core/application/queries/GetRuntimeSnapshotUseCase';
import { LegacyRuntimeSnapshotReaderAdapter } from '../adapters/output/LegacyRuntimeSnapshotReaderAdapter';

import type { TeamProvisioningRuntimeSnapshotApi } from '../../contracts/runtime-snapshot';
import type { LegacyRuntimeSnapshotSource } from '../adapters/output/LegacyRuntimeSnapshotReaderAdapter';

export interface TeamProvisioningRuntimeSnapshotFeatureDeps {
  snapshotSource: LegacyRuntimeSnapshotSource;
}

export function createTeamProvisioningRuntimeSnapshotFeature(
  deps: TeamProvisioningRuntimeSnapshotFeatureDeps
): TeamProvisioningRuntimeSnapshotApi {
  const runtimeSnapshotReader = new LegacyRuntimeSnapshotReaderAdapter(deps);
  const getRuntimeSnapshot = new GetRuntimeSnapshotUseCase(runtimeSnapshotReader);

  return {
    getTeamAgentRuntimeSnapshot: (teamName) => getRuntimeSnapshot.execute({ teamName }),
  };
}
