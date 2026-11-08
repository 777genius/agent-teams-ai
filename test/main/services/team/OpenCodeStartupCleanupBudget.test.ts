// @vitest-environment node
import { cleanupManagedOpenCodeServeProcesses } from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { OpenCodeStartupCleanupBudget } from '@main/services/team/opencode/bridge/OpenCodeStartupCleanupBudget';
import { describe, expect, it, vi } from 'vitest';

const command =
  'C:\\runtimes\\opencode\\versions\\test\\opencode-windows-x64\\opencode.exe serve --port 1234';

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

  it.each([false, true])(
    'does not spend a budget on an unattributed host (exhaust=%s)',
    async (exhaust) => {
      let now = 0;
      const budget = new OpenCodeStartupCleanupBudget(120000, 0, () => now);
      if (exhaust) now = 120000;
      const listProcessRows = vi.fn(async () => [{ pid: 424242, ppid: 0, command }]);
      const readProcessStartTimeMs = vi.fn(async () => 10);
      const disposeServeHost = vi.fn();
      const killProcess = vi.fn();
      const result = await cleanupManagedOpenCodeServeProcesses({
        mode: 'orphaned',
        platform: 'win32',
        startupBudget: budget,
        startedBeforeMs: 100,
        listProcessRows,
        readProcessStartTimeMs,
        disposeServeHost,
        killProcess,
      });
      expect(listProcessRows).not.toHaveBeenCalled();
      expect(readProcessStartTimeMs).not.toHaveBeenCalled();
      expect(disposeServeHost).not.toHaveBeenCalled();
      expect(killProcess).not.toHaveBeenCalled();
      expect(result).toMatchObject({ scanned: 0, killed: 0, candidates: [] });
      expect(budget.remainingMs()).toBe(exhaust ? 0 : 120000);
    }
  );
});
