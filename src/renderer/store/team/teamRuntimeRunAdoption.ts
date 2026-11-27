import {
  hostTeamSelectionKey,
  isHostTeamRunId,
  isHostTeamSelectionKey,
  parseHostTeamRunId,
} from '@features/agent-backend/contracts';
import {
  hostMemberSpawnSnapshotCurrentness,
  hostProjectProgressOwners,
} from '@features/agent-backend/renderer';

import { areMemberSpawnSnapshotsSemanticallyEqual } from './teamMemberSpawnSnapshotEquality';
import { addIgnoredTeamRun, isTeamRunIgnored } from './teamProvisioningRunIdentity';
import { isTerminalProvisioningState } from './teamProvisioningStateRules';

import type { IgnoredTeamRunOwners } from './teamProvisioningRunIdentity';
import type {
  LeadActivityState,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

const STOPPED_SPAWN_STATUSES: ReadonlySet<MemberSpawnStatus> = new Set([
  'offline',
  'error',
  'skipped',
]);

export type IncomingRuntimeRunAdoption = 'reject' | 'apply' | 'retarget';

type SpawnStatusLike = Pick<MemberSpawnStatusEntry, 'status' | 'runtimeAlive'>;

/** Capture the existing Host status-read scope and both pins before its await. */
export function captureHostProvisioningStatusRead(
  runId: string,
  get: () => {
    currentProvisioningRunIdByTeam: Record<string, string | null>;
    currentRuntimeRunIdByTeam: Record<string, string | null>;
    teamByName?: Record<string, unknown>;
  },
  captureScopeCurrentness: (teamName: string) => () => boolean
): (progress?: TeamProvisioningProgress) => boolean {
  if (!isHostTeamRunId(runId)) return () => true;
  const teamName = hostTeamSelectionKey(parseHostTeamRunId(runId).handleId);
  const original = get();
  const owned = (state: ReturnType<typeof get>) =>
    new Set([
      teamName,
      ...Object.entries(state.currentProvisioningRunIdByTeam)
        .filter(([, id]) => id === runId)
        .map(([name]) => name),
      ...Object.entries(state.currentRuntimeRunIdByTeam)
        .filter(([, id]) => id === runId)
        .map(([name]) => name),
    ]);
  const originalOwners = owned(original);
  const names = new Set([
    teamName,
    ...Object.keys(original.teamByName ?? {}),
    ...Object.keys(original.currentProvisioningRunIdByTeam),
    ...Object.keys(original.currentRuntimeRunIdByTeam),
  ]);
  const captured = new Map(
    [...names].filter(isHostTeamSelectionKey).map((name) => [
      name,
      {
        current: captureScopeCurrentness(name),
        provisioning: original.currentProvisioningRunIdByTeam[name],
        runtime: original.currentRuntimeRunIdByTeam[name],
      },
    ])
  );
  return (progress) => {
    const next = get(),
      latestOwners = owned(next);
    if (
      latestOwners.size !== originalOwners.size ||
      [...latestOwners].some((name) => !originalOwners.has(name))
    )
      return false;
    const proved = progress ? hostProjectProgressOwners(progress) : undefined;
    if (proved === null) return false;
    const required = new Set([...originalOwners, ...(proved ?? [])]);
    if (progress && progress.teamName !== teamName && !proved?.includes(progress.teamName))
      return false;
    for (const name of required) {
      const pin = captured.get(name);
      if (
        !pin ||
        !pin.current() ||
        next.currentProvisioningRunIdByTeam[name] !== pin.provisioning ||
        next.currentRuntimeRunIdByTeam[name] !== pin.runtime
      )
        return false;
    }
    return true;
  };
}

export function isPinnedRuntimeRunFullyStopped(
  statuses: Record<string, SpawnStatusLike> | undefined
): boolean {
  const entries = Object.values(statuses ?? {});
  if (entries.length === 0) {
    return false;
  }

  return entries.every(
    (entry) => entry.runtimeAlive !== true && STOPPED_SPAWN_STATUSES.has(entry.status)
  );
}

export function resolveIncomingRuntimeRunAdoption(input: {
  teamName: string;
  snapshotRunId?: string | null;
  currentRuntimeRunId?: string | null;
  ignoredRuntimeRunIds: IgnoredTeamRunOwners;
  leadActivity?: string;
  pinnedSpawnStatuses?: Record<string, SpawnStatusLike>;
}): IncomingRuntimeRunAdoption {
  const snapshotRunId = input.snapshotRunId?.trim() || null;
  if (
    snapshotRunId &&
    isTeamRunIgnored(input.ignoredRuntimeRunIds, snapshotRunId, input.teamName)
  ) {
    return 'reject';
  }

  const currentRuntimeRunId = input.currentRuntimeRunId?.trim() || null;
  if (!currentRuntimeRunId) {
    if (input.leadActivity === 'offline' && snapshotRunId) {
      return 'reject';
    }
    return 'apply';
  }

  if (!snapshotRunId || currentRuntimeRunId === snapshotRunId) {
    return 'apply';
  }

  if (isPinnedRuntimeRunFullyStopped(input.pinnedSpawnStatuses)) {
    return 'retarget';
  }

  return 'reject';
}

function isSameHostLaunchRevision(
  teamName: string,
  previous: string,
  next: string,
  verifiedProject = false
): boolean {
  if (previous === next) return false;
  try {
    const before = parseHostTeamRunId(previous),
      after = parseHostTeamRunId(next);
    return (
      (hostTeamSelectionKey(before.handleId) === teamName || verifiedProject) &&
      before.handleId === after.handleId &&
      before.launchId === after.launchId &&
      before.rosterRevision !== after.rosterRevision
    );
  } catch {
    return false;
  }
}

export function shouldAdoptSuccessorProvisioningRun(input: {
  teamName: string;
  previousRunId?: string | null;
  previousState?: TeamProvisioningProgress['state'];
  previousStartedAt?: string;
  nextStartedAt?: string;
  nextRunObserved?: boolean;
  nextRunId?: string | null;
  currentRuntimeRunId?: string | null;
  ignoredRuntimeRunIds: IgnoredTeamRunOwners;
  pinnedSpawnStatuses?: Record<string, SpawnStatusLike>;
  verifiedHostProjectOwner?: boolean;
}): boolean {
  const nextRunId = input.nextRunId?.trim() || null;
  if (!nextRunId || isTeamRunIgnored(input.ignoredRuntimeRunIds, nextRunId, input.teamName)) {
    return false;
  }

  const previousRunId = input.previousRunId?.trim() || null;
  if (!previousRunId || previousRunId === nextRunId) {
    return false;
  }

  // Only a fresh captured snapshot can first move the same Host launch's runtime pin.
  if (
    isSameHostLaunchRevision(
      input.teamName,
      previousRunId,
      nextRunId,
      input.verifiedHostProjectOwner
    )
  )
    return input.currentRuntimeRunId === nextRunId;

  const previousIsTerminal =
    input.previousState == null || isTerminalProvisioningState(input.previousState);
  if (!previousIsTerminal) {
    return false;
  }

  // A stopped project's historical runtime pointer must not prove that a late
  // event is a successor of the current project. An exact current runtime ID
  // remains authoritative; an implicit successor must be strictly newer.
  if (input.currentRuntimeRunId === nextRunId) return true;
  if (
    input.previousStartedAt &&
    input.nextStartedAt &&
    input.nextStartedAt <= input.previousStartedAt
  )
    return false;
  return (
    input.nextRunObserved === true || isPinnedRuntimeRunFullyStopped(input.pinnedSpawnStatuses)
  );
}

export function nextRuntimeRunIdByTeamAfterAdoption(
  current: Record<string, string | null>,
  teamName: string,
  snapshotRunId: string | null | undefined,
  adoption: IncomingRuntimeRunAdoption,
  pinWhenUnset: boolean
): Record<string, string | null> {
  if (
    snapshotRunId &&
    (adoption === 'retarget' || (pinWhenUnset && current[teamName] == null)) &&
    current[teamName] !== snapshotRunId
  ) {
    return {
      ...current,
      [teamName]: snapshotRunId,
    };
  }
  return current;
}

export interface IncomingMemberSpawnProjectionState {
  ignoredRuntimeRunIds: IgnoredTeamRunOwners;
  ignoredProvisioningRunIds?: IgnoredTeamRunOwners;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
}

export function projectIncomingMemberSpawnSnapshot(input: {
  teamName: string;
  snapshot: MemberSpawnStatusesSnapshot;
  prev: IncomingMemberSpawnProjectionState;
  onEqualSuppressed: (teamName: string, runId: string | null | undefined) => void;
}): Partial<IncomingMemberSpawnProjectionState> {
  const { teamName, snapshot, prev } = input;
  const previousRunId = prev.currentRuntimeRunIdByTeam[teamName];
  const hostCurrent = hostMemberSpawnSnapshotCurrentness(snapshot, teamName);
  const hostRevision =
    typeof previousRunId === 'string' &&
    typeof snapshot.runId === 'string' &&
    isSameHostLaunchRevision(teamName, previousRunId, snapshot.runId, hostCurrent === true);
  if (hostCurrent === false || (hostRevision && hostCurrent !== true)) return {};
  if (
    hostRevision &&
    [previousRunId, snapshot.runId].some(
      (runId) =>
        isTeamRunIgnored(prev.ignoredRuntimeRunIds, runId!, teamName) ||
        isTeamRunIgnored(prev.ignoredProvisioningRunIds ?? {}, runId!, teamName)
    )
  )
    return {};
  const retired = hostRevision
    ? {
        ignoredRuntimeRunIds: addIgnoredTeamRun(prev.ignoredRuntimeRunIds, previousRunId, teamName),
      }
    : {};
  const adoption = hostRevision
    ? 'retarget'
    : resolveIncomingRuntimeRunAdoption({
        teamName,
        snapshotRunId: snapshot.runId,
        currentRuntimeRunId: prev.currentRuntimeRunIdByTeam[teamName],
        ignoredRuntimeRunIds: prev.ignoredRuntimeRunIds,
        leadActivity: prev.leadActivityByTeam[teamName],
        pinnedSpawnStatuses: prev.memberSpawnStatusesByTeam[teamName],
      });
  if (adoption === 'reject') {
    return {};
  }

  const nextCurrentRuntimeRunIdByTeam = nextRuntimeRunIdByTeamAfterAdoption(
    prev.currentRuntimeRunIdByTeam,
    teamName,
    snapshot.runId,
    adoption,
    true
  );
  const previousSnapshot = prev.memberSpawnSnapshotsByTeam[teamName];
  if (areMemberSpawnSnapshotsSemanticallyEqual(previousSnapshot, snapshot)) {
    input.onEqualSuppressed(teamName, snapshot.runId);
    if (nextCurrentRuntimeRunIdByTeam === prev.currentRuntimeRunIdByTeam) {
      return {};
    }
    return { ...retired, currentRuntimeRunIdByTeam: nextCurrentRuntimeRunIdByTeam };
  }

  return {
    ...retired,
    currentRuntimeRunIdByTeam: nextCurrentRuntimeRunIdByTeam,
    memberSpawnStatusesByTeam: {
      ...prev.memberSpawnStatusesByTeam,
      [teamName]: snapshot.statuses,
    },
    memberSpawnSnapshotsByTeam: {
      ...prev.memberSpawnSnapshotsByTeam,
      [teamName]: snapshot,
    },
  };
}

/** A failed primary does not revoke live members of the same owned aggregate. */
export function retainTerminalMemberSpawnStatuses(
  statuses: Record<string, MemberSpawnStatusEntry>,
  progress: TeamProvisioningProgress,
  currentRuntimeRunId: string | null | undefined
): Record<string, MemberSpawnStatusEntry> {
  const retainLive =
    progress.state === 'failed' &&
    progress.retainedSecondaryRuntime === true &&
    currentRuntimeRunId === progress.runId;
  return Object.fromEntries(
    Object.entries(statuses).filter(
      ([, entry]) => entry.status === 'error' || (retainLive && entry.runtimeAlive === true)
    )
  );
}
