import {
  createTeamRuntimeObservationSlice,
  TeamRuntimeFreshnessCoordinator,
  type TeamRuntimeObservationSlice,
  type TeamRuntimeObservationStatePort,
} from '@features/team-provisioning/renderer';
import {
  defaultTeamMessageFeedCoordinator,
  defaultTeamViewDataCoordinator,
} from '@features/team-view-read-model/renderer';

import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
  resetContextScopedRequestEpochForTests,
} from '../utils/contextScopedRequestEpoch';

import { areTeamAgentRuntimeSnapshotsEqual } from './teamAgentRuntimeSnapshotEquality';
import { stabilizeTeamAgentRuntimeSnapshot } from './teamAgentRuntimeSnapshotStabilizer';
import {
  clearAllLastResolvedTeamDataRefreshes,
  clearLastResolvedTeamDataRefreshAt,
  hasLastResolvedTeamDataRefreshAt,
} from './teamDataRefreshTimestamps';
import { resetGlobalTaskNotificationTrackerForTests } from './teamGlobalTaskNotifications';
import {
  captureTeamLocalStateEpoch,
  clearAllTeamLocalStateEpochs,
  hasTeamLocalStateEpoch,
  isTeamLocalStateEpochCurrent,
} from './teamLocalStateEpoch';
import { areMemberSpawnSnapshotsSemanticallyEqual } from './teamMemberSpawnSnapshotEquality';
import {
  clearAllMemberSpawnStatusesIpcBackoffs,
  clearMemberSpawnStatusesIpcBackoff,
  hasMemberSpawnStatusesIpcBackoff,
  isMemberSpawnStatusesIpcBackoffActive,
  recordMemberSpawnStatusesIpcRetryBackoff,
} from './teamMemberSpawnStatusBackoff';
import {
  clearAllMemberSpawnUiEqualLastWarns,
  clearMemberSpawnUiEqualLastWarn,
  hasMemberSpawnUiEqualLastWarn,
  shouldLogMemberSpawnUiEqualSuppressed,
} from './teamMemberSpawnUiEqualWarningThrottle';
import {
  clearTeamMessageSelectorCaches,
  clearTeamMessageSelectorCachesForTeam,
  getTeamMessageSelectorCacheSnapshotForTeam,
} from './teamMessagesCache';
import { clearAllPendingReplyRefreshWaits } from './teamPendingReplyWaits';
import {
  clearAllTeamRefreshBurstDiagnostics,
  clearTeamRefreshBurstDiagnostics,
  hasTeamRefreshBurstDiagnostics,
} from './teamRefreshBurstDiagnostics';
import {
  clearResolvedMemberSelectorCaches,
  clearResolvedMemberSelectorCachesForTeam,
  getResolvedMemberSelectorCacheSnapshotForTeam,
} from './teamResolvedMembers';

const MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS = 5_000;
const MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS = 2_000;

interface ResettableCoordinator {
  reset(): void;
}

interface ActiveContextState {
  activeContextId: string;
}

export interface ContextRequestScope {
  contextId: string;
  contextEpoch: number;
}

export interface TeamRequestScope extends ContextRequestScope {
  teamStateEpoch: number;
}

export interface TeamScopedTransientStateSnapshot {
  hasResolvedMembersSelector: boolean;
  resolvedMemberSelectorCount: number;
  hasMergedMessagesSelector: boolean;
  memberMessagesSelectorCount: number;
  hasPendingFreshTeamDataRefresh: boolean;
  hasQueuedFullTeamDataRefreshAfterThin: boolean;
  hasPostPaintTeamEnrichmentTimer: boolean;
  hasQueuedHeadRefreshAfterOlder: boolean;
  hasPendingFreshMessagesHeadRefresh: boolean;
  hasPendingFreshMemberActivityMetaRefresh: boolean;
  hasLastResolvedTeamDataRefresh: boolean;
  hasCurrentLocalStateEpoch: boolean;
  hasMemberSpawnStatusesIpcBackoff: boolean;
  hasTeamRefreshBurstDiagnostics: boolean;
  hasMemberSpawnUiEqualLastWarn: boolean;
}

