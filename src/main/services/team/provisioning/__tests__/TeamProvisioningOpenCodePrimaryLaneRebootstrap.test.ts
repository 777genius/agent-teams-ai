import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodePrimaryLaneRebootstrapPorts,
  rebootstrapOpenCodeAggregatePrimaryLane,
} from '../TeamProvisioningOpenCodePrimaryLaneRebootstrap';

import { buildUncommittedPrimaryLeadLaunchResult } from './support/openCodeUncommittedPrimaryLane';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { TeamCreateRequest } from '@shared/types';

const TEAM_NAME = 'lane-team';
const REASON = 'opencode_primary_lane_bootstrap_missing';

const run = {
  runId: 'run-a1',
  teamName: TEAM_NAME,
  request: { teamName: TEAM_NAME, cwd: '/repo', model: 'default-model' } as TeamCreateRequest,
  effectiveMembers: [{ name: 'team-lead', role: 'Team Lead', providerId: 'opencode' }],
} as never;

function createPorts(overrides: Partial<OpenCodePrimaryLaneRebootstrapPorts> = {}): {
  ports: OpenCodePrimaryLaneRebootstrapPorts;
  calls: string[];
} {
  const calls: string[] = [];
  const ports: OpenCodePrimaryLaneRebootstrapPorts = {
    getAdapter: () => ({}) as TeamLaunchRuntimeAdapter,
    resolveActiveRun: () => run,
    hasManualRestartInFlight: () => false,
    hasPrimaryStopInFlight: () => false,
    isStopped: async () => false,
    getStopAllTeamsGeneration: () => 0,
    getStopTeamGeneration: () => 0,
    canDeliverToOpenCodeRuntime: () => true,
    stopOpenCodeRuntimeAdapterTeam: async () => {
      calls.push('stopPrimary');
    },
    setAliveRunId: () => {
      calls.push('setAliveRunId');
    },
    launchOpenCodeAggregatePrimaryLane: async () => {
      calls.push('launchPrimary');
      return buildUncommittedPrimaryLeadLaunchResult();
    },
    hasCommittedLeadSessionEvidence: async () => true,
    persistLaunchStateSnapshot: async () => {
      calls.push('persistLaunchState');
      return null;
    },
    getMixedSecondaryLaunchPhase: () => 'finished',
    beginRebootstrapLease: () => ({
      lease: {},
      release: () => {
        calls.push('releaseLease');
      },
    }),
    publishPending: () => calls.push('publishPending'),
    publishReady: () => calls.push('publishReady'),
    publishFailed: () => calls.push('publishFailed'),
    logWarn: () => undefined,
    resolveLeadName: () => 'team-lead',
    ...overrides,
  };
  return { ports, calls };
}

describe('rebootstrapOpenCodeAggregatePrimaryLane refusal gates', () => {
  const refusals: [string, Partial<OpenCodePrimaryLaneRebootstrapPorts>, string][] = [
    [
      'a manual restart holds the lease',
      { hasManualRestartInFlight: () => true },
      'manual_restart_in_flight',
    ],
    [
      'a primary stop is in flight',
      { hasPrimaryStopInFlight: () => true },
      'primary_stop_in_flight',
    ],
    ['the stop marker is set', { isStopped: async () => true }, 'team_stopped'],
    [
      'the runtime is not deliverable',
      { canDeliverToOpenCodeRuntime: () => false },
      'runtime_not_deliverable',
    ],
    ['there is no active run', { resolveActiveRun: () => null }, 'no_active_run'],
    ['the adapter is gone', { getAdapter: () => null }, 'adapter_unavailable'],
  ];

  for (const [label, override, refusal] of refusals) {
    it(`refuses when ${label}`, async () => {
      const { ports, calls } = createPorts(override);

      const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
        { teamName: TEAM_NAME, reason: REASON },
        ports
      );

      expect(outcome).toEqual({ rebootstrapped: false, refusal });
      expect(calls).not.toContain('stopPrimary');
      expect(calls).not.toContain('launchPrimary');
    });
  }

  it('refuses when the stop generation changes before the first stop', async () => {
    let generation = 0;
    const { ports, calls } = createPorts({
      getStopTeamGeneration: () => generation,
      publishPending: () => {
        calls.push('publishPending');
        generation = 1;
      },
    });

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome.refusal).toBe('stop_generation_changed');
    expect(calls).not.toContain('stopPrimary');
    expect(calls).toContain('releaseLease');
  });
});

