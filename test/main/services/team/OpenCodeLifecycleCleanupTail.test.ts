// @vitest-environment node
import { runOpenCodeLifecycleHostCleanup } from '@main/services/team/opencode/bridge/OpenCodeLifecycleCleanupTail';
import { cleanupManagedOpenCodeServeProcesses } from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  alive: new Set<number>(),
  order: [] as string[],
  kill: vi.fn(),
}));

vi.mock(
  '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup',
  async (original) => {
    const actual =
      await original<
        typeof import('@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup')
      >();
    return {
      ...actual,
      cleanupManagedOpenCodeServeProcesses: vi.fn((options) =>
        actual.cleanupManagedOpenCodeServeProcesses({
          ...options,
          platform: 'darwin',
          listProcessRows: async () => [
            { pid: 101, ppid: 1, command: 'opencode serve --port 50101' },
            { pid: 202, ppid: 1, command: 'opencode serve --port 50202' },
          ],
          readProcessDetails: async (pid) =>
            [
              'opencode serve',
              'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/TEST-lifecycle',
              'OPENCODE_CONFIG_CONTENT={}',
              'AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/TEST-lifecycle/claude',
              `CLAUDE_TEAM_APP_INSTANCE_ID=${pid === 101 ? 'own-instance' : 'foreign-instance'}`,
            ].join(' '),
          readProcessStartTimeMs: async () => 1_000,
          readServeHostConfig: async (baseUrl) =>
            `agent-teams-app-instance=${baseUrl.endsWith(':50101') ? 'own-instance' : 'foreign-instance'}`,
          disposeServeHost: async () => undefined,
          isProcessAlive: (pid) => fixture.alive.has(pid),
          killProcess: fixture.kill,
          forceKillProcess: fixture.kill,
          sleepMs: async () => undefined,
        })
      ),
    };
  }
);

vi.mock('@main/services/team/opencode/bridge/OpenCodeHostStartupLockCleanup', () => ({
  purgeStaleOpenCodeHostStartupLocks: vi.fn(async () => ({ removed: 0, diagnostics: [] })),
  resolveStartupStaleLockMinAgeMs: vi.fn(() => 60_000),
}));
vi.mock('@main/services/team/opencode/bridge/OpenCodeStartupRuntimeSweep', () => ({
  runOpenCodeStartupRuntimeSweepTail: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.alive = new Set([101, 202]);
  fixture.order = [];
  fixture.kill.mockImplementation(async (pid: number) => {
    fixture.order.push(`kill:${pid}`);
    fixture.alive.delete(pid);
  });
});

function input(reason: 'startup' | 'shutdown') {
  return {
    reason,
    logRegistryResult: vi.fn(),
    managedHostInstanceId: 'own-instance',
    appStartedAtMs: 5_000,
    profileScope: 'own-profile',
    cursorAgentAttribution: { readAttributedProcesses: async () => [] },
    ports: { logSweepResult: vi.fn(), logWarning: vi.fn(), logError: vi.fn() },
    releaseSharedRuntime: vi.fn(async () => {
      fixture.order.push('release');
    }),
  };
}

describe('OpenCode lifecycle cleanup admission', () => {
  it('never invokes global registry cleanup on shutdown and preserves a foreign registered host', async () => {
    const cleanupRegistry = vi.fn(async () => {
      // A shared registry force operation can reach this host despite its foreign marker.
      fixture.alive.delete(202);
      return { cleaned: 1, remaining: 0, hosts: [], diagnostics: [] };
    });
    const shutdown = input('shutdown');
    await runOpenCodeLifecycleHostCleanup({ ...shutdown, cleanupRegistry });

    expect(cleanupRegistry).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.alive.has(101)).toBe(true);
    expect(fixture.alive.has(202)).toBe(true);
    expect(fixture.order).toEqual(['release']);
    expect(shutdown.ports.logSweepResult).not.toHaveBeenCalled();
    expect(shutdown.ports.logWarning).toHaveBeenCalledWith(
      expect.stringContaining('retained native custody is required')
    );
  });

  it('retains missing-custody diagnostics and still releases the shared runtime', async () => {
    const shutdown = input('shutdown');
    await runOpenCodeLifecycleHostCleanup({ ...shutdown, cleanupRegistry: vi.fn() });

    expect(fixture.alive).toEqual(new Set([101, 202]));
    expect(shutdown.releaseSharedRuntime).toHaveBeenCalledOnce();
    expect(shutdown.ports.logWarning).toHaveBeenCalledWith(
      expect.stringContaining('retained native custody is required')
    );
  });

  it('preserves the startup stale-registry command and retained-host exclusion', async () => {
    const startup = input('startup');
    const cleanupRegistry = vi.fn(async () => ({
      cleaned: 0,
      remaining: 1,
      hosts: [
        {
          pid: 202,
          action: 'kept_leased' as const,
          hostKey: 'foreign',
          projectPath: '/tmp/TEST-foreign',
          port: 5_001,
          reason: 'active lease',
          leaseCount: 1,
        },
      ],
      diagnostics: [],
    }));
    await runOpenCodeLifecycleHostCleanup({ ...startup, cleanupRegistry });

    expect(cleanupRegistry).toHaveBeenCalledExactlyOnceWith({
      reason: 'startup',
      mode: 'stale',
      staleAgeMs: 5 * 60_000,
      leaseStaleAgeMs: 24 * 60 * 60_000,
      preflightLeaseStaleAgeMs: 6 * 60_000,
    });
    expect(cleanupManagedOpenCodeServeProcesses).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'orphaned',
        excludePids: new Set([202]),
        requiredProfileScope: 'own-profile',
        startedBeforeMs: 5_000,
      })
    );
    expect(startup.releaseSharedRuntime).not.toHaveBeenCalled();
  });

  it('preserves a startup registry failure and skips the unavailable-registry fallback', async () => {
    const startup = input('startup');
    const failure = new Error('TEST registry unavailable');
    const cleanupRegistry = vi.fn(async () => {
      throw failure;
    });
    await expect(runOpenCodeLifecycleHostCleanup({ ...startup, cleanupRegistry })).rejects.toBe(
      failure
    );
    expect(cleanupManagedOpenCodeServeProcesses).not.toHaveBeenCalled();
    expect(startup.ports.logWarning).toHaveBeenCalledWith(
      '[OpenCode] Startup fallback cleanup skipped because host registry cleanup is unavailable'
    );
  });
});
