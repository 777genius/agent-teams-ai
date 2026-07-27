import type { AddMemberRequest } from '@shared/types';

export interface TeamRosterMutationRendererSlice {
  addMember(teamName: string, request: AddMemberRequest): Promise<void>;
  removeMember(teamName: string, memberName: string): Promise<void>;
  restoreMember(teamName: string, memberName: string): Promise<void>;
  updateMemberRole(teamName: string, memberName: string, role: string | undefined): Promise<void>;
}

export interface TeamRosterMutationRendererTransportPort {
  add(teamName: string, request: AddMemberRequest): Promise<void>;
  remove(teamName: string, memberName: string): Promise<void>;
  restore(teamName: string, memberName: string): Promise<void>;
  updateRole(teamName: string, memberName: string, role: string | undefined): Promise<void>;
}

export interface TeamRosterMutationRefreshActions {
  fetchMemberSpawnStatuses(teamName: string): Promise<unknown>;
  fetchTeamAgentRuntime(teamName: string): Promise<unknown>;
  refreshTeamData(teamName: string): Promise<unknown>;
}

export interface TeamRosterMutationActionsPort {
  getActions(): TeamRosterMutationRefreshActions;
}
