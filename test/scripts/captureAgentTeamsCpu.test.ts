import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

interface ProcessRow {
  pid: number;
  ppid: number;
  psReportedCpuPercent: number;
  rssMiB: number;
  started: string;
  name: string;
}

interface CaptureOptions {
  pid: number;
  duration: number;
  intervalMs: number;
}

interface CpuCaptureModule {
  parseRows(output: string): ProcessRow[];
  descendants(rows: ProcessRow[], pid: number): ProcessRow[];
  parseOptions(argv: string[]): CaptureOptions;
  capture(
    options: CaptureOptions,
    tableReader?: () => ProcessRow[]
  ): Promise<{
    pid: number;
    stopReason: string | null;
    cpuPercentSemantics: string;
    frames: {
      processCount: number;
      totalPsReportedCpuPercent: number;
      totalRssMiB: number;
      processes: ProcessRow[];
    }[];
  }>;
}

const captureTool = createRequire(import.meta.url)(
  '../../scripts/diagnostics/capture-agent-teams-cpu.cjs'
) as CpuCaptureModule;

describe('read-only process CPU capture', () => {
  it('parses ps rows without retaining executable paths or arguments', () => {
    expect(
      captureTool.parseRows('  11  1  42,5  10240 Wed Nov  4 09:25:48 2026 /Applications/Agent Teams AI\n')
    ).toEqual([
      {
        pid: 11,
        ppid: 1,
        psReportedCpuPercent: 42.5,
        rssMiB: 10,
        started: 'Wed Nov 4 09:25:48 2026',
        name: 'Agent Teams AI',
      },
    ]);
  });

  it('only includes the selected root and descendants', () => {
    const row = (pid: number, ppid: number): ProcessRow => ({
      pid,
      ppid,
      psReportedCpuPercent: 0,
      rssMiB: 0,
      started: 'Wed Nov 4 09:25:48 2026',
      name: 'test',
    });
    const rows = [row(1, 0), row(2, 1), row(3, 2), row(4, 0), row(5, 1)];
    expect(captureTool.descendants(rows, 1).map((item) => item.pid)).toEqual([1, 2, 3, 5]);
    expect(captureTool.descendants(rows, 4).map((item) => item.pid)).toEqual([4]);
    expect(captureTool.descendants(rows, 99)).toEqual([]);
  });

  it('rejects invalid options and unbounded sampling', () => {
    expect(() => captureTool.parseOptions(['--pid', '0'])).toThrow('positive integer');
    expect(() => captureTool.parseOptions(['--pid', '1', '--duration', '86400'])).toThrow(
      '1..300'
    );
    expect(() => captureTool.parseOptions(['--pid', '1', '--interval-ms', '1'])).toThrow(
      '250..10000'
    );
    expect(captureTool.parseOptions(['--pid', '45'])).toEqual({
      pid: 45,
      duration: 30,
      intervalMs: 1000,
    });
  });

  it('rejects unsupported platforms before trying to read processes', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatform) throw Error('process.platform descriptor missing');
    let reads = 0;
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    let rejected;
    try {
      // Call capture while mocked, then restore before awaiting test assertions.
      rejected = captureTool.capture({ pid: 99, duration: 1, intervalMs: 250 }, () => {
        reads += 1;
        return [];
      });
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    await expect(rejected).rejects.toThrow('Only macOS/Linux supported');
    expect(reads).toBe(0);
  });

  it('stops when the root PID belongs to a different process', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const original = {
      pid: 99,
      ppid: 1,
      psReportedCpuPercent: 20,
      rssMiB: 1,
      started: 'Wed Nov 4 09:25:48 2026',
      name: 'original',
    };
    const replacement = { ...original, started: 'Wed Nov 4 09:25:49 2026', name: 'other' };
    let samples = 0;
    const result = await captureTool.capture(
      { pid: 99, duration: 1, intervalMs: 250 },
      () => (samples++ === 0 ? [original] : [replacement])
    );
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.processes[0]?.name).toBe('original');
    expect(result.frames[0]?.processCount).toBe(1);
    expect(result.frames[0]?.totalPsReportedCpuPercent).toBe(20);
    expect(result.frames[0]?.totalRssMiB).toBe(1);
    expect(result.stopReason).toBeNull();
    expect(result.cpuPercentSemantics).toContain('not interval utilization');
    if (process.platform === 'linux') {
      expect(result.cpuPercentSemantics).toContain('lifetime average');
    } else {
      expect(result.cpuPercentSemantics).toContain('system-reported estimate');
    }
    expect(samples).toBe(2);
  });

  it.each([
    { changed: 'ppid' as const, replacement: 200, shouldStop: false },
    { changed: 'name' as const, replacement: 'different', shouldStop: true },
    { changed: 'started' as const, replacement: 'Wed Nov 4 09:25:49 2026', shouldStop: true },
  ])('handles root $changed changes without misidentifying the process', async ({ changed, replacement, shouldStop }) => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const original = {
      pid: 99,
      ppid: 1,
      psReportedCpuPercent: 20,
      rssMiB: 1,
      started: 'Wed Nov 4 09:25:48 2026',
      name: 'original',
    };
    const reused = { ...original, [changed]: replacement };
    let samples = 0;
    const result = await captureTool.capture(
      { pid: 99, duration: 1, intervalMs: 250 },
      () => (samples++ === 0 ? [original] : [reused])
    );
    if (shouldStop) {
      expect(result.frames).toHaveLength(1);
      expect(samples).toBe(2);
    } else {
      expect(result.frames.length).toBeGreaterThanOrEqual(2);
      expect(result.frames[1]?.processes[0]?.ppid).toBe(200);
    }
  });

  it('preserves earlier samples when a later ps read fails, but rejects an initial failure', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root: ProcessRow = {
      pid: 99,
      ppid: 1,
      psReportedCpuPercent: 12,
      rssMiB: 4,
      started: 'Wed Nov 4 09:25:48 2026',
      name: 'test',
    };
    let calls = 0;
    const result = await captureTool.capture(
      { pid: 99, duration: 1, intervalMs: 250 },
      () => {
        if (calls++ === 0) return [root];
        throw Error('ps unavailable');
      }
    );
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.totalPsReportedCpuPercent).toBe(12);
    expect(result.stopReason).toBe('ps_read_failed');
    expect(calls).toBe(2);

    await expect(
      captureTool.capture({ pid: 99, duration: 1, intervalMs: 250 }, () => {
        throw Error('ps unavailable');
      })
    ).rejects.toThrow('ps unavailable');
  });

  it('captures a real test-owned child without terminating it', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const sentinel = 'cpu-capture-argument-sentinel';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', sentinel], {
      stdio: 'ignore',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const pid = child.pid;
      if (!pid) throw new Error('Test child did not start');
      const startMs = Date.now();
      const data = await captureTool.capture({ pid, duration: 1, intervalMs: 5000 });
      expect(Date.now() - startMs).toBeLessThan(4000);
      expect(data.pid).toBe(pid);
      expect(data.frames.length).toBeGreaterThanOrEqual(1);
      expect(data.frames.length).toBeLessThanOrEqual(2);
      expect(data.frames.every((frame) => frame.processes.length === 1)).toBe(true);
      expect(data.frames.every((frame) => frame.processes[0]?.pid === pid)).toBe(true);
      expect(JSON.stringify(data)).not.toContain(sentinel);
      expect(child.exitCode).toBeNull();
    } finally {
      // Only this test-owned child is stopped, never an app/agent process.
      child.kill();
    }
  });
});
