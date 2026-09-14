import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginOpenCodeStartupRuntimeSweep,
  OpenCodeStartupCleanupBusyError,
  whenOpenCodeStartupRuntimeSweepSettled,
} from '../../opencode/bridge/OpenCodeStartupSweepGate';
import {
  bindTeamHttpHandlerApis,
  bindTeamIpcHandlerApis,
  bindTeamProvisioningStartApi,
} from '../TeamProvisioningApis';

import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types/team';

vi.mock('../../opencode/bridge/OpenCodeHostStartupLockCleanup', () => ({
  purgeStaleOpenCodeHostStartupLocksBeforeLaunch: vi.fn().mockResolvedValue(undefined),
}));

const createRequest: TeamCreateRequest = {
  teamName: 'cleanup-gate-fixture',
  cwd: '/sandbox/cleanup-gate-fixture',
  providerId: 'anthropic',
  members: [{ name: 'worker', role: 'Worker', providerId: 'opencode' }],
};
const launchRequest: TeamLaunchRequest = {
  teamName: createRequest.teamName,
  cwd: createRequest.cwd,
  providerId: 'anthropic',
};

function fixture(transport: 'ipc' | 'http') {
  const createTeam = vi.fn().mockResolvedValue({ runId: 'created' });
  const launchTeam = vi.fn().mockResolvedValue({ runId: 'launched' });
  const declared: Record<string, unknown> = {
    createTeam,
    launchTeam,
    getAliveTeams: () => [],
  };
  const source = new Proxy(declared, {
    get: (target, key: string) => target[key] ?? vi.fn(),
  }) as unknown as Parameters<typeof bindTeamIpcHandlerApis>[0] &
    Parameters<typeof bindTeamHttpHandlerApis>[0];
  const api = (transport === 'ipc' ? bindTeamIpcHandlerApis : bindTeamHttpHandlerApis)(
    source
  ).provisioningStart;
  return { api, createTeam, launchTeam };
}

describe('Windows startup cleanup admission', () => {
  let release: () => void;
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.useFakeTimers();
    release = beginOpenCodeStartupRuntimeSweep();
  });
  afterEach(() => {
    release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['ipc', 'http'] as const)(
    '%s refuses mixed create and unknown saved launch without delayed forwarding; manual retry works',
    async (transport) => {
      const { api, createTeam, launchTeam } = fixture(transport);
      const onProgress = vi.fn();
      await expect(api.createTeam(createRequest, onProgress)).rejects.toBeInstanceOf(
        OpenCodeStartupCleanupBusyError
      );
      await expect(api.launchTeam(launchRequest, onProgress)).rejects.toThrow(/retry/);
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(api.launchTeam(launchRequest, onProgress)).rejects.toBeInstanceOf(
        OpenCodeStartupCleanupBusyError
      );
      expect(createTeam).not.toHaveBeenCalled();
      expect(launchTeam).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
      release();
      await vi.runAllTimersAsync();
      expect(createTeam).not.toHaveBeenCalled();
      expect(launchTeam).not.toHaveBeenCalled();
      await expect(api.createTeam(createRequest, onProgress)).resolves.toEqual({
        runId: 'created',
      });
      await expect(api.launchTeam(launchRequest, onProgress)).resolves.toEqual({
        runId: 'launched',
      });
      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(launchTeam).toHaveBeenCalledTimes(1);
    }
  );

  it('admits a known non-OpenCode create roster while cleanup is pending', async () => {
    const { api, createTeam } = fixture('ipc');
    await api.createTeam({ ...createRequest, members: [] }, vi.fn());
    await api.createTeam(
      { ...createRequest, members: [{ name: 'worker', role: 'Worker', providerId: 'codex' }] },
      vi.fn()
    );
    expect(createTeam).toHaveBeenCalledTimes(2);
    await expect(whenOpenCodeStartupRuntimeSweepSettled()).rejects.toBeInstanceOf(
      OpenCodeStartupCleanupBusyError
    );
  });

  it.each(['opencode', undefined] as const)('gates create provider %s', async (providerId) => {
    const { api, createTeam } = fixture('ipc');
    await expect(
      api.createTeam({ ...createRequest, providerId, members: [] }, vi.fn())
    ).rejects.toBeInstanceOf(OpenCodeStartupCleanupBusyError);
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('does not install a timeout or progress callback for a rejected waiter', async () => {
    const onWaitStart = vi.fn();
    await expect(
      whenOpenCodeStartupRuntimeSweepSettled({ timeoutMs: 0, onWaitStart })
    ).rejects.toBeInstanceOf(OpenCodeStartupCleanupBusyError);
    expect(vi.getTimerCount()).toBe(0);
    expect(onWaitStart).not.toHaveBeenCalled();
    await expect(whenOpenCodeStartupRuntimeSweepSettled()).rejects.toBeInstanceOf(
      OpenCodeStartupCleanupBusyError
    );
  });

  it('swallows ordinary preparation errors for both operations, even with the busy error name', async () => {
    const { createTeam, launchTeam } = fixture('ipc');
    const error = new Error('ordinary preparation failure');
    error.name = 'OpenCodeStartupCleanupBusyError';
    const api = bindTeamProvisioningStartApi(
      { createTeam, launchTeam },
      { beforeStart: () => Promise.reject(error) }
    );
    await api.createTeam(createRequest, vi.fn());
    await api.launchTeam(launchRequest, vi.fn());
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(launchTeam).toHaveBeenCalledTimes(1);
  });
});

describe.each(['linux', 'darwin'])('%s startup sweep compatibility', (platform) => {
  let release: () => void;
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform });
    vi.useFakeTimers();
    release = beginOpenCodeStartupRuntimeSweep();
  });
  afterEach(() => {
    release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits before forwarding a mixed create and forwards once after release', async () => {
    const { api, createTeam } = fixture('ipc');
    const onProgress = vi.fn();
    const started = api.createTeam(createRequest, onProgress);
    await vi.advanceTimersByTimeAsync(1);
    expect(createTeam).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(1);
    release();
    await started;
    expect(createTeam).toHaveBeenCalledTimes(1);
  });

  it('retains the bounded waiter timeout and non-OpenCode saved lead bypass', async () => {
    const { api, launchTeam } = fixture('ipc');
    await api.launchTeam(launchRequest, vi.fn());
    expect(launchTeam).toHaveBeenCalledTimes(1);
    const logWaited = vi.fn();
    const waiting = whenOpenCodeStartupRuntimeSweepSettled({ timeoutMs: 10, logWaited });
    await vi.advanceTimersByTimeAsync(10);
    await waiting;
    expect(logWaited).toHaveBeenCalledWith(expect.stringContaining('settled=false'));
    const onWaitStart = vi.fn();
    await whenOpenCodeStartupRuntimeSweepSettled({ onWaitStart });
    expect(onWaitStart).not.toHaveBeenCalled();
  });
});
