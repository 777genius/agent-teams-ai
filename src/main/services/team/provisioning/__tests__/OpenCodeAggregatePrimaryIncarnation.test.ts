import { describe, expect, it, vi } from 'vitest';

import {
  advanceOpenCodePrimaryIncarnation,
  captureRetainedSecondaryDelivery,
  createAggregatePrimaryRestartFailure,
  createAggregatePrimaryRestoredRestartFailure,
  retainSecondaryAggregateOwnership,
} from '../OpenCodeAggregatePrimaryIncarnation';
import { OpenCodeAggregatePrimaryProgressPublisher } from '../OpenCodeAggregatePrimaryProgressPublisher';
import { createOpenCodeAggregateProvisioningRun } from '../TeamProvisioningOpenCodeAggregateRun';

import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { OpenCodeAggregatePrimaryRestartLease } from '../TeamProvisioningServiceMemberLifecycleFacade';

function fixture() {
  const lead = { name: 'team-lead', providerId: 'opencode' as const, role: 'lead' };
  const run = createOpenCodeAggregateProvisioningRun({
    runId: 'TEST-stopped',
    startedAt: '2026-09-10T00:00:00Z',
    progress: {
      runId: 'TEST-stopped',
      teamName: 'TEST-team',
      state: 'ready',
      message: 'Ready',
      startedAt: '',
      updatedAt: '',
    },
    request: {
      teamName: 'TEST-team',
      cwd: '/TEST/project',
      providerId: 'opencode',
      members: [lead],
    },
    members: [lead],
    lanePlan: {
      mode: 'pure_opencode_member_lanes',
      allMembers: [lead],
      primaryMembers: [lead],
      sideLanes: [],
    },
    onProgress: vi.fn(),
  }) as ProvisioningRun;
  const lease: OpenCodeAggregatePrimaryRestartLease = {
    runId: run.runId,
    teamName: run.teamName,
    memberName: 'worker',
    cancelRequested: false,
    completion: Promise.resolve(),
    precedingLifecycleOperations: [],
  };
  const runs = new Map([[run.runId, run]]);
  const provisioningRunByTeam = new Map([[run.teamName, run.runId]]);
  let alive = run.runId;
  const ports = {
    runs,
    provisioningRunByTeam,
    getRuntimeOwner: vi.fn<() => object | undefined>(() => undefined),
    getAliveRunId: () => alive,
    setAliveRunId: (_team: string, id: string) => {
      alive = id;
    },
  };
  return { run, lease, ports };
}

