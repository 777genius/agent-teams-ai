import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningRuntimeStateProjection,
  type TeamProvisioningRuntimeStateProjectionRun,
} from '../TeamProvisioningRuntimeStateProjection';

import type { TeamProvisioningProgress, TeamRuntimeState } from '@shared/types';

function progress(
  runId: string,
  teamName: string,
  state: TeamProvisioningProgress['state'] = 'ready'
): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state,
    message: `${state} message`,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

function run(
  runId: string,
  teamName: string,
  options: Partial<
    Pick<TeamProvisioningRuntimeStateProjectionRun, 'child' | 'processKilled' | 'cancelRequested'>
  > = {}
): TeamProvisioningRuntimeStateProjectionRun {
  return {
    runId,
    child: {},
    processKilled: false,
    cancelRequested: false,
    progress: progress(runId, teamName),
    ...options,
  };
}

function createProjection(
  input: {
    provisioningRunByTeam?: Map<string, string>;
    aliveRunByTeam?: Map<string, string>;
    runs?: Map<string, TeamProvisioningRuntimeStateProjectionRun>;
    runtimeAdapterRunByTeam?: Map<string, { runId: string; providerId: 'opencode' }>;
    runtimeAdapterProgressByRunId?: Map<string, TeamProvisioningProgress>;
    retainedProgressByRunId?: Map<string, TeamProvisioningProgress>;
    secondaryRuntimeTeams?: Set<string>;
    bootstrapStateByTeam?: Map<string, TeamRuntimeState>;
  } = {}
) {
  const provisioningRunByTeam = input.provisioningRunByTeam ?? new Map<string, string>();
  const aliveRunByTeam = input.aliveRunByTeam ?? new Map<string, string>();
  const retainedProgressByRunId =
    input.retainedProgressByRunId ?? new Map<string, TeamProvisioningProgress>();
  const bootstrapStateByTeam = input.bootstrapStateByTeam ?? new Map<string, TeamRuntimeState>();
  const readBootstrapRuntimeState = vi.fn(async (teamName: string) => {
    return bootstrapStateByTeam.get(teamName) ?? null;
  });

  return {
    projection: new TeamProvisioningRuntimeStateProjection({
      state: {
        provisioningRunByTeam,
        runs: input.runs ?? new Map<string, TeamProvisioningRuntimeStateProjectionRun>(),
        runtimeAdapterRunByTeam:
          input.runtimeAdapterRunByTeam ??
          new Map<string, { runId: string; providerId: 'opencode' }>(),
        runtimeAdapterProgressByRunId:
          input.runtimeAdapterProgressByRunId ?? new Map<string, TeamProvisioningProgress>(),
        getRetainedProvisioningProgressMap: () => retainedProgressByRunId,
      },
      ports: {
        getAliveRunId: (teamName) => aliveRunByTeam.get(teamName) ?? null,
        getTrackedRunId: (teamName) =>
          provisioningRunByTeam.get(teamName) ?? aliveRunByTeam.get(teamName) ?? null,
        getAliveTeamNames: () => [...aliveRunByTeam.keys()],
        hasSecondaryRuntimeRuns: (teamName) => input.secondaryRuntimeTeams?.has(teamName) ?? false,
        readBootstrapRuntimeState,
      },
    }),
    readBootstrapRuntimeState,
  };
}

