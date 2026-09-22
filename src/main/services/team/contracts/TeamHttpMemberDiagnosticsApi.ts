import type {
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types/team';

/** Read-only diagnostic snapshots kept outside the provisioning command aggregate. */
export interface TeamHttpMemberDiagnosticsApi {
  getMemberSpawnStatusesReadOnly(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getTeamAgentRuntimeSnapshotReadOnly(
    teamName: string,
    options?: { memberSpawnStatuses?: MemberSpawnStatusesSnapshot }
  ): Promise<TeamAgentRuntimeSnapshot>;
}