interface RuntimeObservationDependencies {
  debug(message: string): void;
  getActiveContextState(): ActiveContextState;
  state: TeamRuntimeObservationStatePort;
}

export class TeamStateLifecycleCoordinator {
  private readonly runtimeFreshness = new TeamRuntimeFreshnessCoordinator(
    areTeamAgentRuntimeSnapshotsEqual
  );

  constructor(private readonly directoryRefreshCoordinator: ResettableCoordinator) {}

  captureContextRequestScope(getState: () => ActiveContextState): ContextRequestScope {
    return {
      contextId: getState().activeContextId,
      contextEpoch: captureContextScopedRequestEpoch(),
    };
  }

  isContextRequestScopeCurrent(
    getState: () => ActiveContextState,
    scope: ContextRequestScope
  ): boolean {
    return (
      getState().activeContextId === scope.contextId &&
      isContextScopedRequestEpochCurrent(scope.contextEpoch)
    );
  }

  captureTeamRequestScope(getState: () => ActiveContextState, teamName: string): TeamRequestScope {
    return {
      ...this.captureContextRequestScope(getState),
      teamStateEpoch: captureTeamLocalStateEpoch(teamName),
    };
  }

  isTeamRequestScopeCurrent(
    getState: () => ActiveContextState,
    teamName: string,
    scope: TeamRequestScope
  ): boolean {
    return (
      this.isContextRequestScopeCurrent(getState, scope) &&
      isTeamLocalStateEpochCurrent(teamName, scope.teamStateEpoch)
    );
  }

  isTeamDataRefreshPending(teamName: string): boolean {
    return defaultTeamViewDataCoordinator.isRefreshPending(teamName);
  }

  clearRuntimeFreshness(teamName: string): void {
    this.runtimeFreshness.clearTeam(teamName);
  }

  clearTeam(teamName: string): void {
    defaultTeamViewDataCoordinator.clearTeam(teamName);
    defaultTeamMessageFeedCoordinator.clearTeam(teamName);
    clearLastResolvedTeamDataRefreshAt(teamName);
    clearMemberSpawnStatusesIpcBackoff(teamName);
    clearTeamRefreshBurstDiagnostics(teamName);
    clearMemberSpawnUiEqualLastWarn(teamName);
    this.runtimeFreshness.clearTeam(teamName);
    clearResolvedMemberSelectorCachesForTeam(teamName);
    clearTeamMessageSelectorCachesForTeam(teamName);
  }

  reset(): void {
    defaultTeamViewDataCoordinator.reset();
    defaultTeamMessageFeedCoordinator.reset();
    this.directoryRefreshCoordinator.reset();
    this.runtimeFreshness.reset();
    clearAllPendingReplyRefreshWaits();
    clearAllLastResolvedTeamDataRefreshes();
    clearAllTeamLocalStateEpochs();
    resetContextScopedRequestEpochForTests();
    clearAllMemberSpawnStatusesIpcBackoffs();
    clearAllTeamRefreshBurstDiagnostics();
    clearAllMemberSpawnUiEqualLastWarns();
    clearResolvedMemberSelectorCaches();
    clearTeamMessageSelectorCaches();
    resetGlobalTaskNotificationTrackerForTests();
  }

