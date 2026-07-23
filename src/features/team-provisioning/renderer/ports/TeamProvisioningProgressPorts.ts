import type { TeamProvisioningProgressState } from '../../core/application';
import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

export interface TeamProvisioningProgressStoreState extends TeamProvisioningProgressState {
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
}

export interface TeamProvisioningProgressStatePort {
  getState(): TeamProvisioningProgressStoreState;
  setState(
    update:
      | Partial<TeamProvisioningProgressStoreState>
      | ((state: TeamProvisioningProgressStoreState) => Partial<TeamProvisioningProgressStoreState>)
  ): void;
}

export interface TeamProvisioningSurfaceSnapshot {
  hasSelectedTeamData: boolean;
  selected: boolean;
  visible: boolean;
}

export interface TeamProvisioningRefreshFanoutNote {
  operation:
    | 'fetchMemberSpawnStatuses'
    | 'fetchTeamAgentRuntime'
    | 'fetchTeams'
    | 'refreshTeamData'
    | 'selectTeam';
  phase: 'scheduled' | 'skipped';
  reason: string;
  selected?: boolean;
  teamName: string;
  visible?: boolean;
}

export interface TeamProvisioningProgressAnalyticsPort {
  noteRefreshFanout(note: TeamProvisioningRefreshFanoutNote): void;
  recordStepTransition(
    existingProgress: TeamProvisioningProgress | undefined,
    progress: TeamProvisioningProgress
  ): void;
  recordTerminalProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningProgressRefreshPort {
  fetchMemberSpawnStatuses(teamName: string): Promise<void>;
  fetchTeamAgentRuntime(teamName: string): Promise<void>;
  fetchTeams(): Promise<void>;
  getSurface(teamName: string): TeamProvisioningSurfaceSnapshot;
  refreshTeamData(teamName: string, options: { withDedup: true }): Promise<void>;
  selectTeam(teamName: string, options?: { allowReloadWhileProvisioning: true }): Promise<void>;
}

export interface TeamProvisioningProgressRuntimePort {
  clearFreshness(teamName: string): void;
}
