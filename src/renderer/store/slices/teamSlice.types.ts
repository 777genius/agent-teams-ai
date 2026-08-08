import type { TeamNavigationSlice } from '../team/createTeamNavigationSlice';
import type { TeamProvisioningRuntimeSlice } from '../team/createTeamProvisioningRuntimeSlice';
import type { TeamGraphLayoutSlice } from '@features/agent-graph';
import type { TeamLifecycleMutationSlice } from '@features/team-lifecycle/renderer';
import type { TeamMessageDeliveryRendererSlice } from '@features/team-message-delivery/renderer';
import type { TeamToolApprovalRendererSlice } from '@features/team-provisioning/renderer';
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
  TeamViewPreferencesRendererSlice,
} from '@features/team-view-read-model/renderer';

export interface TeamSlice
  extends
    TeamGraphLayoutSlice,
    TeamLifecycleMutationSlice,
    TeamMessageDeliveryRendererSlice,
    TeamMessageFeedRendererSlice,
    TeamProvisioningRuntimeSlice,
    TeamToolApprovalRendererSlice,
    TeamRuntimeOperationsRendererSlice,
    TeamRosterMutationRendererSlice,
    TeamDirectoryRendererSlice,
    TeamNavigationSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice,
    TeamViewPreferencesRendererSlice {}

export type {
  GlobalTaskDetailState,
  PendingMemberProfileState,
  PendingReviewRequestState,
  PendingTeamSectionFocusState,
  TeamsProjectNavigationIntent,
} from '../team/teamSliceStateTypes';
