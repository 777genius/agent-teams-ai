import { KillTeamProcess } from '../../core/application/use-cases/KillTeamProcess';
import { ManageTeamRuntimeLifecycle } from '../../core/application/use-cases/ManageTeamRuntimeLifecycle';
import { ReadTeamRuntimeDiagnostics } from '../../core/application/use-cases/ReadTeamRuntimeDiagnostics';
import { ReadTeamRuntimeLogs } from '../../core/application/use-cases/ReadTeamRuntimeLogs';
import { MainTeamRuntimeEffects } from '../adapters/output/MainTeamRuntimeEffects';
import { MainTeamTaskLogWorker } from '../adapters/output/MainTeamTaskLogWorker';

import type { TeamRuntimeLoggerPort } from '../../core/application/ports/TeamRuntimeOperationPorts';
import type { TeamRuntimeOperationsHostPorts } from './TeamRuntimeOperationsHostPorts';

export interface TeamRuntimeOperationsFeature {
  logs: ReadTeamRuntimeLogs;
  diagnostics: ReadTeamRuntimeDiagnostics;
  lifecycle: Pick<
    ManageTeamRuntimeLifecycle,
    | 'restartMember'
    | 'retryFailedRuntimeLanes'
    | 'skipMemberForLaunch'
    | 'stopTeam'
    | 'forceStopTeam'
  >;
  killProcess: Pick<KillTeamProcess, 'execute'>;
  logger: TeamRuntimeLoggerPort;
}

export function createTeamRuntimeOperationsFeature(
  dependencies: TeamRuntimeOperationsHostPorts
): TeamRuntimeOperationsFeature {
  const worker = dependencies.worker ?? new MainTeamTaskLogWorker();
  const effects = dependencies.effects ?? new MainTeamRuntimeEffects();
  const lifecycleUseCase = new ManageTeamRuntimeLifecycle(
    dependencies.lifecycle,
    dependencies.runtime,
    dependencies.feed,
    effects
  );
  const killProcess = new KillTeamProcess(
    dependencies.processes,
    dependencies.runtime,
    dependencies.messaging,
    dependencies.logger
  );
  const workflow = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterWorkflow?.(teamName, operation) ?? operation();
  return {
    logs: new ReadTeamRuntimeLogs(dependencies.logs, worker, dependencies.logger),
    diagnostics: new ReadTeamRuntimeDiagnostics(
      dependencies.runtime,
      dependencies.diagnostics,
      dependencies.lifecycle
    ),
    lifecycle: {
      restartMember: (teamName, memberName, expectedSecondary) =>
        workflow(teamName, () =>
          lifecycleUseCase.restartMember(teamName, memberName, expectedSecondary)
        ),
      retryFailedRuntimeLanes: (teamName) =>
        workflow(teamName, () => lifecycleUseCase.retryFailedRuntimeLanes(teamName)),
      skipMemberForLaunch: (teamName, memberName) =>
        workflow(teamName, () => lifecycleUseCase.skipMemberForLaunch(teamName, memberName)),
      stopTeam: (teamName) => workflow(teamName, () => lifecycleUseCase.stopTeam(teamName)),
      forceStopTeam: (teamName) =>
        workflow(teamName, () => lifecycleUseCase.forceStopTeam(teamName)),
    },
    killProcess: {
      execute: (teamName, pid) => workflow(teamName, () => killProcess.execute(teamName, pid)),
    },
    logger: dependencies.logger,
  };
}
