import { withKnownNoStartLaunchStatus } from './TeamProvisioningRosterLaunchOutcome';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
} from '../runtime';
import type { TeamCreateRequest, TeamLaunchRequest, TeamLaunchResponse } from '@shared/types';

export interface CancelledOpenCodeLaunchCleanupPorts {
  getRuntimeAdapterRun(teamName: string): { runId: string } | undefined;
  setRuntimeAdapterRun(
    teamName: string,
    runtimeRun: {
      runId: string;
      providerId: 'opencode';
      cwd: string;
      allowExperimentalLocalModels?: boolean;
      members: TeamRuntimeLaunchResult['members'];
    }
  ): void;
}

export interface CancelledOpenCodeLaunchFinishPorts extends CancelledOpenCodeLaunchCleanupPorts {
  consumeCancelledRuntimeAdapterRunId(runId: string): boolean;
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName: string, runId: string): Promise<boolean>;
}

export type CancelledOpenCodeLaunchDispatchState = 'not_dispatched' | 'dispatched';

export async function finishCancelledOpenCodeRuntimeAdapterLaunch(input: {
  ports: CancelledOpenCodeLaunchFinishPorts;
  teamName: string;
  runId: string;
  request: Pick<TeamCreateRequest | TeamLaunchRequest, 'rosterLaunchBinding'>;
  dispatchState: CancelledOpenCodeLaunchDispatchState;
  cleanupInvokedRuntime?: () => Promise<boolean>;
}): Promise<TeamLaunchResponse> {
  const cancellationWasRecorded = input.ports.consumeCancelledRuntimeAdapterRunId(input.runId);
  if (input.dispatchState === 'not_dispatched') {
    // The provider command is proven absent. Clear only exact attempt linkage;
    // a newer run remains fenced by the injected ownership boundary.
    await input.ports
      .clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input.teamName, input.runId)
      .catch(() => false);
    return withKnownNoStartLaunchStatus(input.request, { runId: input.runId });
  }

  if (cancellationWasRecorded && input.ports.getRuntimeAdapterRun(input.teamName) === undefined) {
    return withKnownNoStartLaunchStatus(input.request, { runId: input.runId });
  }

  const runtimeStopped = input.cleanupInvokedRuntime ? await input.cleanupInvokedRuntime() : false;
  if (!runtimeStopped) return { runId: input.runId };

  const linkageCleared = await input.ports
    .clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input.teamName, input.runId)
    .catch(() => false);
  if (linkageCleared) {
    return withKnownNoStartLaunchStatus(input.request, { runId: input.runId });
  }
  return { runId: input.runId };
}

export function publishInvokingOpenCodeRuntimeOwnership(
  ports: CancelledOpenCodeLaunchCleanupPorts,
  launchInput: TeamRuntimeLaunchInput
): void {
  const current = ports.getRuntimeAdapterRun(launchInput.teamName);
  if (current && current.runId !== launchInput.runId) return;
  ports.setRuntimeAdapterRun(launchInput.teamName, {
    runId: launchInput.runId,
    providerId: 'opencode',
    cwd: launchInput.cwd,
    ...(launchInput.allowExperimentalLocalModels === true
      ? { allowExperimentalLocalModels: true }
      : {}),
    members: {},
  });
}

export function bindRuntimeModels(
  members: TeamRuntimeLaunchResult['members'],
  launchInput: TeamRuntimeLaunchInput
): TeamRuntimeLaunchResult['members'] {
  const expectedByName = new Map(
    launchInput.expectedMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  return Object.fromEntries(
    Object.entries(members).map(([name, evidence]) => [
      name,
      {
        ...evidence,
        model: evidence.model ?? expectedByName.get(name.trim().toLowerCase())?.model,
      },
    ])
  );
}

/** Stops an invoked attempt, retaining exact ownership when stop is uncertain. */
export async function cleanupCancelledOpenCodeRuntimeAdapterLaunch(input: {
  adapter: TeamLaunchRuntimeAdapter;
  ports: CancelledOpenCodeLaunchCleanupPorts;
  runId: string;
  teamName: string;
  cwd: string;
  allowExperimentalLocalModels?: boolean;
  launchInput: TeamRuntimeLaunchInput;
  launchResult: TeamRuntimeLaunchResult | null;
}): Promise<boolean> {
  let stopped = false;
  try {
    stopped = (
      await input.adapter.stop({
        runId: input.runId,
        teamName: input.teamName,
        laneId: 'primary',
        cwd: input.cwd,
        providerId: 'opencode',
        reason: 'cleanup',
        force: true,
        previousLaunchState: input.launchInput.previousLaunchState,
      })
    ).stopped;
  } catch {
    // Preserve attempt ownership below when cleanup is uncertain.
  }
  const current = input.ports.getRuntimeAdapterRun(input.teamName);
  if (!stopped && input.launchResult && (!current || current.runId === input.runId)) {
    input.ports.setRuntimeAdapterRun(input.teamName, {
      runId: input.runId,
      providerId: 'opencode',
      cwd: input.cwd,
      ...(input.allowExperimentalLocalModels === true
        ? { allowExperimentalLocalModels: true }
        : {}),
      members: bindRuntimeModels(input.launchResult.members, input.launchInput),
    });
  }
  return stopped;
}
