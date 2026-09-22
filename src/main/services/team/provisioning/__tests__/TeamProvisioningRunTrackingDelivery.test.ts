import { describe, expect, it, vi } from 'vitest';

import {
  type RunTrackingProvisioningRun,
  TeamProvisioningRunTrackingDeliveryHelper,
} from '../TeamProvisioningRunTrackingDelivery';

import type { TeamProvisioningProgress } from '@shared/types';

function progress(
  state: TeamProvisioningProgress['state']
): Pick<TeamProvisioningProgress, 'state'> {
  return { state };
}

function run(
  state: TeamProvisioningProgress['state'],
  overrides: Partial<RunTrackingProvisioningRun> = {}
): RunTrackingProvisioningRun {
  return {
    progress: progress(state),
    processKilled: false,
    cancelRequested: false,
    ...overrides,
  };
}

function createHarness() {
  const state = {
    provisioningRunByTeam: new Map<string, string>(),
    aliveRunByTeam: new Map<string, string>(),
    runs: new Map<string, RunTrackingProvisioningRun>(),
    runtimeAdapterProgressByRunId: new Map<string, Pick<TeamProvisioningProgress, 'state'>>(),
    retainedProvisioningProgressByRunId: new Map<string, Pick<TeamProvisioningProgress, 'state'>>(),
    runtimeAdapterRunByTeam: new Map<string, { runId: string }>(),
  };
  const ports = {
    notifyTeamWatchScopeChanged: vi.fn(),
    isTeamAlive: vi.fn(() => false),
    hasAlivePersistedTeamProcess: vi.fn(() => false),
    hasOnlyExplicitlyStoppedPersistedTeamProcesses: vi.fn(() => false),
    logDebug: vi.fn(),
  };
  const helper = new TeamProvisioningRunTrackingDeliveryHelper({
    state: {
      ...state,
      getRetainedProvisioningProgressMap: () => state.retainedProvisioningProgressByRunId,
    },
    ports,
    liveRuntimeSnapshotCacheTtlMs: 2_000,
    persistedRuntimeSnapshotCacheTtlMs: 10_000,
  });
  return { helper, ports, state };
}

