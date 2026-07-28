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
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  ActiveToolCall,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  NotificationTarget,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamSummary,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';

export interface GlobalTaskDetailState {
  teamName: string;
  taskId: string;
  commentId?: string;
}

export interface PendingMemberProfileState {
  teamName?: string;
  memberName: string;
  focus?: 'profile' | 'messages' | 'logs';
}

export type TeamSectionTarget = NonNullable<
  Extract<NotificationTarget, { kind: 'team' }>['section']
>;

export interface PendingTeamSectionFocusState {
  teamName: string;
  section: TeamSectionTarget;
}

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
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
  globalTaskDetail: GlobalTaskDetailState | null;
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => void;
  closeGlobalTaskDetail: () => void;
  pendingMemberProfile: PendingMemberProfileState | null;
  openMemberProfile: (
    memberName: string,
    teamName?: string,
    focus?: PendingMemberProfileState['focus']
  ) => void;
  closeMemberProfile: () => void;
  pendingTeamSectionFocus: PendingTeamSectionFocusState | null;
  focusTeamSection: (teamName: string, section: TeamSectionTarget) => void;
  clearTeamSectionFocus: () => void;
  pendingReviewRequest: {
    taskId: string;
    filePath?: string;
    requestOptions: TaskChangeRequestOptions;
  } | null;
  setPendingReviewRequest: (
    req: { taskId: string; filePath?: string; requestOptions: TaskChangeRequestOptions } | null
  ) => void;
  teamsProjectNavigationIntent: {
    projectId: string;
    projectPath: string;
  } | null;
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
  kanbanFilterQuery: string | null;
  openTeamsTab: (projectPath?: string) => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
  clearKanbanFilter: () => void;
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