describe('TeamProvisioningRuntimeStateProjection', () => {
  it('reports active provisioning and child process runs', async () => {
    const teamName = 'child-team';
    const runId = 'run-child';
    const { projection } = createProjection({
      provisioningRunByTeam: new Map([[teamName, runId]]),
      aliveRunByTeam: new Map([[teamName, runId]]),
      runs: new Map([[runId, run(runId, teamName)]]),
    });

    expect(projection.hasProvisioningRun(teamName)).toBe(true);
    expect(projection.isTeamAlive(teamName)).toBe(true);
    await expect(projection.getRuntimeState(teamName)).resolves.toEqual({
      teamName,
      isAlive: true,
      runId,
      progress: progress(runId, teamName),
    });
  });

  it('treats runtime-adapter teams as alive when no local run exists', () => {
    const teamName = 'adapter-team';
    const runId = 'run-adapter';
    const { projection } = createProjection({
      aliveRunByTeam: new Map([[teamName, runId]]),
      runtimeAdapterRunByTeam: new Map([[teamName, { runId, providerId: 'opencode' }]]),
    });

    expect(projection.isTeamAlive(teamName)).toBe(true);
  });

  it('treats secondary runtime runs as keeping the team alive without a child process', () => {
    const teamName = 'secondary-team';
    const runId = 'run-secondary';
    const { projection } = createProjection({
      aliveRunByTeam: new Map([[teamName, runId]]),
      runs: new Map([[runId, run(runId, teamName, { child: null })]]),
      secondaryRuntimeTeams: new Set([teamName]),
    });

    expect(projection.isTeamAlive(teamName)).toBe(true);
  });

  it('reports cancelled and killed runs as not alive', () => {
    const cancelledTeamName = 'cancelled-team';
    const cancelledRunId = 'run-cancelled';
    const killedTeamName = 'killed-team';
    const killedRunId = 'run-killed';
    const { projection } = createProjection({
      aliveRunByTeam: new Map([
        [cancelledTeamName, cancelledRunId],
        [killedTeamName, killedRunId],
      ]),
      runs: new Map([
        [cancelledRunId, run(cancelledRunId, cancelledTeamName, { cancelRequested: true })],
        [killedRunId, run(killedRunId, killedTeamName, { processKilled: true })],
      ]),
      secondaryRuntimeTeams: new Set([cancelledTeamName, killedTeamName]),
    });

    expect(projection.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(projection.isTeamAlive(killedTeamName)).toBe(false);
  });

  it('filters getAliveTeams through current liveness', () => {
    const liveTeamName = 'live-team';
    const liveRunId = 'run-live';
    const staleTeamName = 'stale-team';
    const staleRunId = 'run-stale';
    const adapterTeamName = 'adapter-team';
    const adapterRunId = 'run-adapter';
    const { projection } = createProjection({
      aliveRunByTeam: new Map([
        [liveTeamName, liveRunId],
        [staleTeamName, staleRunId],
        [adapterTeamName, adapterRunId],
      ]),
      runs: new Map([
        [liveRunId, run(liveRunId, liveTeamName)],
        [staleRunId, run(staleRunId, staleTeamName, { child: null })],
      ]),
      runtimeAdapterRunByTeam: new Map([
        [adapterTeamName, { runId: adapterRunId, providerId: 'opencode' }],
      ]),
    });

    expect(projection.getAliveTeams()).toEqual([liveTeamName, adapterTeamName]);
  });

  it('falls back to retained progress when no live run or adapter progress exists', async () => {
    const teamName = 'retained-team';
    const runId = 'run-retained';
    const retainedProgress = progress(runId, teamName, 'failed');
    const { projection, readBootstrapRuntimeState } = createProjection({
      provisioningRunByTeam: new Map([[teamName, runId]]),
      retainedProgressByRunId: new Map([[runId, retainedProgress]]),
    });

    await expect(projection.getRuntimeState(teamName)).resolves.toEqual({
      teamName,
      isAlive: false,
      runId,
      progress: retainedProgress,
    });
    expect(readBootstrapRuntimeState).toHaveBeenCalledWith(teamName);
  });

  it('returns bootstrap runtime state when no local run exists', async () => {
    const teamName = 'bootstrap-team';
    const recovered: TeamRuntimeState = {
      teamName,
      isAlive: true,
      runId: 'run-bootstrap',
      progress: progress('run-bootstrap', teamName),
    };
    const { projection, readBootstrapRuntimeState } = createProjection({
      bootstrapStateByTeam: new Map([[teamName, recovered]]),
    });

    await expect(projection.getRuntimeState(teamName)).resolves.toBe(recovered);
    expect(readBootstrapRuntimeState).toHaveBeenCalledWith(teamName);
  });
});
