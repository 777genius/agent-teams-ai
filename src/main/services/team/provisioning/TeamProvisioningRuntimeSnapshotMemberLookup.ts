import { matchesExactTeamMemberName } from './TeamProvisioningMemberIdentity';

import type { TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type {
  RuntimeAdapterRunSnapshotSource,
  TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshotTypes';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamAgentRuntimeEntry,
  TeamCreateRequest,
} from '@shared/types';

function normalizeRuntimeLaneKind(value: unknown): 'primary' | 'secondary' | undefined {
  return value === 'primary' || value === 'secondary' ? value : undefined;
}

function normalizeRuntimeLaneIdentity(
  value: unknown
): Pick<TeamAgentRuntimeEntry, 'laneId' | 'laneKind'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const laneId = typeof record.laneId === 'string' ? record.laneId.trim() : '';
  const laneKind = normalizeRuntimeLaneKind(record.laneKind);
  return {
    ...(laneId ? { laneId } : {}),
    ...(laneKind ? { laneKind } : {}),
  };
}

export function findExactMemberRecordEntry<T>(
  members: Readonly<Record<string, T>> | null | undefined,
  memberName: string
): [string, T] | undefined {
  return Object.entries(members ?? {}).find(([candidateName]) =>
    matchesExactTeamMemberName(candidateName, memberName)
  );
}

export function findExactPersistedLaunchMember(
  snapshot: PersistedTeamLaunchSnapshot | null | undefined,
  memberName: string
): PersistedTeamLaunchMemberState | undefined {
  const entry = findExactMemberRecordEntry(snapshot?.members, memberName);
  if (!entry || !matchesExactTeamMemberName(entry[1].name, memberName)) {
    return undefined;
  }
  return entry[1];
}

export function memberIdentityKey(memberName: string): string {
  return memberName.trim().toLowerCase();
}

export function findExactActiveRunMember(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): TeamCreateRequest['members'][number] | undefined {
  for (const member of [...(run?.allEffectiveMembers ?? []), ...(run?.effectiveMembers ?? [])]) {
    const candidateName = member.name?.trim() ?? '';
    if (candidateName && matchesExactTeamMemberName(candidateName, memberName)) {
      return member;
    }
  }
  return undefined;
}

export function findExactActiveRunMemberModel(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): string | undefined {
  return findExactActiveRunMember(run, memberName)?.model?.trim() || undefined;
}

export function findExactTrackedMemberSpawnStatus(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): MemberSpawnStatusEntry | undefined {
  return run?.memberSpawnStatuses
    ? findExactMapEntry(run.memberSpawnStatuses, memberName)?.[1]
    : undefined;
}

function findExactRuntimeMemberEvidence(
  members: Readonly<Record<string, TeamRuntimeMemberLaunchEvidence>> | null | undefined,
  memberName: string
): TeamRuntimeMemberLaunchEvidence | undefined {
  for (const [candidateName, evidence] of Object.entries(members ?? {})) {
    if (!matchesExactTeamMemberName(candidateName, memberName)) {
      continue;
    }
    const evidenceMemberName =
      typeof evidence.memberName === 'string' ? evidence.memberName.trim() : '';
    if (
      evidenceMemberName.length > 0 &&
      !matchesExactTeamMemberName(evidenceMemberName, memberName)
    ) {
      continue;
    }
    return evidence;
  }
  return undefined;
}

export function findExactMapEntry<T>(
  entries: ReadonlyMap<string, T>,
  memberName: string
): [string, T] | undefined {
  for (const entry of entries) {
    if (matchesExactTeamMemberName(entry[0], memberName)) {
      return entry;
    }
  }
  return undefined;
}

export function resolveActiveRunLaneIdentity(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): Pick<TeamAgentRuntimeEntry, 'laneId' | 'laneKind'> {
  if (!run) {
    return {};
  }
  for (const lane of run.mixedSecondaryLanes ?? []) {
    const laneMemberName = lane.member.name?.trim() ?? '';
    if (!laneMemberName || !matchesExactTeamMemberName(laneMemberName, memberName)) {
      continue;
    }
    const laneId = typeof lane.laneId === 'string' ? lane.laneId.trim() : '';
    return {
      ...(laneId ? { laneId } : {}),
      laneKind: 'secondary',
    };
  }
  return normalizeRuntimeLaneIdentity(findExactActiveRunMember(run, memberName));
}

interface ActiveRunRuntimeAdapterEvidenceResolution {
  owner: 'primary' | 'secondary' | 'none';
  evidence?: TeamRuntimeMemberLaunchEvidence;
}

export function resolveActiveRunRuntimeAdapterEvidence(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  runtimeAdapterRun: RuntimeAdapterRunSnapshotSource | undefined,
  memberName: string
): ActiveRunRuntimeAdapterEvidenceResolution {
  for (const lane of run?.mixedSecondaryLanes ?? []) {
    const laneMemberName = lane.member.name?.trim() ?? '';
    if (!laneMemberName || !matchesExactTeamMemberName(laneMemberName, memberName)) {
      continue;
    }
    const laneRunId = lane.runId?.trim() ?? '';
    const resultRunId = lane.result?.runId?.trim() ?? '';
    if (!laneRunId || !resultRunId || resultRunId !== laneRunId) {
      return { owner: 'secondary' };
    }
    return {
      owner: 'secondary',
      evidence: findExactRuntimeMemberEvidence(lane.result?.members, memberName),
    };
  }
  return {
    owner: runtimeAdapterRun ? 'primary' : 'none',
    evidence: findExactRuntimeMemberEvidence(runtimeAdapterRun?.members, memberName),
  };
}
