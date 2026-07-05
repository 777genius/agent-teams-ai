import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { clearOpenCodeRuntimeLaneStorage } from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { RuntimeAdapterCancellationPorts } from './TeamProvisioningRuntimeAdapterCancellation';
import type { TeamChangeEvent } from '@shared/types';

export type TeamProvisioningRuntimeAdapterCancellationPortsFactoryDeps = Omit<
  RuntimeAdapterCancellationPorts,
  'clearOpenCodeRuntimeLaneStorage' | 'emitTeamChange' | 'teamsBasePath'
> & {
  emitTeamChange?: (event: TeamChangeEvent) => void;
};

export function createTeamProvisioningRuntimeAdapterCancellationPorts(
  deps: TeamProvisioningRuntimeAdapterCancellationPortsFactoryDeps
): RuntimeAdapterCancellationPorts {
  return {
    cancelledRuntimeAdapterRunIds: deps.cancelledRuntimeAdapterRunIds,
    runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
    provisioningRunByTeam: deps.provisioningRunByTeam,
    aliveRunByTeam: deps.aliveRunByTeam,
    teamsBasePath: getTeamsBasePath(),
    nowIso: deps.nowIso,
    clearOpenCodeRuntimeToolApprovals: deps.clearOpenCodeRuntimeToolApprovals,
    deleteAliveRunId: deps.deleteAliveRunId,
    invalidateRuntimeSnapshotCaches: deps.invalidateRuntimeSnapshotCaches,
    setRuntimeAdapterProgress: deps.setRuntimeAdapterProgress,
    emitTeamChange: (event) => deps.emitTeamChange?.(event),
    readLaunchState: deps.readLaunchState,
    getOpenCodeRuntimeAdapter: deps.getOpenCodeRuntimeAdapter,
    readPersistedTeamProjectPath: deps.readPersistedTeamProjectPath,
    clearOpenCodeRuntimeLaneStorage,
    logWarning: deps.logWarning,
  };
}