  snapshot(teamName: string): TeamScopedTransientStateSnapshot {
    const messageSelectorCache = getTeamMessageSelectorCacheSnapshotForTeam(teamName);
    const resolvedMemberSelectorCache = getResolvedMemberSelectorCacheSnapshotForTeam(teamName);
    const messageFeedCoordinatorSnapshot = defaultTeamMessageFeedCoordinator.snapshot(teamName);
    const viewDataCoordinatorSnapshot = defaultTeamViewDataCoordinator.snapshot(teamName);

    return {
      hasResolvedMembersSelector: resolvedMemberSelectorCache.hasResolvedMembersSelector,
      resolvedMemberSelectorCount: resolvedMemberSelectorCache.resolvedMemberSelectorCount,
      hasMergedMessagesSelector: messageSelectorCache.hasMergedMessagesSelector,
      memberMessagesSelectorCount: messageSelectorCache.memberMessagesSelectorCount,
      hasPendingFreshTeamDataRefresh: viewDataCoordinatorSnapshot.hasPendingFreshTeamDataRefresh,
      hasQueuedFullTeamDataRefreshAfterThin:
        viewDataCoordinatorSnapshot.hasQueuedFullTeamDataRefreshAfterThin,
      hasPostPaintTeamEnrichmentTimer: viewDataCoordinatorSnapshot.hasPostPaintTeamEnrichmentTimer,
      hasQueuedHeadRefreshAfterOlder: messageFeedCoordinatorSnapshot.hasQueuedHeadRefreshAfterOlder,
      hasPendingFreshMessagesHeadRefresh: messageFeedCoordinatorSnapshot.hasPendingFreshHeadRefresh,
      hasPendingFreshMemberActivityMetaRefresh:
        messageFeedCoordinatorSnapshot.hasPendingFreshMemberActivityRefresh,
      hasLastResolvedTeamDataRefresh: hasLastResolvedTeamDataRefreshAt(teamName),
      hasCurrentLocalStateEpoch: hasTeamLocalStateEpoch(teamName),
      hasMemberSpawnStatusesIpcBackoff: hasMemberSpawnStatusesIpcBackoff(teamName),
      hasTeamRefreshBurstDiagnostics: hasTeamRefreshBurstDiagnostics(teamName),
      hasMemberSpawnUiEqualLastWarn: hasMemberSpawnUiEqualLastWarn(teamName),
    };
  }

  createRuntimeObservationSlice(
    dependencies: RuntimeObservationDependencies
  ): TeamRuntimeObservationSlice {
    return createTeamRuntimeObservationSlice<TeamRequestScope>({
      backoff: {
        clearMemberSpawnBackoff: clearMemberSpawnStatusesIpcBackoff,
        isMemberSpawnBackoffActive: isMemberSpawnStatusesIpcBackoffActive,
        recordMissingMemberSpawnHandler: (teamName) =>
          recordMemberSpawnStatusesIpcRetryBackoff(
            teamName,
            MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS
          ),
      },
      memberSpawnPolicy: {
        areSnapshotsEqual: areMemberSpawnSnapshotsSemanticallyEqual,
        recordEquivalentSnapshot: (teamName, runId) => {
          if (
            shouldLogMemberSpawnUiEqualSuppressed(teamName, MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS)
          ) {
            dependencies.debug(
              `[perf] member-spawn snapshot suppressed team=${teamName} runId=${runId ?? 'none'} reason=member-spawn-ui-equal`
            );
          }
        },
      },
      requestScope: {
        capture: (teamName) =>
          this.captureTeamRequestScope(() => dependencies.getActiveContextState(), teamName),
        isCurrent: (teamName, scope) =>
          this.isTeamRequestScopeCurrent(
            () => dependencies.getActiveContextState(),
            teamName,
            scope
          ),
      },
      runtimeSnapshotPolicy: {
        areVisibleSnapshotsEqual: areTeamAgentRuntimeSnapshotsEqual,
        getFreshnessSnapshot: (teamName, visible, incoming) =>
          this.runtimeFreshness.getSnapshot(teamName, visible, incoming),
        rememberFreshnessSnapshot: (teamName, snapshot) =>
          this.runtimeFreshness.remember(teamName, snapshot),
        stabilizeSnapshot: stabilizeTeamAgentRuntimeSnapshot,
      },
      state: dependencies.state,
    });
  }
}
