import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

interface ProcessRow {
  pid: number;
  ppid: number;
  cpu: number;
  rssMiB: number;
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
    options: CaptureOptions
  ): Promise<{ pid: number; frames: { processes: ProcessRow[] }[] }>;
}

const captureTool = createRequire(import.meta.url)(
  '../../scripts/diagnostics/capture-agent-teams-cpu.cjs'
) as CpuCaptureModule;

describe('read-only process CPU capture', () => {
  it('parses ps rows without retaining executable paths or arguments', () => {
    expect(
      captureTool.parseRows('  11  1  42,5  10240 /Applications/Agent Teams AI\n')
    ).toEqual([
      { pid: 11, ppid: 1, cpu: 42.5, rssMiB: 10, name: 'Agent Teams AI' },
    ]);
  });

  it('only includes the selected root and descendants', () => {
    const row = (pid: number, ppid: number): ProcessRow => ({
      pid,
      ppid,
      cpu: 0,
      rssMiB: 0,
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

  it('captures a real test-owned child without terminating it', async () => {
    if (process.platform === 'win32') return;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const pid = child.pid;
      if (!pid) throw new Error('Test child did not start');
      const data = await captureTool.capture({ pid, duration: 1, intervalMs: 500 });
      expect(data.pid).toBe(pid);
      expect(data.frames).toHaveLength(3);
      expect(data.frames.every((frame) => frame.processes.length === 1)).toBe(true);
      expect(data.frames.every((frame) => frame.processes[0]?.pid === pid)).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      // Only this test-owned child is stopped, never an app/agent process.
      child.kill();
    }
  });
});
