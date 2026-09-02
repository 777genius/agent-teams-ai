import type { TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type { MemberSpawnStatusEntry, TeamCreateRequest, TeamProviderId } from '@shared/types';

export interface RuntimeAdapterRunSnapshotSource {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

export interface TeamProvisioningRuntimeSnapshotRun {
  runId: string;
  child: { pid?: number } | null;
  processKilled?: boolean;
  cancelRequested?: boolean;
  request: TeamCreateRequest;
  spawnContext?: { args: readonly string[] } | null;
  allEffectiveMembers?: TeamCreateRequest['members'];
  effectiveMembers?: TeamCreateRequest['members'];
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  mixedSecondaryLanes?: readonly {
    laneId?: string;
    member: TeamCreateRequest['members'][number];
    runId?: string | null;
    result?: {
      runId?: string;
      members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
    } | null;
  }[];
}
