import { isLeadMember } from '@shared/utils/leadDetection';

import type {
  MemberLaunchState,
  MemberSpawnStatus,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
} from '@shared/types';

export type MemberLaunchVisualState =
  | 'queued'
  | 'waiting'
  | 'spawning'
  | 'starting_stale'
  | 'permission_pending'
  | 'bootstrap_stalled'
  | 'runtime_pending'
  | 'shell_only'
  | 'runtime_candidate'
  | 'registered_only'
  | 'stale_runtime'
  | 'settling'
  | 'error'
  | 'skipped'
  | null;

export function getCurrentRuntimeOfflineVisualState(
  member: ResolvedTeamMember,
  runtimeEntry: TeamAgentRuntimeEntry | undefined,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  spawnRuntimeAlive: boolean | undefined,
  spawnBootstrapConfirmed: boolean | undefined,
  isTeamProvisioning: boolean | undefined
): MemberLaunchVisualState {
  // The team lead's runtime is tracked via config.leadSessionId, not as a
  // spawned runtime process.  In the OpenCode adapter path,
  // buildTeamAgentRuntimeSnapshot creates a synthetic runtime entry for the
  // lead with alive:false (no CLI child pid) and no livenessKind — which the
  // checks below would classify as stale_runtime.  Skip lead entries that
  // carry the lead backend marker so every team doesn't show the lead as
  // "stale-runtime" permanently.
  if (isLeadMember(member) && runtimeEntry?.backendType === 'lead') {
    return null;
  }
  if (runtimeEntry?.livenessKind === 'registered_only') {
    return 'registered_only';
  }
  if (
    runtimeEntry?.livenessKind === 'stale_metadata' ||
    runtimeEntry?.livenessKind === 'not_found'
  ) {
    return 'stale_runtime';
  }
  if (
    runtimeEntry?.alive === false &&
    (runtimeEntry.livenessKind == null ||
      runtimeEntry.livenessKind === 'runtime_process' ||
      runtimeEntry.livenessKind === 'confirmed_bootstrap')
  ) {
    return 'stale_runtime';
  }
  if (
    spawnRuntimeAlive === false &&
    (spawnStatus === 'online' || spawnLaunchState === 'confirmed_alive')
  ) {
    return 'stale_runtime';
  }
  if (
    shouldTreatCodexNativeRuntimeAsOffline({
      member,
      runtimeEntry,
      spawnStatus,
      spawnLaunchState,
      spawnRuntimeAlive,
      spawnBootstrapConfirmed,
      isTeamProvisioning,
    })
  ) {
    return 'stale_runtime';
  }
  return null;
}

export function isCodexNativeProcessTeammate(member: ResolvedTeamMember): boolean {
  if (isLeadMember(member)) {
    return false;
  }
  return (
    member.providerId === 'codex' &&
    (member.providerBackendId == null || member.providerBackendId === 'codex-native')
  );
}

export function hasLiveRuntimeProcessEvidence(
  runtimeEntry: TeamAgentRuntimeEntry | undefined
): boolean {
  return runtimeEntry?.alive === true && runtimeEntry.livenessKind === 'runtime_process';
}

function hasSpawnRuntimeLiveClaim({
  spawnStatus,
  spawnLaunchState,
  spawnRuntimeAlive,
  spawnBootstrapConfirmed,
}: {
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  spawnBootstrapConfirmed?: boolean;
}): boolean {
  return (
    spawnStatus === 'online' ||
    spawnLaunchState === 'confirmed_alive' ||
    spawnRuntimeAlive === true ||
    spawnBootstrapConfirmed === true
  );
}

function shouldTreatCodexNativeRuntimeAsOffline({
  member,
  runtimeEntry,
  spawnStatus,
  spawnLaunchState,
  spawnRuntimeAlive,
  spawnBootstrapConfirmed,
  isTeamProvisioning,
}: {
  member: ResolvedTeamMember;
  runtimeEntry?: TeamAgentRuntimeEntry;
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  spawnBootstrapConfirmed?: boolean;
  isTeamProvisioning?: boolean;
}): boolean {
  if (!isCodexNativeProcessTeammate(member)) {
    return false;
  }
  if (
    spawnLaunchState === 'starting' ||
    spawnLaunchState === 'runtime_pending_bootstrap' ||
    spawnLaunchState === 'runtime_pending_permission'
  ) {
    return false;
  }
  if (hasLiveRuntimeProcessEvidence(runtimeEntry)) {
    return false;
  }
  if (
    isTeamProvisioning === true &&
    runtimeEntry == null &&
    !hasSpawnRuntimeLiveClaim({
      spawnStatus,
      spawnLaunchState,
      spawnRuntimeAlive,
      spawnBootstrapConfirmed,
    })
  ) {
    return false;
  }
  return (
    runtimeEntry != null ||
    hasSpawnRuntimeLiveClaim({
      spawnStatus,
      spawnLaunchState,
      spawnRuntimeAlive,
      spawnBootstrapConfirmed,
    }) ||
    spawnStatus == null
  );
}
