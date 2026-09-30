import type {
  TeamRosterCachePort,
  TeamRosterLifecyclePort,
  TeamRosterLoggerPort,
  TeamRosterMessagingPort,
  TeamRosterMetadataPort,
  TeamRosterMutationRepositoryPort,
  TeamRosterRuntimePort,
} from './ports/TeamRosterMutationPorts';
import type { LiveRosterRollback } from './services/LiveRosterRollback';

export interface TeamRosterMutationDependencies {
  repository: TeamRosterMutationRepositoryPort;
  metadata: TeamRosterMetadataPort;
  lifecycle: TeamRosterLifecyclePort;
  runtime: TeamRosterRuntimePort;
  messaging: TeamRosterMessagingPort;
  cache: TeamRosterCachePort;
  rollback: LiveRosterRollback;
  logger: TeamRosterLoggerPort;
}

export async function readMetadataBestEffort(
  metadata: TeamRosterMetadataPort,
  teamName: string
): Promise<Awaited<ReturnType<TeamRosterMetadataPort['getSnapshot']>>> {
  return metadata.getSnapshot(teamName).catch(() => null);
}
