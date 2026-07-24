import type {
  ActiveToolCall,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

export interface TeamProvisioningControlTransportPort {
  cancel(runId: string): Promise<void>;
  getStatus(runId: string): Promise<TeamProvisioningProgress>;
  subscribe(listener: (progress: TeamProvisioningProgress) => void): (() => void) | null;
}

export interface TeamProvisioningControlStoreState {
  activeToolsByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  finishedVisibleByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  ignoredProvisioningRunIds: Record<string, string>;
  ignoredRuntimeRunIds: Record<string, string>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  provisioningProgressUnsubscribe: (() => void) | null;
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
  toolHistoryByTeam: Record<string, Record<string, ActiveToolCall[]>>;
}

export interface TeamProvisioningControlStatePort {
  getState(): TeamProvisioningControlStoreState;
  setState(
    update:
      | Partial<TeamProvisioningControlStoreState>
      | ((state: TeamProvisioningControlStoreState) => Partial<TeamProvisioningControlStoreState>)
  ): void;
}

export interface TeamProvisioningControlEffectsPort {
  applyProgress(progress: TeamProvisioningProgress): void;
  clearLaunchTracking(runId: string): void;
  clearRuntimeFreshness(teamName: string): void;
}
