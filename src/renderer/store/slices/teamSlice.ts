import { createTeamStoreFeatureSlices } from '../team/createTeamStoreFeatureSlices';

import type { AppState } from '../types';
import type { TeamSlice } from './teamSlice.types';
import type { StateCreator } from 'zustand';

export {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
} from '../team/createTeamProvisioningRuntimeSlice';
export {
  __getTeamScopedTransientStateForTests,
  __resetTeamSliceModuleStateForTests,
  isTeamDataRefreshPending,
} from '../team/createTeamStoreFeatureSlices';
export { getLastResolvedTeamDataRefreshAt } from '../team/teamDataRefreshTimestamps';
export {
  selectTeamDataForName,
  selectTeamIsAliveForName,
  selectTeamMemberSnapshotsForName,
  selectTeamTasksForName,
} from '../team/teamDataSelectors';
export type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
} from '../team/teamMessagesCache';
export { selectMemberMessagesForTeamMember, selectTeamMessages } from '../team/teamMessagesCache';
export {
  loadPersistedMessagesPanelMode,
  savePersistedMessagesPanelMode,
} from '../team/teamMessagesPanelModePersistence';
export {
  getActiveTeamPendingReplyWaits,
  hasActiveTeamPendingReplyWait,
} from '../team/teamPendingReplyWaits';
export {
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
} from '../team/teamResolvedMembers';
export type {
  GlobalTaskDetailState,
  PendingMemberProfileState,
  PendingReviewRequestState,
  PendingTeamSectionFocusState,
  TeamsProjectNavigationIntent,
} from '../team/teamSliceStateTypes';
export type { TeamSlice } from './teamSlice.types';
export {
  getDefaultTeamGraphSlotAssignmentsForMembers,
  isTeamGraphSlotPersistenceDisabled,
} from '@features/agent-graph';
export type { TeamLaunchParams } from '@features/team-provisioning/renderer';

export const createTeamSlice: StateCreator<AppState, [], [], TeamSlice> = (set, get, store) =>
  createTeamStoreFeatureSlices(set, get, store);
