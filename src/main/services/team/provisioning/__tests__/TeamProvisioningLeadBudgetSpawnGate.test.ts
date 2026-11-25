import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
}));

import { restartLeadRuntime } from '../TeamProvisioningLeadRuntimeRestart';

import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { ChildProcess } from 'node:child_process';

function child(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: { writable: true },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as ChildProcess;
}

describe('lead restart budget admission at actual spawn', () => {
  it('cannot spawn either a new lead or rollback after budget changes during shutdown', async () => {
    const target = {
      runId: 'run-1',
      teamName: 'alpha',
      request: { providerId: 'anthropic', model: 'old-model', effort: 'low' },
      child: child(100),
      spawnContext: {
        claudePath: '/bin/claude',
        args: ['--print', '--model', 'old-model', '--effort', 'low'],
        cwd: '/sandbox/team',
        env: { TEST_RUNTIME: '1' },
        prompt: '',
      },
      detectedSessionId: 'session-1',
      provisioningComplete: true,
      processClosed: false,
      processKilled: false,
      cancelRequested: false,
      leadActivityState: 'idle',
      activeToolCalls: new Map(),
      pendingApprovals: new Map(),
      authRetryInProgress: false,
      launchIdentity: null,
      mixedSecondaryLanes: [],
    } as unknown as ProvisioningRun;
    let exceeded = false;
    const beforeSpawn = vi.fn(async () => {
      if (exceeded) throw new Error('TEAM_BUDGET_BLOCKED');
    });
    const spawn = vi.fn(() => child(200));
    const killAndWait = vi.fn(async () => { exceeded = true; });
    const ports = {
      spawn,
      beforeSpawn,
      killAndWait,
      attachStdout: vi.fn(),
      attachStderr: vi.fn(),
      startStallWatchdog: vi.fn(),
      stopStallWatchdog: vi.fn(),
      handleProcessExit: vi.fn(async () => undefined),
      getAliveRunId: () => 'run-1',
      getRun: (id: string) => id === 'run-1' ? target : undefined,
      syncPersistedMetadata: vi.fn(async () => undefined),
      stopPersistentTeamMembers: vi.fn(() => true),
      hasSecondaryRuntimeRuns: vi.fn(() => false),
      stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
      invalidateRuntimeSnapshot: vi.fn(),
    };
    await expect(restartLeadRuntime({
      teamName: 'alpha',
      expectedRunId: 'run-1',
      before: { providerId: 'anthropic', model: 'old-model', effort: 'low' },
      after: { providerId: 'anthropic', model: 'new-model', effort: 'high' },
    }, ports)).rejects.toThrow();
    expect(killAndWait).toHaveBeenCalledOnce();
    expect(beforeSpawn).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });
});
