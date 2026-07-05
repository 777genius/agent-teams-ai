import {
  buildOpenCodeSecondaryLaneId,
  buildPlannedMemberLaneIdentity,
  isOpenCodeSideLanePlan,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';

import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';
import type {
  PersistedTeamLaunchPhase,
  TeamCreateRequest,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

export interface MixedSecondaryRuntimeLaneState {
  laneId: string;
  providerId: 'opencode';
  member: TeamCreateRequest['members'][number];
  runId: string | null;
  state: 'queued' | 'launching' | 'finished';
  result: TeamRuntimeLaunchResult | null;
  warnings: string[];
  diagnostics: string[];
  launchScheduled?: boolean;
  queuedAtMs?: number;
  launchStartedAtMs?: number;
  launchFinishedAtMs?: number;
}

export interface SecondaryRuntimeRunEntry {
  runId: string;
  providerId: 'opencode';
  laneId: string;
  memberName: string;
  cwd?: string;
}

export type SecondaryRuntimeRunMap = Map<string, Map<string, SecondaryRuntimeRunEntry>>;

export interface RuntimeAdapterRunEntry {
  runId: string;
  providerId: TeamProviderId;
}

export interface SecondaryRuntimeRunStore {
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  getSecondaryRuntimeRuns(teamName: string): SecondaryRuntimeRunEntry[];
  setSecondaryRuntimeRun(input: SecondaryRuntimeRunEntry & { teamName: string }): void;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  clearSecondaryRuntimeRuns(teamName: string): void;
}

export interface SecondaryRuntimeRunStorePorts {
  clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean }
  ): void;
}

export interface SecondaryRuntimeRunProvisioningRun {
  request: TeamCreateRequest;
  allEffectiveMembers?: TeamCreateRequest['members'];
  effectiveMembers?: TeamCreateRequest['members'];
  expectedMembers?: string[];
  mixedSecondaryLanes?: MixedSecondaryRuntimeLaneState[];
}

export function createMixedSecondaryLaneStates(
  plan: TeamRuntimeLanePlan
): MixedSecondaryRuntimeLaneState[] {
  if (!isOpenCodeSideLanePlan(plan)) {
    return [];
  }
  return plan.sideLanes.map((sideLane) => ({
    laneId: sideLane.laneId,
    providerId: 'opencode',
    member: {
      ...sideLane.member,
    },
    runId: null,
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
  }));
}

export function createMixedSecondaryLaneStateForMember(
  run: Pick<SecondaryRuntimeRunProvisioningRun, 'request' | 'mixedSecondaryLanes'>,
  member: TeamCreateRequest['members'][number]
): MixedSecondaryRuntimeLaneState {
  const leadProviderId = resolveTeamProviderId(run.request.providerId);
  const existingLane = (run.mixedSecondaryLanes ?? []).find((lane) =>
    matchesTeamMemberIdentity(lane.member.name, member.name)
  );
  if (leadProviderId === 'opencode') {
    const memberCwd = member.cwd?.trim();
    const baseCwd = run.request.cwd?.trim();
    const laneId =
      existingLane?.laneId ??
      (memberCwd && (!baseCwd || memberCwd !== baseCwd)
        ? buildOpenCodeSecondaryLaneId(member)
        : null);
    if (!laneId) {
      throw new Error(
        `Member "${member.name}" is not eligible for an OpenCode secondary runtime lane`
      );
    }
    return buildQueuedMixedSecondaryLaneState(laneId, member);
  }

  const laneIdentity = buildPlannedMemberLaneIdentity({
    leadProviderId,
    member: {
      name: member.name,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
    },
  });

  if (laneIdentity.laneKind !== 'secondary' || laneIdentity.laneOwnerProviderId !== 'opencode') {
    throw new Error(
      `Member "${member.name}" is not eligible for an OpenCode secondary runtime lane`
    );
  }

  return buildQueuedMixedSecondaryLaneState(laneIdentity.laneId, member);
}

