import {
  TeamApplicationHost,
  TeamApplicationUnavailableError,
} from '@main/composition/team/TeamApplicationHost';
import { describe, expect, it, vi } from 'vitest';

import type { TeamApplicationHostPorts } from '@main/composition/team/TeamApplicationHostPorts';
import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamViewSnapshot,
} from '@shared/types/team';

const draftRequest: TeamCreateRequest = {
  teamName: 'draft-team',
  displayName: 'Draft Team',
  cwd: '/test/project',
  members: [],
};

const teamSnapshot = {
  teamName: 'demo-team',
  config: null,
  tasks: [],
  messages: [],
  processes: [],
  kanban: null,
  isAlive: false,
} as unknown as TeamViewSnapshot;

function runtimeState(teamName: string, isAlive: boolean): TeamRuntimeState {
  return {
    teamName,
    isAlive,
    runId: null,
    progress: null,
  };
}

function createHarness() {
  const hasConfig = vi.fn<(teamName: string) => Promise<boolean>>(() => Promise.resolve(true));
  const invalidate = vi.fn();
  const listTeams = vi.fn(() => Promise.resolve([]));
  const getTeamData = vi.fn(() => Promise.resolve(teamSnapshot));
  const getSavedRequest = vi.fn<(teamName: string) => Promise<TeamCreateRequest | null>>(() =>
    Promise.resolve(null)
  );
  const createTeamConfig = vi.fn<(request: TeamCreateConfigRequest) => Promise<void>>(() =>
    Promise.resolve()
  );
  const createTeam = vi.fn(
    (_request: TeamCreateRequest, _onProgress: (progress: TeamProvisioningProgress) => void) =>
      Promise.resolve({ runId: 'run-created' })
  );
  const launchTeam = vi.fn(
    (_request: TeamLaunchRequest, _onProgress: (progress: TeamProvisioningProgress) => void) =>
      Promise.resolve({ runId: 'run-launched' })
  );
  const getProvisioningStatus = vi.fn((_runId: string) =>
    Promise.resolve({
      runId: 'run-launched',
      teamName: 'demo-team',
      state: 'ready' as const,
      message: 'Ready',
      startedAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:01.000Z',
    })
  );
  const getRuntimeState = vi.fn((teamName: string) =>
    Promise.resolve(runtimeState(teamName, true))
  );
  const stopTeam = vi.fn((_teamName: string) => Promise.resolve());
  const getAliveTeams = vi.fn(() => ['alpha', 'beta']);
  const recordRuntimeBootstrapCheckin = vi.fn((_payload: unknown) =>
    Promise.resolve({
      ok: true as const,
      providerId: 'compatibility',
      teamName: 'demo-team',
      runId: 'run-runtime',
      state: 'accepted' as const,
      diagnostics: [],
      observedAt: '2026-07-31T00:00:02.000Z',
    })
  );
  const deliverRuntimeMessage = vi.fn((_payload: unknown) =>
    Promise.resolve({
      ok: true as const,
      providerId: 'compatibility',
      teamName: 'demo-team',
      runId: 'run-runtime',
      state: 'delivered' as const,
      diagnostics: [],
      observedAt: '2026-07-31T00:00:02.000Z',
    })
  );
  const recordRuntimeTaskEvent = vi.fn((_payload: unknown) =>
    Promise.resolve({
      ok: true as const,
      providerId: 'compatibility',
      teamName: 'demo-team',
      runId: 'run-runtime',
      state: 'recorded' as const,
      diagnostics: [],
      observedAt: '2026-07-31T00:00:02.000Z',
    })
  );
  const recordRuntimeHeartbeat = vi.fn((_payload: unknown) =>
    Promise.resolve({
      ok: true as const,
      providerId: 'compatibility',
      teamName: 'demo-team',
      runId: 'run-runtime',
      state: 'recorded' as const,
      diagnostics: [],
      observedAt: '2026-07-31T00:00:02.000Z',
    })
  );
  const repairStaleTaskActivityIntervalsBeforeSnapshot = vi.fn((_teamName: string) =>
    Promise.resolve()
  );
  const resumeTeam = vi.fn();

  const ports = {
    configPresence: { hasConfig },
    listInvalidation: { invalidate },
    data: {
      listTeams,
      getTeamData,
      getSavedRequest,
      createTeamConfig,
    },
    provisioningStart: {
      createTeam,
      launchTeam,
    },
    provisioningStatus: {
      getProvisioningStatus,
    },
    runtime: {
      getRuntimeState,
      stopTeam,
      getAliveTeams,
    },
    runtimeIngress: {
      recordRuntimeBootstrapCheckin,
      deliverRuntimeMessage,
      recordRuntimeTaskEvent,
      recordRuntimeHeartbeat,
    },
    taskActivity: {
      repairStaleTaskActivityIntervalsBeforeSnapshot,
    },
    resume: {
      resumeTeam,
    },
  } satisfies TeamApplicationHostPorts;

  return {
    host: new TeamApplicationHost(ports),
    ports,
    hasConfig,
    invalidate,
    listTeams,
    getTeamData,
    getSavedRequest,
    createTeamConfig,
    createTeam,
    launchTeam,
    getProvisioningStatus,
    getRuntimeState,
    stopTeam,
    getAliveTeams,
    recordRuntimeBootstrapCheckin,
    deliverRuntimeMessage,
    recordRuntimeTaskEvent,
    recordRuntimeHeartbeat,
    repairStaleTaskActivityIntervalsBeforeSnapshot,
    resumeTeam,
  };
}

