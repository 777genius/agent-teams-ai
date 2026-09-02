import {
  DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT,
  killRetainedOpenCodeRuntimeProcessesForTeam,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanupManagedOpenCodeServeProcesses = vi.hoisted(() =>
  vi.fn(async () => ({ scanned: 0, killed: 0, candidates: [], diagnostics: [] }))
);

vi.mock('@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup', () => ({
  cleanupManagedOpenCodeServeProcesses,
}));

type KillInput = Parameters<typeof killRetainedOpenCodeRuntimeProcessesForTeam>[0];

function createLaunchStateStore(): NonNullable<KillInput['launchStateStore']> {
  return { read: vi.fn(async () => null) } as unknown as NonNullable<KillInput['launchStateStore']>;
}

describe('killRetainedOpenCodeRuntimeProcessesForTeam', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults the fence to the moment the kill step began', async () => {
    const before = Date.now();

    const result = await killRetainedOpenCodeRuntimeProcessesForTeam({
      teamName: 'fixteam',
      otherAliveTeams: [],
      launchStateStore: createLaunchStateStore(),
    });

    const after = Date.now();
    expect(cleanupManagedOpenCodeServeProcesses).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(cleanupManagedOpenCodeServeProcesses).mock.calls[0] as unknown as [
      { mode: string; startedBeforeMs?: number },
    ];
    expect(options.mode).toBe('force');
    expect(options.startedBeforeMs).toBeGreaterThanOrEqual(before);
    expect(options.startedBeforeMs).toBeLessThanOrEqual(after);
    expect(result.killedPids).toEqual([]);
  });

  it('uses the default sweep port, which is enabled, when the caller hands in none', () => {
    expect(DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT.isEnabled()).toBe(true);
  });

  it('fences the managed host sweep by the time the stop was requested', async () => {
    const requestedAtMs = Date.parse('2026-09-01T10:00:00.000Z');

    await killRetainedOpenCodeRuntimeProcessesForTeam({
      teamName: 'fixteam',
      otherAliveTeams: [],
      launchStateStore: createLaunchStateStore(),
      requestedAtMs,
    });

    expect(cleanupManagedOpenCodeServeProcesses).toHaveBeenCalledWith({
      mode: 'force',
      startedBeforeMs: requestedAtMs,
    });
  });

  it('skips the managed host sweep while another team is alive', async () => {
    const result = await killRetainedOpenCodeRuntimeProcessesForTeam({
      teamName: 'fixteam',
      otherAliveTeams: ['other-team'],
      launchStateStore: createLaunchStateStore(),
    });

    expect(cleanupManagedOpenCodeServeProcesses).not.toHaveBeenCalled();
    expect(result.diagnostics).toContain(
      'Skipped managed host sweep: other teams are still alive (other-team)'
    );
  });

  it('touches no process and says so when the managed host sweep port is disabled', async () => {
    const sweepManagedHosts = vi.fn();

    const result = await killRetainedOpenCodeRuntimeProcessesForTeam({
      teamName: 'fixteam',
      otherAliveTeams: [],
      launchStateStore: createLaunchStateStore(),
      managedHostSweep: { isEnabled: () => false, sweepManagedHosts },
    });

    expect(sweepManagedHosts).not.toHaveBeenCalled();
    expect(cleanupManagedOpenCodeServeProcesses).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics).toContain(
      'Skipped managed host sweep: the managed host sweep is disabled for this app instance'
    );
  });

  it('reports the pids the sweep killed', async () => {
    cleanupManagedOpenCodeServeProcesses.mockResolvedValueOnce({
      scanned: 2,
      killed: 1,
      candidates: [
        { pid: 5150, ppid: 1, action: 'killed', reason: 'managed OpenCode serve cleanup' },
        { pid: 5151, ppid: 1, action: 'kept_recent', reason: 'process started after this app' },
      ],
      diagnostics: [],
    } as never);

    const result = await killRetainedOpenCodeRuntimeProcessesForTeam({
      teamName: 'fixteam',
      otherAliveTeams: [],
      launchStateStore: createLaunchStateStore(),
    });

    expect(result.killedPids).toEqual([5150]);
    expect(result.diagnostics).toContain('Managed host sweep killed 1 host process(es)');
  });
});
