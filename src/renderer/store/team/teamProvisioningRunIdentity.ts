import { isHostTeamRunId, isHostTeamSelectionKey } from '@features/agent-backend/contracts';

import {
  getProvisioningProgressError,
  isTerminalProvisioningState,
} from './teamProvisioningStateRules';

import type {
  ActiveToolCall,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamSummary,
} from '@shared/types';

/** Keep raw run IDs as keys; one native run can have logical and physical owners. */
export type IgnoredTeamRunOwners = Record<string, string | readonly string[]>;

export function isTeamRunIgnored(
  ignored: IgnoredTeamRunOwners,
  runId: string,
  teamName: string
): boolean {
  const owners = Object.hasOwn(ignored, runId) ? ignored[runId] : undefined;
  return typeof owners === 'string' ? owners === teamName : owners?.includes(teamName) === true;
}

export function addIgnoredTeamRun(
  ignored: IgnoredTeamRunOwners,
  runId: string,
  teamName: string
): IgnoredTeamRunOwners {
  if (isTeamRunIgnored(ignored, runId, teamName)) return ignored;
  const owners = Object.hasOwn(ignored, runId) ? ignored[runId] : undefined;
  return {
    ...ignored,
    [runId]:
      owners === undefined
        ? teamName
        : [...(typeof owners === 'string' ? [owners] : owners), teamName],
  };
}

export function removeIgnoredTeamRunOwner(
  ignored: IgnoredTeamRunOwners,
  teamName: string
): IgnoredTeamRunOwners {
  return Object.fromEntries(
    Object.entries(ignored).flatMap(([runId, owners]) => {
      const remaining = (typeof owners === 'string' ? [owners] : owners).filter(
        (owner) => owner !== teamName
      );
      return remaining.length === 0
        ? []
        : [[runId, remaining.length === 1 ? remaining[0] : remaining]];
    })
  );
}

interface ProvisioningState {
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  provisioningErrorByTeam: Record<string, string | null>;
  ignoredProvisioningRunIds: IgnoredTeamRunOwners;
  provisioningStartedAtFloorByTeam: Record<string, string>;
}

export function getCurrentProvisioningProgressForTeam(
  state: Pick<ProvisioningState, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): TeamProvisioningProgress | null {
  const runId = state.currentProvisioningRunIdByTeam?.[teamName];
  return runId ? (state.provisioningRuns?.[runId] ?? null) : null;
}

/**
 * A verified runtime snapshot adopted a successor. Its progress may be published under the
 * logical name, so retire the previous physical banner before polling the same new run ID.
 */
export function projectProvisioningRuntimeAdoption(
  state: ProvisioningState,
  teamName: string,
  runId: string | null | undefined
): Partial<ProvisioningState> {
  // A Host roster snapshot alone cannot confirm the successor's provisioning status.
  if (isHostTeamSelectionKey(teamName) || isHostTeamRunId(runId)) return {};
  if (!runId || state.currentRuntimeRunIdByTeam[teamName] === runId) return {};
  const previousRunId = state.currentProvisioningRunIdByTeam[teamName];
  const progress = state.provisioningRuns[runId];
  const previous = previousRunId ? state.provisioningRuns[previousRunId] : undefined;
  // Native provisioning and runtime identities can be distinct. A snapshot alone is not
  // permission to replace an active or unknown provisioning attempt.
  if (
    !previous ||
    !isTerminalProvisioningState(previous.state) ||
    previous.retainedSecondaryRuntime
  )
    return {};
  const errors = { ...state.provisioningErrorByTeam };
  // Only an error whose owning attempt was superseded may be removed.
  if (previousRunId && previousRunId !== runId) delete errors[teamName];
  if (progress) {
    const error = getProvisioningProgressError(progress);
    if (error) errors[teamName] = error;
    else delete errors[teamName];
  }
  return {
    currentProvisioningRunIdByTeam: { ...state.currentProvisioningRunIdByTeam, [teamName]: runId },
    provisioningErrorByTeam: errors,
    ...(previousRunId && previousRunId !== runId
      ? {
          ignoredProvisioningRunIds: addIgnoredTeamRun(
            state.ignoredProvisioningRunIds,
            previousRunId,
            teamName
          ),
        }
      : {}),
  };
}

/** Share only an exact run, proven by native runtime snapshots; never infer aliases from names. */
export function projectProvisioningProgressOwners(
  state: ProvisioningState,
  progress: TeamProvisioningProgress
): Pick<
  ProvisioningState,
  'currentProvisioningRunIdByTeam' | 'provisioningErrorByTeam' | 'provisioningStartedAtFloorByTeam'
