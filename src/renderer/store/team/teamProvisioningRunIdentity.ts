import {
  getProvisioningProgressError,
  isTerminalProvisioningState,
} from './teamProvisioningStateRules';

import type { TeamProvisioningProgress } from '@shared/types';

interface ProvisioningState {
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  provisioningErrorByTeam: Record<string, string | null>;
  ignoredProvisioningRunIds: Record<string, string>;
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
          ignoredProvisioningRunIds: {
            ...state.ignoredProvisioningRunIds,
            [previousRunId]: state.ignoredProvisioningRunIds[previousRunId] ?? teamName,
          },
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
export function pruneProvisioningRuns(
  runs: Record<string, TeamProvisioningProgress>,
  owners: Record<string, string | null>,
  progress: TeamProvisioningProgress
): Record<string, TeamProvisioningProgress> {
  const referenced = new Set(Object.values(owners));
  return Object.fromEntries(
    Object.entries(runs).filter(
      ([runId, run]) =>
        runId === progress.runId || run.teamName !== progress.teamName || referenced.has(runId)
    )
  );
}