describe('TeamProvisioningRunTrackingDeliveryHelper', () => {
  it('tracks provisioning and alive run ids while notifying only when alive scope changes', () => {
    const { helper, ports, state } = createHarness();
    state.provisioningRunByTeam.set('team', 'run-provisioning');
    state.runs.set('run-provisioning', run('spawning'));

    expect(helper.getProvisioningRunId('team')).toBe('run-provisioning');
    expect(helper.getResolvableProvisioningRunId('team')).toBe('run-provisioning');
    expect(helper.getTrackedRunId('team')).toBe('run-provisioning');

    helper.setAliveRunId('team', 'run-alive');
    helper.setAliveRunId('team', 'run-alive');
    expect(helper.getAliveRunId('team')).toBe('run-alive');
    expect(helper.getAliveTeamNames()).toEqual(['team']);
    expect(ports.notifyTeamWatchScopeChanged).toHaveBeenCalledTimes(1);

    helper.deleteAliveRunId('team');
    helper.deleteAliveRunId('team');
    expect(helper.getAliveRunId('team')).toBeNull();
    expect(ports.notifyTeamWatchScopeChanged).toHaveBeenCalledTimes(2);
  });

  it('clears stale provisioning ids that no longer resolve to active or adapter progress', () => {
    const { helper, ports, state } = createHarness();
    state.provisioningRunByTeam.set('team', 'stale-run');

    expect(helper.getResolvableProvisioningRunId('team')).toBeNull();
    expect(state.provisioningRunByTeam.has('team')).toBe(false);
    expect(ports.logDebug).toHaveBeenCalledWith(
      '[team] Cleared stale provisioning run id before launch: stale-run'
    );

    state.provisioningRunByTeam.set('team', 'adapter-run');
    state.runtimeAdapterProgressByRunId.set('adapter-run', progress('validating'));
    expect(helper.getResolvableProvisioningRunId('team')).toBe('adapter-run');
  });

  it('does not report terminal adapter progress as an active provisioning run', () => {
    const { helper, ports, state } = createHarness();
    state.provisioningRunByTeam.set('team', 'failed-adapter-run');
    state.runtimeAdapterProgressByRunId.set('failed-adapter-run', progress('failed'));

    expect(helper.getResolvableProvisioningRunId('team')).toBeNull();
    expect(state.provisioningRunByTeam.has('team')).toBe(false);
    expect(ports.logDebug).toHaveBeenCalledWith(
      '[team] Cleared stale provisioning run id before launch: failed-adapter-run'
    );
  });

  it('uses live snapshot cache ttl for tracked or adapter-backed runs', () => {
    const { helper, state } = createHarness();

    expect(helper.getAgentRuntimeSnapshotCacheTtlMs('team', null)).toBe(10_000);

    state.runtimeAdapterRunByTeam.set('team', { runId: 'adapter-run' });
    expect(helper.getAgentRuntimeSnapshotCacheTtlMs('team', null)).toBe(2_000);
    expect(helper.getAgentRuntimeSnapshotCacheTtlMs('team', 'tracked-run')).toBe(2_000);
  });

  it('resolves the first tracked run that is still deliverable', () => {
    const { helper, state } = createHarness();
    state.provisioningRunByTeam.set('team', 'terminal-run');
    state.aliveRunByTeam.set('team', 'alive-run');
    state.runtimeAdapterRunByTeam.set('team', { runId: 'adapter-run' });
    state.runtimeAdapterProgressByRunId.set('terminal-run', progress('failed'));
    state.runs.set('alive-run', run('verifying'));

    expect(helper.canDeliverToTrackedRuntimeRun('team', 'terminal-run')).toBe(false);
    expect(helper.resolveDeliverableTrackedRuntimeRunId('team')).toBe('alive-run');

    state.runs.set('alive-run', run('verifying', { cancelRequested: true }));
    expect(helper.canDeliverToTrackedRuntimeRun('team', 'alive-run')).toBe(false);

    state.runtimeAdapterProgressByRunId.set('adapter-run', progress('spawning'));
    expect(helper.resolveDeliverableTrackedRuntimeRunId('team')).toBe('adapter-run');
  });

  it('requires deliverable runtime runs to be tracked by the team', () => {
    const { helper, state } = createHarness();
    state.provisioningRunByTeam.set('team', '   ');
    state.aliveRunByTeam.set('team', '');
    state.runtimeAdapterRunByTeam.set('team', { runId: 'adapter-run' });
    state.runtimeAdapterProgressByRunId.set('untracked-run', progress('spawning'));
    state.runtimeAdapterProgressByRunId.set('adapter-run', progress('spawning'));

    expect(helper.canDeliverToTrackedRuntimeRun('team', 'untracked-run')).toBe(false);
    expect(helper.resolveDeliverableTrackedRuntimeRunId('team')).toBe('adapter-run');
  });

  it('keeps retained terminal adapter progress non-deliverable after live progress eviction', () => {
    const { helper, state } = createHarness();
    state.runtimeAdapterRunByTeam.set('team', { runId: 'retained-run' });
    state.retainedProvisioningProgressByRunId.set('retained-run', progress('cancelled'));

    expect(helper.canDeliverToTrackedRuntimeRun('team', 'retained-run')).toBe(false);
    expect(helper.resolveDeliverableTrackedRuntimeRunId('team')).toBeNull();
  });

  it('allows delivery and committed-session recovery from live or persisted process evidence', () => {
    const { helper, ports } = createHarness();

    ports.hasAlivePersistedTeamProcess.mockReturnValueOnce(true);
    expect(helper.canDeliverToOpenCodeRuntimeForTeam('team')).toBe(true);

    ports.isTeamAlive.mockReturnValueOnce(true);
    expect(helper.canDeliverToOpenCodeRuntimeForTeam('team')).toBe(true);

    ports.hasOnlyExplicitlyStoppedPersistedTeamProcesses.mockReturnValueOnce(true);
    expect(helper.canAttemptCommittedOpenCodeSessionRecovery('team')).toBe(false);

    ports.hasOnlyExplicitlyStoppedPersistedTeamProcesses.mockReturnValueOnce(false);
    expect(helper.canAttemptCommittedOpenCodeSessionRecovery('team')).toBe(true);
  });

  it('does not let persisted process evidence bypass a tracked pending-stop state', () => {
    const { helper, ports, state } = createHarness();
    state.runtimeAdapterRunByTeam.set('team', { runId: 'pending-stop-run' });
    state.runtimeAdapterProgressByRunId.set('pending-stop-run', progress('disconnected'));
    ports.isTeamAlive.mockReturnValue(true);
    ports.hasAlivePersistedTeamProcess.mockReturnValue(true);

    expect(helper.canDeliverToTrackedRuntimeRun('team', 'pending-stop-run')).toBe(false);
    expect(helper.resolveDeliverableTrackedRuntimeRunId('team')).toBeNull();
    expect(helper.canDeliverToOpenCodeRuntimeForTeam('team')).toBe(false);
    expect(helper.canAttemptCommittedOpenCodeSessionRecovery('team')).toBe(false);
    expect(ports.isTeamAlive).not.toHaveBeenCalled();
    expect(ports.hasAlivePersistedTeamProcess).not.toHaveBeenCalled();
  });

  it('allows a newer deliverable owner to supersede old terminal progress', () => {
    const { helper, ports, state } = createHarness();
    state.provisioningRunByTeam.set('team', 'old-stopping-run');
    state.aliveRunByTeam.set('team', 'new-owner-run');
    state.runtimeAdapterProgressByRunId.set('old-stopping-run', progress('disconnected'));
    state.runs.set('new-owner-run', run('ready'));
    ports.isTeamAlive.mockReturnValue(true);

    expect(helper.resolveDeliverableTrackedRuntimeRunId('team')).toBe('new-owner-run');
    expect(helper.canDeliverToOpenCodeRuntimeForTeam('team')).toBe(true);
  });
});