export function getMixedSecondaryLaunchPhase(
  run: Pick<SecondaryRuntimeRunProvisioningRun, 'mixedSecondaryLanes'>
): PersistedTeamLaunchPhase {
  return (run.mixedSecondaryLanes ?? []).some(
    (lane) =>
      (!lane.result && lane.state !== 'finished') ||
      lane.result?.teamLaunchState === 'partial_pending'
  )
    ? 'active'
    : 'finished';
}

export function upsertRunAllEffectiveMember(
  run: SecondaryRuntimeRunProvisioningRun,
  member: TeamCreateRequest['members'][number]
): void {
  const normalizedName = normalizeMemberName(member.name);
  const currentMembers = Array.isArray(run.allEffectiveMembers) ? run.allEffectiveMembers : [];
  const nextMembers = currentMembers.filter(
    (candidate) => normalizeMemberName(candidate.name) !== normalizedName
  );
  nextMembers.push(member);
  run.allEffectiveMembers = nextMembers;
  run.request = {
    ...run.request,
    members: nextMembers,
  };

  const laneIdentity = buildPlannedMemberLaneIdentity({
    leadProviderId: resolveTeamProviderId(run.request.providerId),
    member: {
      name: member.name,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
    },
  });
  const currentPrimaryMembers = Array.isArray(run.effectiveMembers) ? run.effectiveMembers : [];
  const nextPrimaryMembers = currentPrimaryMembers.filter(
    (candidate) => normalizeMemberName(candidate.name) !== normalizedName
  );
  const currentExpectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
  const nextExpectedMembers = currentExpectedMembers.filter(
    (candidate) => normalizeMemberName(candidate) !== normalizedName
  );
  if (laneIdentity.laneKind === 'primary') {
    run.effectiveMembers = [...nextPrimaryMembers, member];
    run.expectedMembers = [...nextExpectedMembers, member.name.trim()].filter(Boolean);
  } else {
    run.effectiveMembers = nextPrimaryMembers;
    run.expectedMembers = nextExpectedMembers;
  }
}

export function removeRunAllEffectiveMember(
  run: SecondaryRuntimeRunProvisioningRun,
  memberName: string
): void {
  const normalizedName = normalizeMemberName(memberName);
  const currentMembers = Array.isArray(run.allEffectiveMembers) ? run.allEffectiveMembers : [];
  const nextMembers = currentMembers.filter(
    (candidate) => normalizeMemberName(candidate.name) !== normalizedName
  );
  run.allEffectiveMembers = nextMembers;
  run.request = {
    ...run.request,
    members: nextMembers,
  };
  const currentPrimaryMembers = Array.isArray(run.effectiveMembers) ? run.effectiveMembers : [];
  run.effectiveMembers = currentPrimaryMembers.filter(
    (candidate) => normalizeMemberName(candidate.name) !== normalizedName
  );
  const currentExpectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
  run.expectedMembers = currentExpectedMembers.filter(
    (candidate) => normalizeMemberName(candidate) !== normalizedName
  );
}

export function hasSecondaryRuntimeRuns(
  secondaryRuntimeRunByTeam: ReadonlyMap<string, ReadonlyMap<string, SecondaryRuntimeRunEntry>>,
  teamName: string
): boolean {
  const runs = secondaryRuntimeRunByTeam.get(teamName);
  return Boolean(runs && runs.size > 0);
}

export function getSecondaryRuntimeRuns(
  secondaryRuntimeRunByTeam: ReadonlyMap<string, ReadonlyMap<string, SecondaryRuntimeRunEntry>>,
  teamName: string
): SecondaryRuntimeRunEntry[] {
  return Array.from(secondaryRuntimeRunByTeam.get(teamName)?.values() ?? []);
}

export function setSecondaryRuntimeRun(
  secondaryRuntimeRunByTeam: SecondaryRuntimeRunMap,
  input: SecondaryRuntimeRunEntry & { teamName: string }
): void {
  const runs = secondaryRuntimeRunByTeam.get(input.teamName) ?? new Map();
  runs.set(input.laneId, {
    runId: input.runId,
    providerId: input.providerId,
    laneId: input.laneId,
    memberName: input.memberName,
    cwd: input.cwd,
  });
  secondaryRuntimeRunByTeam.set(input.teamName, runs);
}

