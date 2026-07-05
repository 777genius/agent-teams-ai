import { describe, expect, it, vi } from 'vitest';

import {
  getLeadActivityStateForTeam,
  getLeadTaskActivityRunKey,
  type LeadActivityRunLike,
  setLeadActivity,
  type SetLeadActivityPorts,
  syncLeadTaskActivityForState,
} from '../TeamProvisioningLeadActivity';

function createPorts(
  syncedRunKeys = new Set<string>(),
  current = true
): SetLeadActivityPorts<LeadActivityRunLike> {
  return {
    syncedRunKeys,
    getRunLeadName: () => 'lead',
    resumeActiveIntervalsForMember: vi.fn().mockReturnValue({ changedTasks: 1 }),
    pauseActiveIntervalsForMember: vi.fn().mockReturnValue({ changedTasks: 1 }),
    isCurrentTrackedRun: () => current,
    nowIso: () => '2026-05-02T10:05:00.000Z',
    emitTeamChange: vi.fn(),
  };
}

describe('lead activity helpers', () => {
  it('returns offline when no run is tracked', () => {
    expect(
      getLeadActivityStateForTeam('team-a', {
        getTrackedRunId: () => null,
        getRun: () => undefined,
        getRuntimeAdapterRun: () => null,
        getRuntimeAdapterProgress: () => null,
        syncLeadTaskActivityForState: vi.fn(),
      })
    ).toEqual({ state: 'offline', runId: null });
  });

  it('returns idle for a non-terminal runtime-adapter run without an in-memory run', () => {
    expect(
      getLeadActivityStateForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => undefined,
        getRuntimeAdapterRun: () => ({ runId: 'run-1' }),
        getRuntimeAdapterProgress: () => ({ state: 'running' }),
        syncLeadTaskActivityForState: vi.fn(),
      })
    ).toEqual({ state: 'idle', runId: 'run-1' });
  });

  it('returns offline for terminal runtime-adapter progress without an in-memory run', () => {
    expect(
      getLeadActivityStateForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => undefined,
        getRuntimeAdapterRun: () => ({ runId: 'run-1' }),
        getRuntimeAdapterProgress: () => ({ state: 'failed' }),
        syncLeadTaskActivityForState: vi.fn(),
      })
    ).toEqual({ state: 'offline', runId: null });
  });

  it('returns offline for killed or cancelled in-memory runs', () => {
    const baseRun = {
      teamName: 'team-a',
      runId: 'run-1',
      leadActivityState: 'active' as const,
      processKilled: false,
      cancelRequested: true,
    };

    expect(
      getLeadActivityStateForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => baseRun,
        getRuntimeAdapterRun: () => null,
        getRuntimeAdapterProgress: () => null,
        syncLeadTaskActivityForState: vi.fn(),
      })
    ).toEqual({ state: 'offline', runId: null });

    expect(
      getLeadActivityStateForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => ({ ...baseRun, cancelRequested: false, processKilled: true }),
        getRuntimeAdapterRun: () => null,
        getRuntimeAdapterProgress: () => null,
        syncLeadTaskActivityForState: vi.fn(),
      })
    ).toEqual({ state: 'offline', runId: null });
  });

  it('read-repairs task activity before returning active in-memory state', () => {
    const run = {
      teamName: 'team-a',
      runId: 'run-1',
      leadActivityState: 'active' as const,
      processKilled: false,
      cancelRequested: false,
    };
    const syncLeadTaskActivityForState = vi.fn();

    expect(
      getLeadActivityStateForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => run,
        getRuntimeAdapterRun: () => null,
        getRuntimeAdapterProgress: () => null,
        syncLeadTaskActivityForState,
      })
    ).toEqual({ state: 'active', runId: 'run-1' });
    expect(syncLeadTaskActivityForState).toHaveBeenCalledWith(run, 'active', 'active');
  });

  it('builds a stable task activity key from team and run ids', () => {
    expect(getLeadTaskActivityRunKey({ teamName: 'team-a', runId: 'run-1' })).toBe(
      'team-a\u0000run-1'
    );
  });

  it('resumes and pauses active task intervals once per run key', () => {
    const run = { teamName: 'team-a', runId: 'run-1', leadActivityState: 'idle' as const };
    const ports = createPorts();

    syncLeadTaskActivityForState(run, 'active', 'idle', ports, '2026-05-02T10:00:00.000Z');
    syncLeadTaskActivityForState(run, 'active', 'active', ports, '2026-05-02T10:00:01.000Z');
    syncLeadTaskActivityForState(run, 'idle', 'active', ports, '2026-05-02T10:00:02.000Z');

    expect(ports.resumeActiveIntervalsForMember).toHaveBeenCalledTimes(1);
    expect(ports.resumeActiveIntervalsForMember).toHaveBeenCalledWith(
      'team-a',
      'lead',
      '2026-05-02T10:00:00.000Z'
    );
    expect(ports.pauseActiveIntervalsForMember).toHaveBeenCalledTimes(1);
    expect(ports.pauseActiveIntervalsForMember).toHaveBeenCalledWith(
      'team-a',
      'lead',
      '2026-05-02T10:00:02.000Z'
    );
    expect(ports.syncedRunKeys.has(getLeadTaskActivityRunKey(run))).toBe(false);
  });

  it('updates current run state and emits lead activity changes', () => {
    const run: LeadActivityRunLike = {
      teamName: 'team-a',
      runId: 'run-1',
      leadActivityState: 'idle',
    };
    const ports = createPorts();

    setLeadActivity(run, 'active', ports);
    setLeadActivity(run, 'active', ports);

    expect(run.leadActivityState).toBe('active');
    expect(ports.emitTeamChange).toHaveBeenCalledTimes(1);
    expect(ports.emitTeamChange).toHaveBeenCalledWith({
      type: 'lead-activity',
      teamName: 'team-a',
      runId: 'run-1',
      detail: 'active',
    });
    expect(ports.resumeActiveIntervalsForMember).toHaveBeenCalledTimes(1);
  });

  it('does not pause intervals or emit changes for stale runs', () => {
    const run: LeadActivityRunLike = {
      teamName: 'team-a',
      runId: 'run-stale',
      leadActivityState: 'active',
    };
    const syncedRunKeys = new Set([getLeadTaskActivityRunKey(run)]);
    const ports = createPorts(syncedRunKeys, false);

    setLeadActivity(run, 'offline', ports);

    expect(run.leadActivityState).toBe('offline');
    expect(ports.pauseActiveIntervalsForMember).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
    expect(syncedRunKeys.has(getLeadTaskActivityRunKey(run))).toBe(false);
  });
});
