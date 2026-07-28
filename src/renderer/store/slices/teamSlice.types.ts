import type { TeamNavigationSlice } from '../team/createTeamNavigationSlice';
import type { TeamProvisioningRuntimeSlice } from '../team/createTeamProvisioningRuntimeSlice';
import type { TeamGraphLayoutSlice } from '@features/agent-graph';
import type { TeamLifecycleMutationSlice } from '@features/team-lifecycle/renderer';
import type { TeamMessageDeliveryRendererSlice } from '@features/team-message-delivery/renderer';
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
import type { ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';

export interface TeamSlice
  extends
    TeamGraphLayoutSlice,
    TeamLifecycleMutationSlice,
    TeamMessageDeliveryRendererSlice,
    TeamMessageFeedRendererSlice,
    TeamProvisioningRuntimeSlice,
    TeamRuntimeOperationsRendererSlice,
    TeamRosterMutationRendererSlice,
    TeamDirectoryRendererSlice,
    TeamNavigationSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
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
