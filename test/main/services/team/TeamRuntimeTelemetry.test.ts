import {
  readCachedRuntimeProcessRowsForLiveRuntimeMetadata,
  shouldReadProcessTableForLiveRuntimeMetadata,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeMetadataPolicy';
import {
  addRuntimeRootOwnersFromProcessRows,
  buildProcessUsageStatsFromRows,
  buildRuntimeProcessLoadStats,
  buildRuntimeUsageProcessTrees,
  isRuntimePidusageTelemetryEnabled,
  normalizeRuntimeProcessRowsForTelemetry,
  normalizeRuntimeProcessUsageStats,
  RuntimeTelemetryTimeoutError,
  withRuntimeTelemetryTimeout,
} from '@main/services/team/TeamRuntimeTelemetry';
import { describe, expect, it } from 'vitest';

describe('TeamRuntimeTelemetry', () => {
  it('normalizes process rows and usage stats defensively', () => {
    expect(normalizeRuntimeProcessUsageStats({ memory: '123', cpu: '4.5' })).toEqual({
      rssBytes: 123,
      cpuPercent: 4.5,
    });
    expect(normalizeRuntimeProcessUsageStats({ memory: -1, cpu: Number.NaN })).toBeUndefined();
    expect(
      normalizeRuntimeProcessRowsForTelemetry(
        [
          { pid: '111', ppid: '1', command: ' node app.js ', memory: '123', cpu: '4.5' },
          { pid: '111.5', ppid: '1', command: 'fractional-pid' },
          { pid: 222, ppid: 1.5, command: 'fractional-ppid' },
          { pid: -1, ppid: 1, command: 'bad' },
          { pid: 222, ppid: 111, command: ' ' },
        ],
        'native'
      )
    ).toEqual([
      {
        pid: 111,
        ppid: 1,
        command: 'node app.js',
        rssBytes: 123,
        cpuPercent: 4.5,
        runtimeTelemetrySource: 'native',
      },
    ]);
  });

  it('adds runtime owners from agent command rows', () => {
    const owners = new Map<number, Set<string>>();

    addRuntimeRootOwnersFromProcessRows({
      teamName: 'runtime-team',
      rootOwnersByPid: owners,
      platform: 'linux',
      processRows: [
        {
          pid: 111,
          ppid: 1,
          command: 'bun cli.js --team-name runtime-team --agent-name alice',
        },
        {
          pid: 222,
          ppid: 1,
          command: 'bun cli.js --team-name runtime-team --agent-id bob@runtime-team',
        },
        {
          pid: 333,
          ppid: 1,
          command: 'bun cli.js --team-name other --agent-name mallory',
        },
      ],
    });

    expect(owners.get(111)).toEqual(new Set(['alice']));
    expect(owners.get(222)).toEqual(new Set(['bob']));
    expect(owners.has(333)).toBe(false);
  });

  it('keeps same-owner nested roots in the same usage tree', () => {
    const trees = buildRuntimeUsageProcessTrees({
      rootPids: [111, 222, 444],
      platform: 'linux',
      limits: { maxPidsPerRoot: 64, maxPidsPerSnapshot: 512 },
      processRows: [
        { pid: 111, ppid: 1, command: 'alice-runtime' },
        { pid: 222, ppid: 111, command: 'alice-metrics-runtime' },
        { pid: 333, ppid: 222, command: 'alice-tool' },
        { pid: 444, ppid: 111, command: 'bob-runtime' },
        { pid: 555, ppid: 444, command: 'bob-tool' },
      ],
      rootOwnersByPid: new Map<number, ReadonlySet<string>>([
        [111, new Set(['alice'])],
        [222, new Set(['alice'])],
        [444, new Set(['bob'])],
      ]),
    });

    expect(trees.get(111)).toEqual({ pids: [111, 222, 333], truncated: false });
    expect(trees.get(222)).toEqual({ pids: [222, 333], truncated: false });
    expect(trees.get(444)).toEqual({ pids: [444, 555], truncated: false });
  });

  it('bounds oversized usage trees', () => {
    const trees = buildRuntimeUsageProcessTrees({
      rootPids: [111],
      platform: 'linux',
      limits: { maxPidsPerRoot: 3, maxPidsPerSnapshot: 512 },
      processRows: [
        { pid: 111, ppid: 1, command: 'root' },
        { pid: 222, ppid: 111, command: 'child-1' },
        { pid: 333, ppid: 222, command: 'child-2' },
        { pid: 444, ppid: 333, command: 'child-3' },
      ],
    });

    expect(trees.get(111)).toEqual({ pids: [111, 222, 333], truncated: true });
  });

  it('aggregates process-tree usage stats', () => {
    const stats = buildRuntimeProcessLoadStats({
      rootPid: 111,
      usageStatsByPid: new Map([
        [111, { cpuPercent: 2, rssBytes: 100 }],
        [222, { cpuPercent: 5, rssBytes: 30 }],
        [333, { cpuPercent: 7, rssBytes: 20 }],
      ]),
      processTree: { pids: [111, 222, 333], truncated: true },
    });

    expect(stats).toEqual({
      cpuPercent: 14,
      rssBytes: 150,
      primaryCpuPercent: 2,
      primaryRssBytes: 100,
      childCpuPercent: 12,
      childRssBytes: 50,
      processCount: 3,
      runtimeLoadScope: 'process-tree',
      runtimeLoadTruncated: true,
    });
  });

  it('selects process table usage only for requested pids', () => {
    const stats = buildProcessUsageStatsFromRows(
      [
        { pid: 111, ppid: 1, command: 'lead', cpuPercent: 2, rssBytes: 100 },
        { pid: 222, ppid: 111, command: 'child' },
        { pid: 333, ppid: 1, command: 'other', cpuPercent: 9, rssBytes: 900 },
      ],
      [111, 222]
    );

    expect(stats).toEqual(new Map([[111, { cpuPercent: 2, rssBytes: 100 }]]));
  });

  it('detects when live runtime metadata needs process rows', () => {
    expect(
      shouldReadProcessTableForLiveRuntimeMetadata({
        metadataByMember: new Map([['alice', { alive: false }]]),
        launchSnapshot: null,
        paneInfoById: new Map(),
      })
    ).toBe(false);
    expect(
      shouldReadProcessTableForLiveRuntimeMetadata({
        metadataByMember: new Map([['alice', { alive: false, agentId: 'agent-1' }]]),
        launchSnapshot: null,
        paneInfoById: new Map(),
      })
    ).toBe(true);
    expect(
      shouldReadProcessTableForLiveRuntimeMetadata({
        metadataByMember: new Map([['alice', { alive: false, metricsPid: 222 }]]),
        launchSnapshot: null,
        paneInfoById: new Map(),
      })
    ).toBe(true);
  });

  it('reuses cached runtime process rows for liveness without Windows host rows', () => {
    const cached = {
      expiresAtMs: 2_000,
      generation: 1,
      runId: 'run-1',
      sampledAtMs: 1_000,
      includesWindowsHostRows: true,
      rows: [
        {
          pid: 111,
          ppid: 1,
          command: 'native runtime',
          runtimeTelemetrySource: 'native' as const,
        },
        {
          pid: 222,
          ppid: 1,
          command: 'host runtime',
          runtimeTelemetrySource: 'windows-host' as const,
        },
      ],
    };

    expect(
      readCachedRuntimeProcessRowsForLiveRuntimeMetadata({
        cached,
        runId: 'run-1',
        nowMs: 1_050,
        processTableCacheTtlMs: 100,
        processTableFailureCacheTtlMs: 25,
      })
    ).toEqual({
      rows: [{ pid: 111, ppid: 1, command: 'native runtime', runtimeTelemetrySource: 'native' }],
    });

    expect(
      readCachedRuntimeProcessRowsForLiveRuntimeMetadata({
        cached,
        runId: 'run-2',
        nowMs: 1_050,
        processTableCacheTtlMs: 100,
        processTableFailureCacheTtlMs: 25,
      })
    ).toBeNull();
    expect(
      readCachedRuntimeProcessRowsForLiveRuntimeMetadata({
        cached: { ...cached, rows: null },
        runId: 'run-1',
        nowMs: 1_010,
        processTableCacheTtlMs: 100,
        processTableFailureCacheTtlMs: 25,
      })
    ).toEqual({ rows: null });
  });

  it('normalizes runtime pidusage opt-in values', () => {
    expect(
      isRuntimePidusageTelemetryEnabled({ CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED: 'true' })
    ).toBe(true);
    expect(
      isRuntimePidusageTelemetryEnabled({ CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED: ' yes ' })
    ).toBe(true);
    expect(
      isRuntimePidusageTelemetryEnabled({ CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED: '0' })
    ).toBe(false);
  });

  it('bounds slow runtime telemetry reads with a timeout', async () => {
    await expect(withRuntimeTelemetryTimeout(Promise.resolve('ok'), 100, 'fast read')).resolves.toBe(
      'ok'
    );
    await expect(
      withRuntimeTelemetryTimeout(new Promise(() => undefined), 1, 'slow read')
    ).rejects.toBeInstanceOf(RuntimeTelemetryTimeoutError);
  });
});
