import type { TeamNavigationSlice } from '../team/createTeamNavigationSlice';
import type { TeamGraphLayoutSlice } from '@features/agent-graph';
import type { TeamLifecycleMutationSlice } from '@features/team-lifecycle/renderer';
import type { TeamMessageDeliveryRendererSlice } from '@features/team-message-delivery/renderer';
import type {
  TeamProvisioningControlSlice,
  TeamProvisioningLaunchSlice,
  TeamProvisioningProgressSlice,
  TeamRuntimeObservationSlice,
} from '@features/team-provisioning/renderer';
import type { TeamRosterMutationRendererSlice } from '@features/team-roster-mutations/renderer';
import type { TeamRuntimeOperationsRendererSlice } from '@features/team-runtime-operations/renderer';
import type {
  TeamTaskArtifactsRendererSlice,
  TeamTaskBoardRendererSlice,
} from '@features/team-task-board/renderer';
import type {
  TeamDirectoryRendererSlice,
  TeamMessageFeedRendererSlice,
  TeamViewDataRendererSlice,
} from '@features/team-view-read-model/renderer';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type {
  ActiveToolCall,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamSummary,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';

export interface TeamSlice
  extends
    TeamGraphLayoutSlice,
    TeamLifecycleMutationSlice,
    TeamMessageDeliveryRendererSlice,
    TeamMessageFeedRendererSlice,
    TeamProvisioningControlSlice,
    TeamProvisioningLaunchSlice,
    TeamProvisioningProgressSlice,
    TeamRuntimeObservationSlice,
    TeamRuntimeOperationsRendererSlice,
    TeamRosterMutationRendererSlice,
    TeamDirectoryRendererSlice,
    TeamNavigationSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  ignoredProvisioningRunIds: Record<string, string>;
  ignoredRuntimeRunIds: Record<string, string>;
  provisioningStartedAtFloorByTeam: Record<string, string>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  leadContextByTeam: Record<string, LeadContextUsage>;
  activeTaskLogActivityByTeam: Record<string, Record<string, true>>;
  activeToolsByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  finishedVisibleByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  toolHistoryByTeam: Record<string, Record<string, ActiveToolCall[]>>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
  provisioningErrorByTeam: Record<string, string | null>;
  clearProvisioningError: (teamName?: string) => void;
  pendingApprovals: ToolApprovalRequest[];
  resolvedApprovals: Map<string, boolean>;
  toolApprovalSettingsByTeam: Record<string, ToolApprovalSettings>;
  toolApprovalSettings: ToolApprovalSettings;
  updateToolApprovalSettings: (
    patch: Partial<ToolApprovalSettings>,
    forTeam?: string
  ) => Promise<void>;
  respondToToolApproval: (
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ) => Promise<void>;
  messagesPanelMode: TeamMessagesPanelMode;
  messagesPanelWidth: number;
  sidebarLogsHeight: number;
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => void;
  setMessagesPanelWidth: (width: number) => void;
  setSidebarLogsHeight: (height: number) => void;
}

export type {
  GlobalTaskDetailState,
  PendingMemberProfileState,
  PendingReviewRequestState,
  PendingTeamSectionFocusState,
  TeamsProjectNavigationIntent,
} from '../team/teamSliceStateTypes';
