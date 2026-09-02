import { runTeamForceStopFlow } from '@main/services/team/lifecycle/teamForceStopFlow';
import { describe, expect, it, vi } from 'vitest';

import type { TeamForceStopFlowPorts } from '@main/services/team/lifecycle/teamForceStopFlow';

function createPorts(overrides: Partial<TeamForceStopFlowPorts> = {}): {
  [K in keyof TeamForceStopFlowPorts]: TeamForceStopFlowPorts[K];
} & {
  stopTeam: ReturnType<typeof vi.fn>;
  killRetainedRuntimeProcesses: ReturnType<typeof vi.fn>;
  clearPendingPromptDeliveries: ReturnType<typeof vi.fn>;
  logWarning: ReturnType<typeof vi.fn>;
} {
  return {
    stopTeam: vi.fn(() => Promise.resolve()),
    killRetainedRuntimeProcesses: vi.fn(() =>
      Promise.resolve({ killedPids: [4242], diagnostics: ['Killed persisted runtime pid=4242'] })
    ),
    clearPendingPromptDeliveries: vi.fn(() =>
      Promise.resolve({ cleared: 2, diagnostics: ['Cancelled 2 pending prompt delivery record(s)'] })
    ),
    logWarning: vi.fn(),
    stopTimeoutMs: 20,
    ...overrides,
  } as never;
}

describe('runTeamForceStopFlow', () => {
  it('runs the regular stop first and then the cleanup steps', async () => {
    const ports = createPorts();

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(ports.stopTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam');
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam');
    expect(result.stopOutcome).toBe('stopped');
    expect(result.killedRuntimePids).toEqual([4242]);
    expect(result.clearedPendingDeliveries).toBe(2);
    expect(ports.logWarning).not.toHaveBeenCalled();
  });

  it('continues with the hard kill when the regular stop rejects', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() =>
        Promise.reject(new Error('did not confirm stop; retaining runtime ownership'))
      ),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stop_failed');
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam');
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam');
    expect(result.killedRuntimePids).toEqual([4242]);
    expect(result.diagnostics.join('\n')).toContain('did not confirm stop');
  });

  it('continues with the hard kill when the regular stop never settles', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('timed_out');
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam');
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam');
    expect(result.diagnostics.join('\n')).toContain('timed out after 20ms');
  });

  it('reports a failing kill step as a diagnostic instead of failing the force stop', async () => {
    const ports = createPorts({
      killRetainedRuntimeProcesses: vi.fn(() => Promise.reject(new Error('taskkill exited 1'))),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stopped');
    expect(result.killedRuntimePids).toEqual([]);
    expect(result.diagnostics.join('\n')).toContain('Process kill failed: taskkill exited 1');
    // The delivery cleanup still runs: a failed kill must not strand the ledger.
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam');
  });

  it('reports zero cleared deliveries when the team has none pending', async () => {
    const ports = createPorts({
      clearPendingPromptDeliveries: vi.fn(() => Promise.resolve({ cleared: 0, diagnostics: [] })),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.clearedPendingDeliveries).toBe(0);
    expect(result.diagnostics.join('\n')).not.toContain('pending prompt delivery record');
  });
});
