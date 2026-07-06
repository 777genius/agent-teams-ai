import type { TeamProvisioningMemberLifecycleOperationRunner } from './TeamProvisioningMemberLifecycleOperationRunner';

export interface TeamProvisioningMemberLifecycleOperationUseCasePorts {
  operationRunner: Pick<
    TeamProvisioningMemberLifecycleOperationRunner,
    'isMemberLifecycleOperationActive' | 'runMemberLifecycleOperation'
  >;
}

export interface TeamProvisioningMemberLifecycleOperationUseCases {
  isMemberLifecycleOperationActive: TeamProvisioningMemberLifecycleOperationRunner['isMemberLifecycleOperationActive'];
  runMemberLifecycleOperation: TeamProvisioningMemberLifecycleOperationRunner['runMemberLifecycleOperation'];
}

export function createTeamProvisioningMemberLifecycleOperationUseCases(
  ports: TeamProvisioningMemberLifecycleOperationUseCasePorts
): TeamProvisioningMemberLifecycleOperationUseCases {
  return {
    isMemberLifecycleOperationActive: (teamName, memberName) =>
      ports.operationRunner.isMemberLifecycleOperationActive(teamName, memberName),
    runMemberLifecycleOperation: (teamName, memberName, kind, operation) =>
      ports.operationRunner.runMemberLifecycleOperation(teamName, memberName, kind, operation),
  };
}
