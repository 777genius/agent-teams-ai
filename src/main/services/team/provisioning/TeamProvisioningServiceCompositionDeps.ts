import type { TeamConfigReader } from '../TeamConfigReader';
import type { TeamInboxReader } from '../TeamInboxReader';
import type { TeamLaunchStateStore } from '../TeamLaunchStateStore';
import type { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import type { TeamProvisioningCancellationBoundary } from './TeamProvisioningCancellationBoundary';
import type { TeamProvisioningCompatibilityDelegation } from './TeamProvisioningCompatibilityFacade';
import type { PersistedTeamConfigCacheEntry } from './TeamProvisioningPersistedTeamConfigAccess';
import type { TeamProvisioningRetainedProgressState } from './TeamProvisioningProgressState';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { TeamProvisioningSendMessageToRunBoundary } from './TeamProvisioningSendMessageToRunBoundaryFactory';
import type { spawn } from 'child_process';

export interface TeamProvisioningServiceCompositionDeps {
  configReader: TeamConfigReader;
  inboxReader: TeamInboxReader;
  membersMetaStore: TeamMembersMetaStore;
  launchStateStore: TeamLaunchStateStore;
  persistedTeamConfigCache: Map<string, PersistedTeamConfigCacheEntry>;
  retainedProvisioningProgressState: TeamProvisioningRetainedProgressState;
  cancellationBoundary: TeamProvisioningCancellationBoundary;
  runTracking: TeamProvisioningCompatibilityDelegation<ProvisioningRun>['runTracking'];
  runs: ReadonlyMap<string, ProvisioningRun>;
  sendMessageToRunBoundary: TeamProvisioningSendMessageToRunBoundary<ProvisioningRun>;
  transientProbeProcesses: Set<ReturnType<typeof spawn>>;
}
