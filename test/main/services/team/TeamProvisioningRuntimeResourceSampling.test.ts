import { TeamProvisioningRuntimeResourceSampling } from '@main/services/team/provisioning/TeamProvisioningRuntimeResourceSampling';
import { describe, expect, it, vi } from 'vitest';

function createSampling(overrides: {
  generation?: number;
  runId?: string | null;
  listRuntimeProcessTable?: () => Promise<unknown>;
  listWindowsProcessTable?: (timeoutMs: number) => Promise<unknown>;
  readPidUsage?: (
    pids: number | readonly number[],
    options?: { maxage?: number }
  ) => Promise<unknown>;
} = {}): TeamProvisioningRuntimeResourceSampling {
  return new TeamProvisioningRuntimeResourceSampling(
    {
      processTableTimeoutMs: 100,
      windowsProcessTableTimeoutMs: 100,
      livenessProcessTableCacheTtlMs: 1_000,
      livenessProcessTableFailureCacheTtlMs: 500,
      resourceTelemetryCacheTtlMs: 1_000,
      resourceTelemetryFailureCacheTtlMs: 500,
      processUsageCacheTtlMs: 1_000,
      processUsageCacheMaxEntries: 32,
      pidusageBatchTimeoutMs: 100,
      pidusageSingleTimeoutMs: 100,
      pidusageFallbackConcurrency: 2,
      maxRuntimeTreePidsPerRoot: 64,
      maxRuntimeUsagePidsPerSnapshot: 512,
      historyLimit: 3,
      minSampleIntervalMs: 30_000,
    },
    {
      getRuntimeSnapshotCacheGeneration: () => overrides.generation ?? 1,
      getTrackedRunId: () => overrides.runId ?? 'run-1',
    },
    { logDebug: vi.fn() },
    {
      listRuntimeProcessTable:
        overrides.listRuntimeProcessTable ??
        vi.fn(async () => [{ pid: 111, ppid: 1, command: 'runtime' }]),
      listWindowsProcessTable: overrides.listWindowsProcessTable ?? vi.fn(async () => []),
    },
    {
      read: overrides.readPidUsage ?? vi.fn(async () => ({})),
    }
  );
}

describe('TeamProvisioningRuntimeResourceSampling', () => {
  it('reads and caches live runtime metadata process rows through an explicit reader port', async () => {
    const listRuntimeProcessTable = vi.fn(async () => [
      { pid: '111', ppid: '1', command: ' runtime ', cpu: '3', memory: '1000' },
    ]);
    const sampling = createSampling({ listRuntimeProcessTable });

    const first = await sampling.readRuntimeProcessRowsForLiveRuntimeMetadata({
      teamName: 'runtime-team',
      runId: 'run-1',
      generationAtStart: 1,
    });
    const second = await sampling.readRuntimeProcessRowsForLiveRuntimeMetadata({
      teamName: 'runtime-team',
      runId: 'run-1',
      generationAtStart: 1,
    });

    expect(listRuntimeProcessTable).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      processTableAvailable: true,
      rows: [
        {
          pid: 111,
          ppid: 1,
          command: 'runtime',
          cpuPercent: 3,
          rssBytes: 1000,
          runtimeTelemetrySource: process.platform === 'win32' ? 'wsl' : 'native',
        },
      ],
    });
    expect(second).toEqual(first);
  });

  it('exposes runtime resource history through a record/prune port', () => {
    const sampling = createSampling();
    const activeKeys = new Set<string>();

    const alice = sampling.agentRuntimeResourceHistoryPort.record({
      teamName: 'runtime-team',
      memberName: 'alice',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 4,
      rssBytes: 100,
      pid: 222,
      activeKeys,
    });
    sampling.agentRuntimeResourceHistoryPort.record({
      teamName: 'runtime-team',
      memberName: 'bob',
      timestamp: '2026-04-24T12:00:00.000Z',
      cpuPercent: 5,
      rssBytes: 200,
      pid: 333,
    });

    sampling.agentRuntimeResourceHistoryPort.prune('runtime-team', activeKeys);

    expect(alice).toEqual([expect.objectContaining({ cpuPercent: 4, rssBytes: 100 })]);
    expect(
      sampling.agentRuntimeResourceHistoryPort.record({
        teamName: 'runtime-team',
        memberName: 'alice',
        timestamp: '2026-04-24T12:01:00.000Z',
        pid: 222,
      })
    ).toHaveLength(1);
    expect(
      sampling.agentRuntimeResourceHistoryPort.record({
        teamName: 'runtime-team',
        memberName: 'bob',
        timestamp: '2026-04-24T12:01:00.000Z',
        pid: 333,
      })
    ).toBeUndefined();
  });

  it('creates bound runtime snapshot resource sampling ports', async () => {
    const previousPidusageTelemetry = process.env.CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED;
    process.env.CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED = '1';
    const listRuntimeProcessTable = vi.fn(async () => [
      { pid: 111, ppid: 1, command: 'runtime', cpu: 4, memory: 100 },
      { pid: 222, ppid: 111, command: 'child', cpu: 6, memory: 200 },
    ]);
    const readPidUsage = vi.fn(async () => ({
      '111': { cpu: 8, memory: 300 },
      '222': { cpu: 12, memory: 500 },
    }));
    try {
      const sampling = createSampling({ listRuntimeProcessTable, readPidUsage });

      const ports = sampling.createRuntimeSnapshotResourceSamplingPorts();
      const rows = await ports.readRuntimeProcessRowsForUsageSnapshot('runtime-team');
      const trees = ports.buildRuntimeUsageProcessTrees({
        rootPids: [111],
        processRows: rows,
      });
      const sampledStats = await ports.readProcessUsageStatsByPid([111, 222]);
      const loadStats = ports.buildRuntimeProcessLoadStats({
        rootPid: 111,
        usageStatsByPid: sampledStats,
        processTree: trees.get(111),
      });
      const history = ports.agentRuntimeResourceHistory.record({
        teamName: 'runtime-team',
        memberName: 'alice',
        timestamp: '2026-04-24T12:00:00.000Z',
        cpuPercent: loadStats?.cpuPercent,
        rssBytes: loadStats?.rssBytes,
        pid: 111,
      });

      expect(listRuntimeProcessTable).toHaveBeenCalledTimes(1);
      expect(readPidUsage).toHaveBeenCalledWith([111, 222], expect.any(Object));
      expect(trees.get(111)).toEqual({ pids: [111, 222], truncated: false });
      expect(loadStats).toEqual({
        childCpuPercent: 12,
        childRssBytes: 500,
        cpuPercent: 20,
        primaryCpuPercent: 8,
        primaryRssBytes: 300,
        processCount: 2,
        rssBytes: 800,
        runtimeLoadScope: 'process-tree',
      });
      expect(history).toEqual([expect.objectContaining({ cpuPercent: 20, rssBytes: 800 })]);
    } finally {
      if (previousPidusageTelemetry === undefined) {
        delete process.env.CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED;
      } else {
        process.env.CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED = previousPidusageTelemetry;
      }
    }
  });
});
