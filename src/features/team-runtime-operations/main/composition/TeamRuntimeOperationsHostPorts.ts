import type {
  TeamMemberSpawnStatusPort,
  TeamRuntimeDiagnosticsPort,
  TeamRuntimeEffectsPort,
  TeamRuntimeFeedPort,
  TeamRuntimeLifecycleCommandPort,
  TeamRuntimeLivenessPort,
  TeamRuntimeLoggerPort,
  TeamRuntimeLogsPort,
  TeamRuntimeMessagingPort,
  TeamRuntimeProcessPort,
  TeamRuntimeStatusPort,
  TeamRuntimeStopPort,
  TeamTaskLogWorkerPort,
} from '../../core/application/ports/TeamRuntimeOperationPorts';

export interface TeamRuntimeOperationsHostPorts {
  logs: TeamRuntimeLogsPort;
  runtime: TeamRuntimeStatusPort & TeamRuntimeStopPort & TeamRuntimeLivenessPort;
  lifecycle: TeamMemberSpawnStatusPort & TeamRuntimeLifecycleCommandPort;
  diagnostics: TeamRuntimeDiagnosticsPort;
  feed: TeamRuntimeFeedPort;
  processes: TeamRuntimeProcessPort;
  messaging: TeamRuntimeMessagingPort;
  logger: TeamRuntimeLoggerPort;
  worker?: TeamTaskLogWorkerPort;
  effects?: TeamRuntimeEffectsPort;
}
