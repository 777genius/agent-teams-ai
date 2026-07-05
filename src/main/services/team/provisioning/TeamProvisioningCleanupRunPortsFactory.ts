import {
  buildIncompleteLaunchCleanupReason,
  shouldFinalizeIncompleteLaunchState,
  type TeamProvisioningCleanupPorts,
  type TeamProvisioningCleanupRun,
} from './TeamProvisioningCleanup';
import {
  buildRetainedClaudeLogsSnapshot,
  type RetainedLogsRunLike,
} from './TeamProvisioningRetainedLogs';

export type TeamProvisioningCleanupRunPortsFactoryRun = TeamProvisioningCleanupRun &
  RetainedLogsRunLike;

export type TeamProvisioningCleanupRunPortsFactoryDeps<
  TRun extends TeamProvisioningCleanupRunPortsFactoryRun,
> = Omit<
  TeamProvisioningCleanupPorts<TRun>,
  | 'buildRetainedClaudeLogsSnapshot'
  | 'shouldFinalizeIncompleteLaunchState'
  | 'buildIncompleteLaunchCleanupReason'
>;

export function createTeamProvisioningCleanupRunPorts<
  TRun extends TeamProvisioningCleanupRunPortsFactoryRun,
>(deps: TeamProvisioningCleanupRunPortsFactoryDeps<TRun>): TeamProvisioningCleanupPorts<TRun> {
  return {
    ...deps,
    buildRetainedClaudeLogsSnapshot,
    shouldFinalizeIncompleteLaunchState,
    buildIncompleteLaunchCleanupReason,
  };
}
