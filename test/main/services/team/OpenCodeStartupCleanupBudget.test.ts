// @vitest-environment node
import { OpenCodeStartupCleanupBudget } from '@main/services/team/opencode/bridge/OpenCodeStartupCleanupBudget';
import { cleanupManagedOpenCodeServeProcesses } from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { describe, expect, it, vi } from 'vitest';

const command = 'C:\\runtimes\\opencode\\versions\\test\\opencode-windows-x64\\opencode.exe serve --port 1234';

describe('Windows startup admission budget', () => {
  it('validates the absolute deadline and never turns exhaustion into an unlimited timeout', () => {
    for (const deadline of [NaN, Infinity, 100, 120_101]) {
      expect(() => new OpenCodeStartupCleanupBudget(deadline, 100)).toThrow();
    }
    let now = 0;
    const budget = new OpenCodeStartupCleanupBudget(120_100, 100, () => now);
    expect(budget.capMs(20_000)).toBe(20_000);
    now = 119_999;
    expect(budget.capMs(6_000)).toBe(1);
    now++;
    expect(() => budget.capMs(6_000)).toThrow('exhausted');
  });

  it.each([false, true])('handles 12s enumeration and repeated 4s identity (exhaust=%s)', async (exhaust) => {
    let now = 0;
    let alive = true;
    const budget = new OpenCodeStartupCleanupBudget(exhaust ? 22_000 : 120_000, 0, () => now);
    const dispose = vi.fn();
    const kill = vi.fn(() => { alive = false; });
    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned', platform: 'win32', startupBudget: budget, startedBeforeMs: 100,
      listProcessRows: async () => { now += 12_000; return [1, 2].map((pid) => ({ pid, ppid: 0, command })); },
      readProcessStartTimeMs: async () => { now += 4_000; return 10; },
      isProcessAlive: () => alive, killProcess: kill, disposeServeHost: dispose,
    });
    expect(dispose).not.toHaveBeenCalled();
    if (exhaust) {
      expect(kill).not.toHaveBeenCalled();
      expect(result.candidates.map((candidate) => candidate.action)).toEqual(['failed', 'failed']);
    } else {
      expect(kill).toHaveBeenCalled();
      expect(result.killed).toBe(2);
    }
  });
});