describe('rebootstrapOpenCodeAggregatePrimaryLane happy path', () => {
  it('stops the primary lane, relaunches it and persists, in that order', async () => {
    const { ports, calls } = createPorts();

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome).toEqual({ rebootstrapped: true });
    expect(calls).toEqual([
      'publishPending',
      'stopPrimary',
      'setAliveRunId',
      'launchPrimary',
      'persistLaunchState',
      'setAliveRunId',
      'publishReady',
      'releaseLease',
    ]);
  });

  it('does not claim success when the relaunch still has no committed lead session', async () => {
    const { ports, calls } = createPorts({ hasCommittedLeadSessionEvidence: async () => false });

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome).toEqual({ rebootstrapped: false, refusal: 'lead_evidence_still_missing' });
    expect(calls).toContain('publishFailed');
    expect(calls).not.toContain('publishReady');
    expect(calls).toContain('releaseLease');
  });

  it('releases the lease when the relaunch throws', async () => {
    const { ports, calls } = createPorts({
      launchOpenCodeAggregatePrimaryLane: async () => {
        throw new Error('relaunch exploded');
      },
    });

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome).toEqual({ rebootstrapped: false, refusal: 'relaunch_failed' });
    expect(calls).toContain('releaseLease');
  });

  /**
   * The tracker fires the re-bootstrap fire-and-forget, so a Stop can land while
   * the relaunch is in flight. The relaunch still resolves and creates a host; a
   * refusal that returned without a stop would leave that host running on a team
   * the user believes is stopped, with `setAliveRunId` pointing at the run.
   */
  it('reaps the freshly launched host when a stop lands mid-relaunch', async () => {
    let generation = 0;
    const aliveRuns = new Map<string, string>();
    const { ports, calls } = createPorts({
      getStopTeamGeneration: () => generation,
      setAliveRunId: (teamName, runId) => {
        calls.push('setAliveRunId');
        aliveRuns.set(teamName, runId);
      },
      // Mirrors the production stop: it reaps the lane, clears its storage and
      // drops the alive run id.
      stopOpenCodeRuntimeAdapterTeam: async (teamName) => {
        calls.push('stopPrimary');
        aliveRuns.delete(teamName);
      },
      launchOpenCodeAggregatePrimaryLane: async () => {
        calls.push('launchPrimary');
        generation = 1;
        return buildUncommittedPrimaryLeadLaunchResult();
      },
    });

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome).toEqual({ rebootstrapped: false, refusal: 'stop_generation_changed' });
    expect(calls).toEqual([
      'publishPending',
      'stopPrimary',
      'setAliveRunId',
      'launchPrimary',
      'stopPrimary',
      'releaseLease',
    ]);
    expect(aliveRuns.size).toBe(0);
  });

  it('reaps the relaunched host when the lead evidence is still missing', async () => {
    const { ports, calls } = createPorts({ hasCommittedLeadSessionEvidence: async () => false });

    await rebootstrapOpenCodeAggregatePrimaryLane({ teamName: TEAM_NAME, reason: REASON }, ports);

    expect(calls.filter((call) => call === 'stopPrimary')).toHaveLength(2);
    expect(calls.indexOf('publishFailed')).toBeGreaterThan(calls.lastIndexOf('stopPrimary'));
  });

  it('still refuses when the mid-flight cleanup stop itself fails', async () => {
    let generation = 0;
    const { ports, calls } = createPorts({
      getStopTeamGeneration: () => generation,
      stopOpenCodeRuntimeAdapterTeam: async () => {
        calls.push('stopPrimary');
        if (generation === 1) throw new Error('stop exploded');
      },
      launchOpenCodeAggregatePrimaryLane: async () => {
        calls.push('launchPrimary');
        generation = 1;
        return buildUncommittedPrimaryLeadLaunchResult();
      },
    });

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome).toEqual({ rebootstrapped: false, refusal: 'stop_generation_changed' });
    expect(calls).toContain('releaseLease');
  });

  it('refuses once the lease itself is cancelled', async () => {
    const lease = { lease: { cancelRequested: false }, release: vi.fn() };
    const { ports, calls } = createPorts({
      beginRebootstrapLease: () => lease,
      publishPending: () => {
        calls.push('publishPending');
        lease.lease.cancelRequested = true;
      },
    });

    const outcome = await rebootstrapOpenCodeAggregatePrimaryLane(
      { teamName: TEAM_NAME, reason: REASON },
      ports
    );

    expect(outcome.refusal).toBe('stop_generation_changed');
    expect(calls).not.toContain('stopPrimary');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
