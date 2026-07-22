import {
  TeamAgentRuntimeResourceHistory,
  type TeamAgentRuntimeResourceHistoryOptions,
} from '@main/services/team/TeamAgentRuntimeResourceHistory';
import { describe, expect, it } from 'vitest';

function createHistory(
  overrides: Partial<TeamAgentRuntimeResourceHistoryOptions> = {}
): TeamAgentRuntimeResourceHistory {
  return new TeamAgentRuntimeResourceHistory({
    historyLimit: 3,
    minSampleIntervalMs: 30_000,
    ...overrides,
  });
}

describe('TeamAgentRuntimeResourceHistory', () => {
  it('builds stable member/pid/source keys', () => {
    const history = createHistory();

    expect(
      history.buildKey({
        memberName: ' alice ',
        runId: 'run-a',
        pid: 222,
        runtimePid: 333,
        pidSource: 'tmux_child',
      })
    ).toBe(['run-a', 'alice', 222, 'tmux_child'].join('\0'));
    expect(history.buildKey({ memberName: 'alice', runtimePid: 333 })).toBe(
      ['unknown-run', 'alice', 333, 'unknown'].join('\0')
    );
    expect(history.buildKey({ memberName: ' ', pid: 222 })).toBeNull();
    expect(history.buildKey({ memberName: 'alice' })).toBeNull();
  });

  it('normalizes fractional pids before keying and storing samples', () => {
    const history = createHistory();

    expect(
      history.buildKey({
        memberName: 'alice',
        pid: 222.9,
        runtimePid: 333.9,
        pidSource: 'agent_process_table',
      })
    ).toBe(['unknown-run', 'alice', 222, 'agent_process_table'].join('\0'));
    expect(history.buildKey({ memberName: 'alice', pid: 0.9 })).toBeNull();

    const samples = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pid: 222.9,
      runtimePid: 333.9,
    });

    expect(samples).toEqual([expect.objectContaining({ pid: 222, runtimePid: 333 })]);
  });

  it('caps history and keeps defensive return copies', () => {
    const history = createHistory();

    for (let index = 0; index < 5; index += 1) {
      history.record({
        teamName: 'runtime-team',
        memberName: 'alice',
        timestamp: `2026-04-24T12:0${index}:00.000Z`,
        cpuPercent: index,
        rssBytes: 100 + index,
        pid: 222,
      });
    }

    const firstRead = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:06:00.000Z',
      pid: 222,
    });
    firstRead?.push({ timestamp: 'mutated', cpuPercent: 999 });
    const secondRead = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:06:00.000Z',
      pid: 222,
    });

    expect(secondRead).toEqual([
      expect.objectContaining({ cpuPercent: 2, rssBytes: 102 }),
      expect.objectContaining({ cpuPercent: 3, rssBytes: 103 }),
      expect.objectContaining({ cpuPercent: 4, rssBytes: 104 }),
    ]);
  });

  it('keeps history bounded when historyLimit is zero', () => {
    const history = createHistory({ historyLimit: 0 });

    const samples = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pid: 222,
    });

    expect(samples).toEqual([]);
    expect(
      history.record({
        teamName: 'runtime-team',
        memberName: 'alice',
        timestamp: '2026-04-24T12:01:00.000Z',
        pid: 222,
      })
    ).toBeUndefined();
  });

  it('throttles samples inside the minimum interval', () => {
    const history = createHistory();

    const first = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pid: 222,
    });
    const second = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:01.000Z',
      cpuPercent: 99,
      rssBytes: 999,
      pid: 222,
    });

    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
    expect(second?.[0]).toMatchObject({ cpuPercent: 4, rssBytes: 100 });
  });

  it('isolates history by runtime run id for reused pids', () => {
    const history = createHistory();

    const runA = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      runId: 'run-a',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pidSource: 'agent_process_table',
      pid: 222,
    });
    const runBReadBeforeSample = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      runId: 'run-b',
      timestamp: '2026-04-24T12:01:00.000Z',
      pidSource: 'agent_process_table',
      pid: 222,
    });
    const runB = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      runId: 'run-b',
      timestamp: '2026-04-24T12:01:00.000Z',
      cpuPercent: 8,
      rssBytes: 200,
      pidSource: 'agent_process_table',
      pid: 222,
    });

    expect(runA).toEqual([expect.objectContaining({ cpuPercent: 4, rssBytes: 100 })]);
    expect(runBReadBeforeSample).toBeUndefined();
    expect(runB).toEqual([expect.objectContaining({ cpuPercent: 8, rssBytes: 200 })]);
  });
  it('preserves existing history when incoming metrics are invalid', () => {
    const history = createHistory();

    const first = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pid: 222,
    });
    const invalid = history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:01:00.000Z',
      cpuPercent: Number.NaN,
      rssBytes: -1,
      pid: 222,
    });
    const missing = history.record({
      teamName: 'runtime-team',
      memberName: 'bob',
      timestamp: '2026-04-24T12:01:00.000Z',
      cpuPercent: Number.NaN,
      rssBytes: -1,
      pid: 333,
    });

    expect(invalid).toEqual(first);
    expect(missing).toBeUndefined();
  });

  it('prunes inactive keys per team', () => {
    const history = createHistory();
    const activeKeys = new Set<string>();

    history.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pidSource: 'tmux_child',
      pid: 222,
      activeKeys,
    });
    history.record({
      teamName: 'runtime-team',
      memberName: 'bob',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 5,
      rssBytes: 200,
      pidSource: 'agent_process_table',
      pid: 333,
    });

    history.prune('runtime-team', activeKeys);

    expect(
      history.record({
        teamName: 'runtime-team',
        memberName: 'alice',
        timestamp: '2026-04-24T12:01:00.000Z',
        pidSource: 'tmux_child',
        pid: 222,
      })
    ).toHaveLength(1);
    expect(
      history.record({
        teamName: 'runtime-team',
        memberName: 'bob',
        timestamp: '2026-04-24T12:01:00.000Z',
        pidSource: 'agent_process_table',
        pid: 333,
      })
    ).toBeUndefined();
  });
});
