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
  lifecycle: ManageTeamRuntimeLifecycle;
  killProcess: KillTeamProcess;
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
  return {
    logs: new ReadTeamRuntimeLogs(dependencies.logs, worker, dependencies.logger),
    diagnostics: new ReadTeamRuntimeDiagnostics(
      dependencies.runtime,
      dependencies.diagnostics,
      dependencies.lifecycle
    ),
    lifecycle: lifecycleUseCase,
    killProcess: new KillTeamProcess(
      dependencies.processes,
      dependencies.runtime,
      dependencies.messaging,
      dependencies.logger
    ),
    logger: dependencies.logger,
  };
}