> {
  const owners = new Set([progress.teamName]);
  for (const [teamName, runId] of Object.entries(state.currentRuntimeRunIdByTeam)) {
    if (runId === progress.runId) owners.add(teamName);
  }
  const current = { ...state.currentProvisioningRunIdByTeam };
  const errors = { ...state.provisioningErrorByTeam };
  const floors = { ...state.provisioningStartedAtFloorByTeam };
  const error = getProvisioningProgressError(progress);
  for (const teamName of owners) {
    const previousId = current[teamName];
    const previous = previousId ? state.provisioningRuns[previousId] : undefined;
    if (
      teamName !== progress.teamName &&
      previousId &&
      previousId !== progress.runId &&
      (!previous ||
        !isTerminalProvisioningState(previous.state) ||
        previous.retainedSecondaryRuntime)
    )
      continue;
    current[teamName] = progress.runId;
    if (error) errors[teamName] = error;
    else delete errors[teamName];
    // Late events of an earlier attempt cannot retarget a stopped successor's banner.
    if (!floors[teamName] || progress.startedAt > floors[teamName]) {
      floors[teamName] = progress.startedAt;
    }
  }
  return {
    currentProvisioningRunIdByTeam: current,
    provisioningErrorByTeam: errors,
    provisioningStartedAtFloorByTeam: floors,
  };
}

/** Keep an old attempt until every alias that still presents it can reconcile its terminal state. */
export function pruneProvisioningRuns<TRun extends { teamName: string }>(
  runs: Record<string, TRun>,
  owners: Record<string, string | null | undefined>,
  progress: { teamName: string; runId?: string }
): Record<string, TRun> {
  const referenced = new Set(Object.values(owners));
  return Object.fromEntries(
    Object.entries(runs).filter(
      ([runId, run]) =>
        runId === progress.runId || run.teamName !== progress.teamName || referenced.has(runId)
    )
  );
}

interface MissingProvisioningRunState extends ProvisioningState {
  ignoredRuntimeRunIds: IgnoredTeamRunOwners;
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
  activeToolsByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  finishedVisibleByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  toolHistoryByTeam: Record<string, Record<string, ActiveToolCall[]>>;
}

function omitOwners<T>(record: Record<string, T>, owners: ReadonlySet<string>): Record<string, T> {
  const next = { ...record };
  for (const owner of owners) delete next[owner];
  return next;
}

/** Missing status is a run-level result, even when its cached progress has already disappeared. */
export function projectMissingProvisioningRunCleanup(
  state: MissingProvisioningRunState,
  runId: string
): { state: Partial<MissingProvisioningRunState>; clearedRuntimeTeams: string[] } {
  const existing = state.provisioningRuns[runId];
  const provisioningOwners = new Set(
    Object.entries(state.currentProvisioningRunIdByTeam)
      .filter(([, current]) => current === runId)
      .map(([teamName]) => teamName)
  );
  const runtimeOwners = new Set(
    Object.entries(state.currentRuntimeRunIdByTeam)
      .filter(([, current]) => current === runId)
      .map(([teamName]) => teamName)
  );
  const owners = new Set([...provisioningOwners, ...runtimeOwners]);
  if (!existing && owners.size === 0) return { state: {}, clearedRuntimeTeams: [] };

  // Untagged per-team caches must survive if either authority already belongs to another run.
  const cacheOwners = new Set(
    [...owners].filter((teamName) => {
      const provisioning = state.currentProvisioningRunIdByTeam[teamName];
      const runtime = state.currentRuntimeRunIdByTeam[teamName];
      return (!provisioning || provisioning === runId) && (!runtime || runtime === runId);
    })
  );
  if (existing) owners.add(existing.teamName);
  let ignoredProvisioningRunIds = state.ignoredProvisioningRunIds;
  let ignoredRuntimeRunIds = state.ignoredRuntimeRunIds;
  for (const owner of owners) {
    ignoredProvisioningRunIds = addIgnoredTeamRun(ignoredProvisioningRunIds, runId, owner);
    ignoredRuntimeRunIds = addIgnoredTeamRun(ignoredRuntimeRunIds, runId, owner);
  }
  const provisioningRuns = { ...state.provisioningRuns };
  delete provisioningRuns[runId];
  return {
    clearedRuntimeTeams: [...cacheOwners],
    state: {
      provisioningRuns,
      currentProvisioningRunIdByTeam: omitOwners(
        state.currentProvisioningRunIdByTeam,
        provisioningOwners
      ),
      currentRuntimeRunIdByTeam: omitOwners(state.currentRuntimeRunIdByTeam, runtimeOwners),
      provisioningErrorByTeam: omitOwners(state.provisioningErrorByTeam, provisioningOwners),
      provisioningSnapshotByTeam: omitOwners(state.provisioningSnapshotByTeam, provisioningOwners),
      memberSpawnStatusesByTeam: omitOwners(state.memberSpawnStatusesByTeam, cacheOwners),
      memberSpawnSnapshotsByTeam: omitOwners(state.memberSpawnSnapshotsByTeam, cacheOwners),
      teamAgentRuntimeByTeam: omitOwners(state.teamAgentRuntimeByTeam, cacheOwners),
      activeToolsByTeam: omitOwners(state.activeToolsByTeam, cacheOwners),
      finishedVisibleByTeam: omitOwners(state.finishedVisibleByTeam, cacheOwners),
      toolHistoryByTeam: omitOwners(state.toolHistoryByTeam, cacheOwners),
      ignoredProvisioningRunIds,
      ignoredRuntimeRunIds,
    },
  };
}
