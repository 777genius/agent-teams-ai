import { describe, expect, it, vi } from 'vitest';

import { advanceOpenCodePrimaryIncarnation } from '../OpenCodeAggregatePrimaryIncarnation';
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
    const secondary = { status: 'online' as const, launchState: 'confirmed_alive' as const, runtimeAlive: true, updatedAt: '' };
    run.memberSpawnStatuses.set('secondary', secondary);
    advanceOpenCodePrimaryIncarnation(run, lease, ports);
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