describe('OpenCode aggregate primary incarnation handoff', () => {
  it('retires the stopped lookup and resets only primary session/liveness evidence', () => {
    const { run, lease, ports } = fixture();
    run.detectedSessionId = 'ses_TEST_stopped';
    run.memberSpawnStatuses.set('team-lead', {
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      updatedAt: '',
    });
    const secondary = {
      status: 'online' as const,
      launchState: 'confirmed_alive' as const,
      runtimeAlive: true,
      updatedAt: '',
    };
    run.memberSpawnStatuses.set('secondary', secondary);
    run.progress.retainedSecondaryRuntime = true;
    advanceOpenCodePrimaryIncarnation(run, lease, ports);
    expect(run.progress.retainedSecondaryRuntime).toBeUndefined();
    expect(run.runId).not.toBe('TEST-stopped');
    expect(ports.runs.has('TEST-stopped')).toBe(false);
    expect(ports.runs.get(run.runId)).toBe(run);
    expect(ports.provisioningRunByTeam.get(run.teamName)).toBe(run.runId);
    expect(ports.getAliveRunId()).toBe(run.runId);
    expect(lease.runId).toBe('TEST-stopped');
    expect(lease.candidateRunId).toBe(run.runId);
    expect(run.detectedSessionId).toBeNull();
    expect(run.memberSpawnStatuses.get('team-lead')).toMatchObject({
      runtimeAlive: false,
      bootstrapConfirmed: false,
    });
    expect(run.memberSpawnStatuses.get('secondary')).toBe(secondary);
  });

  it.each([
    'cancelled',
    'killed',
    'replaced-run',
    'runtime-owner',
    'tracked-owner',
    'alive-owner',
    'lease-run',
    'lease-team',
  ])('rejects %s before mutating any ownership', (kind) => {
    const { run, lease, ports } = fixture();
    if (kind === 'lease-run') lease.candidateRunId = 'TEST-newer';
    if (kind === 'lease-team') lease.teamName = 'TEST-other-team';
    const beforeCandidateRunId = lease.candidateRunId;
    if (kind === 'cancelled') lease.cancelRequested = true;
    if (kind === 'killed') run.processKilled = true;
    if (kind === 'replaced-run') ports.runs.set(run.runId, { ...run });
    if (kind === 'runtime-owner') ports.getRuntimeOwner.mockReturnValue({ runId: 'TEST-newer' });
    if (kind === 'tracked-owner') ports.provisioningRunByTeam.set(run.teamName, 'TEST-newer');
    if (kind === 'alive-owner') ports.setAliveRunId(run.teamName, 'TEST-newer');
    const beforeRuns = [...ports.runs];
    const beforeTracked = [...ports.provisioningRunByTeam];
    const beforeAlive = ports.getAliveRunId();
    expect(() => advanceOpenCodePrimaryIncarnation(run, lease, ports)).toThrow(
      'owning run is no longer active'
    );
    expect([...ports.runs]).toEqual(beforeRuns);
    expect([...ports.provisioningRunByTeam]).toEqual(beforeTracked);
    expect(ports.getAliveRunId()).toBe(beforeAlive);
    expect(run.runId).toBe('TEST-stopped');
    expect(lease.candidateRunId).toBe(beforeCandidateRunId);
  });
});

describe('retained secondary aggregate after primary failure', () => {
  it.each([
    'owned',
    'no-secondary',
    'cancelled',
    'replaced-lease',
    'other-tracked',
    'other-alive',
    'other-primary',
  ] as const)('retains cleanup authority only for the current secondary owner: %s', (scenario) => {
    const { run, lease } = fixture();
    const setAliveRunId = vi.fn();
    if (scenario === 'cancelled') lease.cancelRequested = true;
    retainSecondaryAggregateOwnership(run, lease, {
      mayRestore: () => scenario !== 'no-secondary',
      getRestartLease: () => (scenario === 'replaced-lease' ? { ...lease } : lease),
      getTrackedRunId: () => (scenario === 'other-tracked' ? 'TEST-replacement' : null),
      getRuntimeOwner: () => (scenario === 'other-primary' ? {} : undefined),
      getAliveRunId: () => (scenario === 'other-alive' ? 'TEST-replacement' : null),
      setAliveRunId,
    });
    if (scenario === 'owned') expect(setAliveRunId).toHaveBeenCalledWith(run.teamName, run.runId);
    else expect(setAliveRunId).not.toHaveBeenCalled();
  });
});