describe('TeamApplicationHost', () => {
  it('delegates list and create through data capabilities and resumes only after create succeeds', async () => {
    const { host, listTeams, createTeamConfig, resumeTeam } = createHarness();
    const request: TeamCreateConfigRequest = {
      teamName: 'new-team',
      displayName: 'New Team',
      cwd: '/test/project',
      members: [],
    };

    await expect(host.listTeams()).resolves.toEqual([]);
    await expect(host.createTeamDraft(request)).resolves.toBeUndefined();

    expect(listTeams).toHaveBeenCalledOnce();
    expect(createTeamConfig).toHaveBeenCalledWith(request);
    expect(resumeTeam).toHaveBeenCalledWith('new-team');
    expect(createTeamConfig.mock.invocationCallOrder[0]).toBeLessThan(
      resumeTeam.mock.invocationCallOrder[0]
    );

    createTeamConfig.mockRejectedValueOnce(new Error('create failed'));
    await expect(host.createTeamDraft(request)).rejects.toThrow('create failed');
    expect(resumeTeam).toHaveBeenCalledTimes(1);
  });

  it('returns a pending draft without running snapshot or runtime reads', async () => {
    const {
      host,
      hasConfig,
      getSavedRequest,
      getTeamData,
      getRuntimeState,
      repairStaleTaskActivityIntervalsBeforeSnapshot,
    } = createHarness();
    hasConfig.mockResolvedValue(false);
    getSavedRequest.mockResolvedValue(draftRequest);

    await expect(host.getTeam('draft-team')).resolves.toEqual({
      teamName: 'draft-team',
      pendingCreate: true,
      savedRequest: draftRequest,
    });

    expect(getSavedRequest).toHaveBeenCalledWith('draft-team');
    expect(repairStaleTaskActivityIntervalsBeforeSnapshot).not.toHaveBeenCalled();
    expect(getTeamData).not.toHaveBeenCalled();
    expect(getRuntimeState).not.toHaveBeenCalled();
  });

  it('repairs before snapshot and overlays runtime liveness without making runtime read failure fatal', async () => {
    const { host, getTeamData, getRuntimeState, repairStaleTaskActivityIntervalsBeforeSnapshot } =
      createHarness();

    await expect(host.getTeam('demo-team')).resolves.toEqual({
      ...teamSnapshot,
      isAlive: true,
    });
    expect(repairStaleTaskActivityIntervalsBeforeSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      getTeamData.mock.invocationCallOrder[0]
    );
    expect(getTeamData.mock.invocationCallOrder[0]).toBeLessThan(
      getRuntimeState.mock.invocationCallOrder[0]
    );

    getRuntimeState.mockRejectedValueOnce(new Error('runtime unavailable'));
    await expect(host.getTeam('demo-team')).resolves.toEqual(teamSnapshot);
  });

  it('launches drafts through create and applies post-success resume and invalidation effects', async () => {
    const { host, hasConfig, getSavedRequest, createTeam, launchTeam, resumeTeam, invalidate } =
      createHarness();
    hasConfig.mockResolvedValue(false);
    getSavedRequest.mockResolvedValue(draftRequest);
    const createFromDraft = vi.fn(() => ({ ...draftRequest, cwd: '/test/override' }));
    const resumeExisting = vi.fn<() => TeamLaunchRequest>();

    await expect(
      host.launchTeam('draft-team', { createFromDraft, resumeExisting })
    ).resolves.toEqual({ runId: 'run-created' });

    expect(createFromDraft).toHaveBeenCalledWith(draftRequest);
    expect(resumeExisting).not.toHaveBeenCalled();
    expect(createTeam).toHaveBeenCalledWith(
      { ...draftRequest, cwd: '/test/override' },
      expect.any(Function)
    );
    expect(launchTeam).not.toHaveBeenCalled();
    expect(resumeTeam).toHaveBeenCalledWith('draft-team');
    expect(invalidate).toHaveBeenCalledOnce();
    expect(createTeam.mock.invocationCallOrder[0]).toBeLessThan(
      resumeTeam.mock.invocationCallOrder[0]
    );
    expect(resumeTeam.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0]
    );
  });

  it('launches existing teams without draft effects and does not invalidate failed launches', async () => {
    const { host, launchTeam, createTeam, resumeTeam, invalidate } = createHarness();
    const request: TeamLaunchRequest = {
      teamName: 'demo-team',
      cwd: '/test/project',
    };
    const createFromDraft = vi.fn<() => TeamCreateRequest>();
    const resumeExisting = vi.fn(() => request);

    await expect(
      host.launchTeam('demo-team', { createFromDraft, resumeExisting })
    ).resolves.toEqual({ runId: 'run-launched' });

    expect(resumeExisting).toHaveBeenCalledOnce();
    expect(createFromDraft).not.toHaveBeenCalled();
    expect(launchTeam).toHaveBeenCalledWith(request, expect.any(Function));
    expect(createTeam).not.toHaveBeenCalled();
    expect(resumeTeam).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledOnce();

    launchTeam.mockRejectedValueOnce(new Error('launch failed'));
    await expect(host.launchTeam('demo-team', { createFromDraft, resumeExisting })).rejects.toThrow(
      'launch failed'
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('delegates runtime and provisioning operations to their existing owners', async () => {
    const {
      host,
      getRuntimeState,
      stopTeam,
      getAliveTeams,
      getProvisioningStatus,
      recordRuntimeBootstrapCheckin,
      deliverRuntimeMessage,
      recordRuntimeTaskEvent,
      recordRuntimeHeartbeat,
    } = createHarness();

    await expect(host.getRuntimeState('demo-team')).resolves.toEqual(
      runtimeState('demo-team', true)
    );
    await expect(host.stopTeam('demo-team')).resolves.toEqual(runtimeState('demo-team', true));
    await expect(host.getProvisioningStatus('run-launched')).resolves.toMatchObject({
      runId: 'run-launched',
      teamName: 'demo-team',
    });
    await expect(host.listAliveRuntimeStates()).resolves.toEqual([
      runtimeState('alpha', true),
      runtimeState('beta', true),
    ]);
    await expect(host.recordRuntimeBootstrapCheckin({ kind: 'bootstrap' })).resolves.toMatchObject({
      state: 'accepted',
    });
    await expect(host.deliverRuntimeMessage({ kind: 'message' })).resolves.toMatchObject({
      state: 'delivered',
    });
    await expect(host.recordRuntimeTaskEvent({ kind: 'task' })).resolves.toMatchObject({
      state: 'recorded',
    });
    await expect(host.recordRuntimeHeartbeat({ kind: 'heartbeat' })).resolves.toMatchObject({
      state: 'recorded',
    });

    expect(stopTeam).toHaveBeenCalledWith('demo-team');
    expect(getRuntimeState).toHaveBeenCalledWith('demo-team');
    expect(getAliveTeams).toHaveBeenCalledOnce();
    expect(getProvisioningStatus).toHaveBeenCalledWith('run-launched');
    expect(recordRuntimeBootstrapCheckin).toHaveBeenCalledWith({ kind: 'bootstrap' });
    expect(deliverRuntimeMessage).toHaveBeenCalledWith({ kind: 'message' });
    expect(recordRuntimeTaskEvent).toHaveBeenCalledWith({ kind: 'task' });
    expect(recordRuntimeHeartbeat).toHaveBeenCalledWith({ kind: 'heartbeat' });
  });

  it('uses one typed unavailable error without importing transport or provider semantics', async () => {
    const requiredPorts: TeamApplicationHostPorts = {
      configPresence: { hasConfig: () => Promise.resolve(true) },
      listInvalidation: { invalidate: () => undefined },
    };
    const host = new TeamApplicationHost(requiredPorts);

    for (const operation of [
      () => host.listTeams(),
      () =>
        host.createTeamDraft({
          teamName: 'demo-team',
          displayName: 'Demo Team',
          cwd: '/test/project',
          members: [],
        }),
      () =>
        host.launchTeam('demo-team', {
          createFromDraft: () => draftRequest,
          resumeExisting: () => ({ teamName: 'demo-team', cwd: '/test/project' }),
        }),
      () => host.getRuntimeState('demo-team'),
      () => host.stopTeam('demo-team'),
      () => host.listAliveRuntimeStates(),
      () => host.getProvisioningStatus('run-1'),
      () => host.recordRuntimeBootstrapCheckin({}),
      () => host.deliverRuntimeMessage({}),
      () => host.recordRuntimeTaskEvent({}),
      () => host.recordRuntimeHeartbeat({}),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(TeamApplicationUnavailableError);
    }
  });
});
