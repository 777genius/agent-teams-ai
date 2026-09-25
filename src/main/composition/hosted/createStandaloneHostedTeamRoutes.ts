import { HostedTaskBoardOrchestratorAuthority } from './hostedTaskBoardOrchestratorAuthority';
import { createHostedTaskBoardReadRouteFactory } from './hostedTaskBoardReadComposition';
import { createHostedTeamMessageRouteFactory } from './hostedTeamMessageComposition';
import { HostedTeamMessageOrchestratorAuthority } from './hostedTeamMessageOrchestratorAuthority';

import type { HostedExternalWriterInventorySupervisor } from './hostedExternalWriterInventorySupervisor';
import type { TeamLifecycleCommandComposition } from './teamLifecycleCommandComposition';

type RouteDependencies = Parameters<typeof createHostedTeamMessageRouteFactory>[0];
type OwnerProofKey = ConstructorParameters<
  typeof HostedTeamMessageOrchestratorAuthority
>[0]['ownerProofKey'];

export function createStandaloneHostedTeamRoutes(options: {
  readonly dependencies: RouteDependencies | null;
  readonly lifecycleCommands: TeamLifecycleCommandComposition | null;
  readonly currentLifecycleCommands: () => TeamLifecycleCommandComposition | null;
  readonly ownerProofKey: OwnerProofKey | null;
  readonly restoreGeneration: number;
  readonly externalWriterSupervisor: () => HostedExternalWriterInventorySupervisor | null;
  readonly reportReadDiagnostic: (stage: string, code: string) => void;
  readonly reportOwnerExchangeDiagnostic?: (operation: string, stage: string) => void;
}) {
  const { dependencies, lifecycleCommands, ownerProofKey } = options;
  const writer =
    lifecycleCommands === null || ownerProofKey === null || dependencies === null
      ? null
      : new HostedTeamMessageOrchestratorAuthority({
          lease: lifecycleCommands.mutationLease,
          ownerProofKey,
          mountBinding: dependencies.mountBinding,
          teamIdentities: dependencies.teamIdentities,
          restoreGeneration: options.restoreGeneration,
          ...(options.reportOwnerExchangeDiagnostic === undefined
            ? {}
            : { reportDiagnostic: options.reportOwnerExchangeDiagnostic }),
        });
  const createTeamMessageRoutes =
    dependencies === null
      ? null
      : createHostedTeamMessageRouteFactory({
          ...dependencies,
          ...(writer === null ? {} : { writer }),
          ...(lifecycleCommands === null || ownerProofKey === null
            ? {}
            : {
                ownerProvenance: {
                  ownerProofKey,
                  currentOwnerBinding: () =>
                    options.currentLifecycleCommands()?.mutationLease.currentBinding() ?? null,
                },
              }),
        });
  const createTaskBoardReadRoutes =
    dependencies === null
      ? null
      : createHostedTaskBoardReadRouteFactory({
          runtimeInstance: dependencies.runtimeInstance,
          mountBinding: dependencies.mountBinding,
          teamIdentities: dependencies.teamIdentities,
          reportReadDiagnostic: options.reportReadDiagnostic,
          ...(writer === null
            ? {}
            : {
                mutationAuthority: new HostedTaskBoardOrchestratorAuthority(writer, {
                  beginTaskSelfWrite: (operationId, teamId) => {
                    const supervisor = options.externalWriterSupervisor();
                    if (!supervisor) {
                      return Promise.reject(
                        new Error('hosted-external-writer-self-write-unavailable')
                      );
                    }
                    return supervisor.beginTaskSelfWrite(operationId, teamId);
                  },
                  completeTaskSelfWrite: (operationId, effects) => {
                    const supervisor = options.externalWriterSupervisor();
                    if (!supervisor) {
                      return Promise.reject(
                        new Error('hosted-external-writer-self-write-unavailable')
                      );
                    }
                    return supervisor.completeTaskSelfWrite(operationId, effects);
                  },
                  abortTaskSelfWrite: (operationId) =>
                    options.externalWriterSupervisor()?.abortTaskSelfWrite(operationId) ??
                    Promise.resolve(),
                }),
              }),
        });
  return { writer, createTeamMessageRoutes, createTaskBoardReadRoutes };
}