it.each(['owned', 'Stop', 'new lease', 'new owner', 'new secondary'])(
  'publishes retained restart outcome only from the same current ownership fact: %s',
  (scenario) => {
    const { run, lease, ports } = fixture();
    const lane = {
      laneId: 'secondary:opencode:bob',
      providerId: 'opencode' as const,
      member: { name: 'bob' },
      runId: 'secondary-run',
      state: 'finished' as const,
      result: null,
      warnings: [],
      diagnostics: [],
    };
    run.mixedSecondaryLanes = [lane];
    const owners = new Map([
      [
        lane.laneId,
        {
          laneId: lane.laneId,
          providerId: 'opencode' as const,
          runId: lane.runId,
          memberName: 'bob',
        },
      ],
    ]);
    let current = true;
    const retentionPorts = {
      ...ports,
      mayRestore: () => current,
      getRestartLease: () => lease,
      getTrackedRunId: () => run.runId,
      captureRetainedSecondaryDelivery: () => captureRetainedSecondaryDelivery(run, owners, 0, 0),
    };
    retainSecondaryAggregateOwnership(run, lease, retentionPorts);
    expect(run.retainedSecondaryDelivery?.ownerRunId).toBe(run.runId);
    if (scenario === 'Stop') current = false;
    if (scenario === 'new lease') lease.cancelRequested = true;
    if (scenario === 'new owner') retentionPorts.getTrackedRunId = () => 'replacement-owner';
    if (scenario === 'new secondary')
      owners.set(lane.laneId, { ...owners.get(lane.laneId)!, runId: 'replacement-lane' });
    const error = createAggregatePrimaryRestartFailure(
      run,
      lease,
      retentionPorts,
      'TEST failed primary'
    );
    expect(error.name).toBe(scenario === 'owned' ? 'OpenCodeRetainedPrimaryRestartError' : 'Error');
    const publisher = new OpenCodeAggregatePrimaryProgressPublisher({
      usesRetainedProgressState: () => true,
      setRuntimeAdapterProgress: (progress) => progress,
      enrichRuntimeAdapterProgressTrace: (progress) => progress,
      rememberProgress: vi.fn(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
    });
    publisher.publishFailed(run, 'Primary failed', error);
    expect(run.progress.state).toBe('failed');
    expect(run.progress.retainedSecondaryRuntime).toBe(scenario === 'owned' ? true : undefined);
    publisher.publishFailed(run, 'Ordinary failure', new Error('TEST ordinary failure'));
    expect(run.progress.retainedSecondaryRuntime).toBeUndefined();
    publisher.publishFailed(run, 'Primary failed', error);
    publisher.publishPending(run, 'Restarting');
    expect(run.progress.retainedSecondaryRuntime).toBeUndefined();
    publisher.publishFailed(run, 'Primary failed', error);
    publisher.publishReady(run, 'Recovered');
    expect(run.progress.retainedSecondaryRuntime).toBeUndefined();
  }
);

describe('restored primary restart failure authority', () => {
  it.each([
    'current',
    'stop-generation',
    'lease-replaced',
    'cancelled',
    'run-killed',
    'owner-missing',
    'owner-run',
    'owner-provider',
    'tracked-run',
    'alive-run',
    'not-ready',
    'candidate-run',
  ] as const)('publishes restored authority only for exact current ownership: %s', (scenario) => {
    const { run, lease, ports } = fixture();
    advanceOpenCodePrimaryIncarnation(run, lease, ports);
    run.progress = { ...run.progress, state: 'ready' };
    const owner = {
      runId: scenario === 'owner-run' ? 'foreign-run' : run.runId,
      providerId: scenario === 'owner-provider' ? 'codex' : 'opencode',
    };
    ports.getRuntimeOwner.mockReturnValue(scenario === 'owner-missing' ? undefined : owner);
    if (scenario === 'cancelled') lease.cancelRequested = true;
    if (scenario === 'run-killed') run.processKilled = true;
    if (scenario === 'not-ready') run.progress.state = 'failed';
    if (scenario === 'candidate-run') lease.candidateRunId = 'different-candidate';
    const error = createAggregatePrimaryRestoredRestartFailure(
      run,
      lease,
      {
        ...ports,
        isCurrent: () => scenario !== 'stop-generation',
        getRestartLease: () => (scenario === 'lease-replaced' ? { ...lease } : lease),
        getTrackedRunId: () => (scenario === 'tracked-run' ? 'foreign-run' : run.runId),
        getAliveRunId: () => (scenario === 'alive-run' ? 'foreign-run' : run.runId),
      },
      'original restart failure'
    );
    expect(error.message).toBe('original restart failure');
    if (scenario === 'current')
      expect(error).toMatchObject({
        outcome: 'failed_restored',
        retention: {
          predecessorRunId: lease.runId,
          successorRunId: run.runId,
          teamName: run.teamName,
          memberName: lease.memberName,
        },
      });
    else expect(error).not.toHaveProperty('retention');
  });
});
