export interface TeamRuntimeSecondaryLaneRetryResult {
  attempted: string[];
  confirmed: string[];
  pending: string[];
  failed: { memberName: string; error: string }[];
  skipped: { memberName: string; reason: string }[];
}

export interface TeamRuntimeOperationsRendererSlice {
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedRuntimeLanes(teamName: string): Promise<TeamRuntimeSecondaryLaneRetryResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
  stopRegisteredProcess(teamName: string, pid: number): Promise<void>;
}

export interface TeamRuntimeOperationsRendererTransportPort {
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedSecondaryLanes(teamName: string): Promise<TeamRuntimeSecondaryLaneRetryResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
  stopRegisteredProcess(teamName: string, pid: number): Promise<void>;
}

export interface TeamRuntimeOperationsRefreshActions {
  fetchMemberSpawnStatuses(teamName: string): Promise<unknown>;
  fetchTeamAgentRuntime(teamName: string): Promise<unknown>;
  fetchTeams(): Promise<unknown>;
  refreshTeamMessagesHead(teamName: string): Promise<unknown>;
}

export interface TeamRuntimeOperationsActionsPort {
  getActions(): TeamRuntimeOperationsRefreshActions;
}