export function deleteSecondaryRuntimeRun(
  secondaryRuntimeRunByTeam: SecondaryRuntimeRunMap,
  teamName: string,
  laneId: string
): void {
  const runs = secondaryRuntimeRunByTeam.get(teamName);
  if (!runs) {
    return;
  }
  runs.delete(laneId);
  if (runs.size === 0) {
    secondaryRuntimeRunByTeam.delete(teamName);
  }
}

export function clearSecondaryRuntimeRuns(
  secondaryRuntimeRunByTeam: SecondaryRuntimeRunMap,
  teamName: string
): void {
  secondaryRuntimeRunByTeam.delete(teamName);
}

export function createSecondaryRuntimeRunStore(input: {
  secondaryRuntimeRunByTeam: SecondaryRuntimeRunMap;
  ports: SecondaryRuntimeRunStorePorts;
}): SecondaryRuntimeRunStore {
  return {
    hasSecondaryRuntimeRuns: (teamName) =>
      hasSecondaryRuntimeRuns(input.secondaryRuntimeRunByTeam, teamName),
    getSecondaryRuntimeRuns: (teamName) =>
      getSecondaryRuntimeRuns(input.secondaryRuntimeRunByTeam, teamName),
    setSecondaryRuntimeRun: (runInput) =>
      setSecondaryRuntimeRun(input.secondaryRuntimeRunByTeam, runInput),
    deleteSecondaryRuntimeRun: (teamName, laneId) => {
      input.ports.clearOpenCodeRuntimeToolApprovals(teamName, { laneId, emitDismiss: true });
      deleteSecondaryRuntimeRun(input.secondaryRuntimeRunByTeam, teamName, laneId);
    },
    clearSecondaryRuntimeRuns: (teamName) => {
      input.ports.clearOpenCodeRuntimeToolApprovals(teamName, { emitDismiss: true });
      clearSecondaryRuntimeRuns(input.secondaryRuntimeRunByTeam, teamName);
    },
  };
}

export function getCurrentOpenCodeRuntimeRunId(input: {
  teamName: string;
  laneId: string;
  trackedRunId: string | null;
  runs: ReadonlyMap<string, { request: TeamCreateRequest }>;
  provisioningRunByTeam: ReadonlyMap<string, string>;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, TeamProvisioningProgress>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunEntry>;
  secondaryRuntimeRunByTeam: ReadonlyMap<string, ReadonlyMap<string, SecondaryRuntimeRunEntry>>;
  shouldRouteOpenCodeToRuntimeAdapter(request: TeamCreateRequest): boolean;
  isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
}): string | null {
  if (input.laneId === 'primary') {
    const trackedRun = input.trackedRunId ? input.runs.get(input.trackedRunId) : null;
    if (trackedRun && input.shouldRouteOpenCodeToRuntimeAdapter(trackedRun.request)) {
      return input.trackedRunId;
    }
    if (
      input.trackedRunId &&
      input.provisioningRunByTeam.get(input.teamName) === input.trackedRunId &&
      input.runtimeAdapterProgressByRunId.has(input.trackedRunId)
    ) {
      const runtimeProgress = input.runtimeAdapterProgressByRunId.get(input.trackedRunId);
      if (runtimeProgress && input.isCancellableRuntimeAdapterProgress(runtimeProgress)) {
        return input.trackedRunId;
      }
    }
    const runtimeRun = input.runtimeAdapterRunByTeam.get(input.teamName);
    if (runtimeRun?.providerId === 'opencode') {
      return runtimeRun.runId;
    }
    return null;
  }

  const secondaryLaneRun = input.secondaryRuntimeRunByTeam.get(input.teamName)?.get(input.laneId);
  return secondaryLaneRun?.runId ?? null;
}

function buildQueuedMixedSecondaryLaneState(
  laneId: string,
  member: TeamCreateRequest['members'][number]
): MixedSecondaryRuntimeLaneState {
  return {
    laneId,
    providerId: 'opencode',
    member: {
      ...member,
    },
    runId: null,
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
  };
}

function normalizeMemberName(memberName: string): string {
  return memberName.trim().toLowerCase();
}
