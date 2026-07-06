import type { TeamProvisioningMemberLifecycleOperationRunner } from './TeamProvisioningMemberLifecycleOperationRunner';

export interface TeamProvisioningMemberLifecycleOperationUseCasePorts {
  operationRunner: Pick<
    TeamProvisioningMemberLifecycleOperationRunner,
    'runMemberLifecycleOperation'
  >;
}

export interface TeamProvisioningMemberLifecycleOperationUseCases {
  runMemberLifecycleOperation: TeamProvisioningMemberLifecycleOperationRunner['runMemberLifecycleOperation'];
}

export function createTeamProvisioningMemberLifecycleOperationUseCases(
  ports: TeamProvisioningMemberLifecycleOperationUseCasePorts
): TeamProvisioningMemberLifecycleOperationUseCases {
  return {
    runMemberLifecycleOperation: (teamName, memberName, kind, operation) =>
      ports.operationRunner.runMemberLifecycleOperation(teamName, memberName, kind, operation),
  };
}
