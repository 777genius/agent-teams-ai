import { shouldIgnoreProvisioningProgressRegression } from '../domain';

import type {
  TeamLaunchDiagnosticItem,
  TeamProvisioningProgress,
  TeamSummary,
} from '@shared/types';

export interface TeamProvisioningProgressState {
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  ignoredProvisioningRunIds: Record<string, string>;
  ignoredRuntimeRunIds: Record<string, string>;
  provisioningErrorByTeam: Record<string, string | null>;
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  provisioningStartedAtFloorByTeam: Record<string, string>;
}

export type ProvisioningProgressUpdatePlan =
  | { kind: 'ignored' }
  | {
      becameConfigReady: boolean;
      existingProgress: TeamProvisioningProgress | undefined;
      kind: 'canonical-progress';
      stateUpdate: Partial<TeamProvisioningProgressState>;
    }
  | {
      kind: 'stale-run-removed';
      stateUpdate: Pick<TeamProvisioningProgressState, 'provisioningRuns'>;
    };

export function planProvisioningProgressUpdate(
  state: TeamProvisioningProgressState,
  progress: TeamProvisioningProgress
): ProvisioningProgressUpdatePlan {
  if (state.ignoredProvisioningRunIds[progress.runId] === progress.teamName) {
    return { kind: 'ignored' };
  }
  if (state.ignoredRuntimeRunIds[progress.runId] === progress.teamName) {
    return { kind: 'ignored' };
  }

  const floor = state.provisioningStartedAtFloorByTeam[progress.teamName];
  if (floor && progress.startedAt < floor) {
    return { kind: 'ignored' };
  }

  const currentRunId = state.currentProvisioningRunIdByTeam[progress.teamName];
  const existingProgress = state.provisioningRuns[progress.runId];
  if (
    existingProgress &&
    currentRunId === progress.runId &&
    provisioningProgressPayloadEqual(existingProgress, progress)
  ) {
    return { kind: 'ignored' };
  }
  if (
    existingProgress &&
    currentRunId === progress.runId &&
    shouldIgnoreProvisioningProgressRegression(existingProgress.state, progress.state)
  ) {
    return { kind: 'ignored' };
  }

  const provisioningRuns = { ...state.provisioningRuns };
  const currentProvisioningRunIdByTeam = {
    ...state.currentProvisioningRunIdByTeam,
  };
  const previousCurrentRunId = currentProvisioningRunIdByTeam[progress.teamName];
  const replacesPendingRun =
    previousCurrentRunId != null &&
    isPendingProvisioningRunId(previousCurrentRunId) &&
    !isPendingProvisioningRunId(progress.runId);
  const isCanonicalRun =
    !previousCurrentRunId || previousCurrentRunId === progress.runId || replacesPendingRun;

  if (!isCanonicalRun) {
    if (!(progress.runId in state.provisioningRuns)) {
      return { kind: 'ignored' };
    }
    delete provisioningRuns[progress.runId];
    return {
      kind: 'stale-run-removed',
      stateUpdate: { provisioningRuns },
    };
  }

  if (replacesPendingRun && previousCurrentRunId) {
    delete provisioningRuns[previousCurrentRunId];
  }
  currentProvisioningRunIdByTeam[progress.teamName] = progress.runId;
  provisioningRuns[progress.runId] = progress;
  for (const [runId, run] of Object.entries(provisioningRuns)) {
    if (runId !== progress.runId && run.teamName === progress.teamName) {
      delete provisioningRuns[runId];
    }
  }

  const provisioningErrorByTeam = { ...state.provisioningErrorByTeam };
  if (progress.state === 'failed') {
    provisioningErrorByTeam[progress.teamName] = progress.error ?? progress.message;
  } else {
    delete provisioningErrorByTeam[progress.teamName];
  }

  const provisioningSnapshotByTeam =
    progress.state === 'failed' || progress.state === 'cancelled'
      ? removeTeamSnapshot(state.provisioningSnapshotByTeam, progress.teamName)
      : state.provisioningSnapshotByTeam;

  return {
    becameConfigReady: progress.configReady === true && existingProgress?.configReady !== true,
    existingProgress,
    kind: 'canonical-progress',
    stateUpdate: {
      provisioningRuns,
      currentProvisioningRunIdByTeam,
      currentRuntimeRunIdByTeam: {
        ...state.currentRuntimeRunIdByTeam,
        [progress.teamName]: progress.runId,
      },
      provisioningErrorByTeam,
      provisioningSnapshotByTeam,
    },
  };
}

function isPendingProvisioningRunId(runId: string): boolean {
  return runId.startsWith('pending:');
}

function removeTeamSnapshot(
  snapshots: Record<string, TeamSummary>,
  teamName: string
): Record<string, TeamSummary> {
  const next = { ...snapshots };
  delete next[teamName];
  return next;
}

function stringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || left.length !== right?.length) return false;
  return left.every((value, index) => value === right[index]);
}

function launchDiagnosticsEqual(
  left: readonly TeamLaunchDiagnosticItem[] | undefined,
  right: readonly TeamLaunchDiagnosticItem[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || left.length !== right?.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      item.id === other?.id &&
      item.memberName === other.memberName &&
      item.severity === other.severity &&
      item.code === other.code &&
      item.label === other.label &&
      item.detail === other.detail &&
      item.observedAt === other.observedAt
    );
  });
}

function provisioningProgressPayloadEqual(
  left: TeamProvisioningProgress,
  right: TeamProvisioningProgress
): boolean {
  return (
    left.runId === right.runId &&
    left.teamName === right.teamName &&
    left.state === right.state &&
    left.message === right.message &&
    left.messageSeverity === right.messageSeverity &&
    left.startedAt === right.startedAt &&
    left.pid === right.pid &&
    left.error === right.error &&
    left.cliLogsTail === right.cliLogsTail &&
    left.assistantOutput === right.assistantOutput &&
    left.configReady === right.configReady &&
    stringArraysEqual(left.warnings, right.warnings) &&
    launchDiagnosticsEqual(left.launchDiagnostics, right.launchDiagnostics)
  );
}
