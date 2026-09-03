import { describe, expect, it, vi } from 'vitest';

import {
  assertOpenCodeRuntimeStopEffective,
  collectOpenCodeLaneRuntimePids,
  describeOpenCodeRuntimeStopResult,
  resolveOpenCodeRuntimeStopOutcome,
} from '../TeamProvisioningOpenCodeRuntimeStopOutcome';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

function snapshot(
  members: Record<string, { laneId?: string; laneKind?: string; runtimePid?: number }>
): PersistedTeamLaunchSnapshot {
  return {
    members: Object.fromEntries(
      Object.entries(members).map(([name, member]) => [
        name,
        { name, providerId: 'opencode', ...member },
      ])
    ),
  } as unknown as PersistedTeamLaunchSnapshot;
}

describe('collectOpenCodeLaneRuntimePids', () => {
  it('collects the recorded pids of the members that belong to the lane', () => {
    const state = snapshot({
      Worker: { laneId: 'lane-a', runtimePid: 101 },
      Helper: { laneId: 'lane-a', runtimePid: 101 },
      Other: { laneId: 'lane-b', runtimePid: 202 },
    });

    expect(collectOpenCodeLaneRuntimePids(state, 'lane-a')).toEqual([101]);
    expect(collectOpenCodeLaneRuntimePids(state, 'lane-b')).toEqual([202]);
  });

  it('treats a member without a lane id as the primary lane', () => {
    const state = snapshot({ Lead: { runtimePid: 303 } });

    expect(collectOpenCodeLaneRuntimePids(state, 'primary')).toEqual([303]);
  });

  it('ignores a secondary member with no lane id and any unusable pid', () => {
    const state = snapshot({
      Nameless: { laneKind: 'secondary', runtimePid: 404 },
      NoPid: { laneId: 'lane-a' },
      ZeroPid: { laneId: 'lane-a', runtimePid: 0 },
    });

    expect(collectOpenCodeLaneRuntimePids(state, 'primary')).toEqual([]);
    expect(collectOpenCodeLaneRuntimePids(state, 'lane-a')).toEqual([]);
  });
});

describe('describeOpenCodeRuntimeStopResult', () => {
  it('joins the diagnostics and warnings the orchestrator reported', () => {
    expect(
      describeOpenCodeRuntimeStopResult({
        diagnostics: ['session abort not confirmed', '  '],
        warnings: [' lease released ', 7],
      })
    ).toBe('session abort not confirmed; lease released');
  });

  it('describes a missing result as nothing rather than failing', () => {
    expect(describeOpenCodeRuntimeStopResult(null)).toBe('');
  });
});

describe('resolveOpenCodeRuntimeStopOutcome', () => {
  it('accepts a confirmed stop without looking at any process', () => {
    const isRuntimeProcessAlive = vi.fn(() => true);

    const outcome = resolveOpenCodeRuntimeStopOutcome({
      result: { stopped: true },
      laneId: 'lane-a',
      previousLaunchState: snapshot({ Worker: { laneId: 'lane-a', runtimePid: 101 } }),
      isRuntimeProcessAlive,
    });

    expect(outcome).toEqual({ kind: 'stopped' });
    expect(isRuntimeProcessAlive).not.toHaveBeenCalled();
  });

  it('settles an unconfirmed stop whose recorded hosts are all gone', () => {
    const outcome = resolveOpenCodeRuntimeStopOutcome({
      result: { stopped: false, diagnostics: ['session abort not confirmed'] },
      laneId: 'lane-a',
      previousLaunchState: snapshot({ Worker: { laneId: 'lane-a', runtimePid: 101 } }),
      isRuntimeProcessAlive: () => false,
    });

    expect(outcome).toEqual({
      kind: 'already_stopped',
      detail: 'session abort not confirmed',
      checkedPids: [101],
    });
  });

  it('keeps an unconfirmed stop a failure while a recorded host is alive', () => {
    const outcome = resolveOpenCodeRuntimeStopOutcome({
      result: { stopped: false },
      laneId: 'lane-a',
      previousLaunchState: snapshot({
        Worker: { laneId: 'lane-a', runtimePid: 101 },
        Helper: { laneId: 'lane-a', runtimePid: 102 },
      }),
      isRuntimeProcessAlive: (pid) => pid === 102,
    });

    expect(outcome).toEqual({ kind: 'failed', detail: '', alivePids: [102] });
  });

  it('keeps an unconfirmed stop a failure when the lane recorded no pid at all', () => {
    const outcome = resolveOpenCodeRuntimeStopOutcome({
      result: { stopped: false },
      laneId: 'lane-a',
      previousLaunchState: snapshot({ Other: { laneId: 'lane-b', runtimePid: 202 } }),
      isRuntimeProcessAlive: () => false,
    });

    expect(outcome).toEqual({ kind: 'failed', detail: '', alivePids: [] });
  });

  it('does not read an unreadable process as a live host', () => {
    const outcome = resolveOpenCodeRuntimeStopOutcome({
      result: { stopped: false },
      laneId: 'lane-a',
      previousLaunchState: snapshot({ Worker: { laneId: 'lane-a', runtimePid: 101 } }),
      isRuntimeProcessAlive: () => {
        throw new Error('EPERM');
      },
    });

    expect(outcome.kind).toBe('already_stopped');
  });
});

describe('assertOpenCodeRuntimeStopEffective', () => {
  it('returns quietly for a confirmed stop', () => {
    const logWarning = vi.fn();

    const outcome = assertOpenCodeRuntimeStopEffective({
      result: { stopped: true },
      laneId: 'lane-a',
      previousLaunchState: null,
      message: 'OpenCode lane lane-a did not confirm stop',
      logWarning,
      isRuntimeProcessAlive: () => false,
    });

    expect(outcome.kind).toBe('stopped');
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('records why an unconfirmed stop was accepted as already stopped', () => {
    const logWarning = vi.fn();

    assertOpenCodeRuntimeStopEffective({
      result: { stopped: false, diagnostics: ['session abort not confirmed'] },
      laneId: 'lane-a',
      previousLaunchState: snapshot({ Worker: { laneId: 'lane-a', runtimePid: 101 } }),
      message: 'OpenCode lane lane-a did not confirm stop',
      logWarning,
      isRuntimeProcessAlive: () => false,
    });

    expect(logWarning).toHaveBeenCalledWith(
      'OpenCode lane lane-a did not confirm stop, but no recorded host process is alive (checked pid 101); treating the runtime as already stopped: session abort not confirmed'
    );
  });

  it('throws with the live pid when a recorded host survived the stop', () => {
    expect(() =>
      assertOpenCodeRuntimeStopEffective({
        result: { stopped: false, warnings: ['lease still held'] },
        laneId: 'lane-a',
        previousLaunchState: snapshot({ Worker: { laneId: 'lane-a', runtimePid: 101 } }),
        message: 'OpenCode lane lane-a did not confirm stop',
        logWarning: vi.fn(),
        isRuntimeProcessAlive: () => true,
      })
    ).toThrow(
      'OpenCode lane lane-a did not confirm stop: lease still held (host process still alive: pid 101)'
    );
  });

  it('throws and says so when there is no recorded pid to verify against', () => {
    expect(() =>
      assertOpenCodeRuntimeStopEffective({
        result: { stopped: false },
        laneId: 'lane-a',
        previousLaunchState: null,
        message: 'OpenCode lane lane-a did not confirm stop',
        logWarning: vi.fn(),
        isRuntimeProcessAlive: () => false,
      })
    ).toThrow('OpenCode lane lane-a did not confirm stop (no recorded host pid to verify)');
  });
});
