import { type PersistOpenCodeRuntimeAdapterLaunchResultPorts } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';
import { type OpenCodeRuntimeBootstrapEvidencePorts } from './TeamProvisioningOpenCodeBootstrapEvidence';

export interface TeamProvisioningOpenCodeLaunchPersistenceServiceHost {
  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
  writeLaunchStateSnapshot: PersistOpenCodeRuntimeAdapterLaunchResultPorts['writeLaunchStateSnapshot'];
}

export interface TeamProvisioningOpenCodeLaunchPersistencePortsFactoryDeps {
  nowIso: PersistOpenCodeRuntimeAdapterLaunchResultPorts['nowIso'];
}

export function createTeamProvisioningOpenCodeLaunchPersistencePortsFromService(
  service: TeamProvisioningOpenCodeLaunchPersistenceServiceHost,
  deps: TeamProvisioningOpenCodeLaunchPersistencePortsFactoryDeps
): PersistOpenCodeRuntimeAdapterLaunchResultPorts {
  return {
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      service.createOpenCodeRuntimeBootstrapEvidencePorts(),
    nowIso: deps.nowIso,
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      service.writeLaunchStateSnapshot(teamName, snapshot),
  };
}
