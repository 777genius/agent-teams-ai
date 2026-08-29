import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';

describe('team provisioning roster mutation lock', () => {
  it('atomically admits only one same-turn live roster mutation for a normalized team key', async () => {
    const service = new TeamProvisioningService();
    let release!: () => void;
    const firstMutation = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const secondMutation = vi.fn(async () => undefined);

    const first = service.tryRunLiveRosterMutation(' Busy-Team ', firstMutation);
    const second = service.tryRunLiveRosterMutation('busy-team', secondMutation);

    await expect(second).resolves.toBe(false);
    expect(firstMutation).toHaveBeenCalledOnce();
    expect(secondMutation).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toBe(true);
  });

  it('does not self-deadlock when the locked transaction delegates to member lifecycle', async () => {
    const service = new TeamProvisioningService();
    const lifecycleController = (
      service as unknown as {
        memberLifecycleController: {
          attachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
        };
      }
    ).memberLifecycleController;
    const attach = vi
      .spyOn(lifecycleController, 'attachLiveRosterMember')
      .mockResolvedValue(undefined);

    const outcome = await Promise.race([
      service
        .runLiveRosterMutation('lock-team', () =>
          service.attachLiveRosterMember('lock-team', 'worker')
        )
        .then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('deadlocked'), 100)),
    ]);

    expect(outcome).toBe('completed');
    expect(attach).toHaveBeenCalledWith('lock-team', 'worker', undefined);
  });

  it('does not let stale roster ownership bypass a later team operation', async () => {
    const service = new TeamProvisioningService();
    const serviceInternals = service as unknown as {
      memberLifecycleController: {
        attachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
      };
      withTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
    };
    const attach = vi
      .spyOn(serviceInternals.memberLifecycleController, 'attachLiveRosterMember')
      .mockResolvedValue(undefined);
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedOperation!: Promise<void>;

    await service.runLiveRosterMutation('lock-team', async () => {
      detachedOperation = (async () => {
        await detachedGate;
        await service.attachLiveRosterMember('lock-team', 'worker');
      })();
    });

    let releaseCurrent!: () => void;
    let currentStarted!: () => void;
    const currentStartedSignal = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    const currentOperation = serviceInternals.withTeamLock('lock-team', async () => {
      currentStarted();
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
    });
    await currentStartedSignal;

    releaseDetached();
    await Promise.resolve();
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();

    releaseCurrent();
    await Promise.all([currentOperation, detachedOperation]);
    expect(attach).toHaveBeenCalledWith('lock-team', 'worker', undefined);
  });

  it('publishes authorized stop intent before a deferred launch invocation is released', async () => {
    const service = new TeamProvisioningService();
    const activeRun = { cancelRequested: false };
    const cancellationInternals = service as unknown as {
      runs: Map<string, typeof activeRun>;
      runTracking: { getTrackedRunId(teamName: string): string | null };
    };
    cancellationInternals.runs.set('deferred-run', activeRun);
    vi.spyOn(cancellationInternals.runTracking, 'getTrackedRunId').mockReturnValue('deferred-run');
    const stopFlow = vi.fn(async (_teamName: string, onAuthorized?: () => void) => {
      onAuthorized?.();
    });
    Object.assign(service as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        preflightMetadataMutation: vi.fn(async () => undefined),
        authorizeStopTeam: async (_teamName: string, onAuthorized: () => void) => onAuthorized(),
        stopTeam: vi.fn(async () => undefined),
        stopAuthorizedTeam: stopFlow,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });

    let releaseInvocation!: () => void;
    let invocationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      invocationStarted = resolve;
    });
    const invocation = service.runLiveRosterMutation('lock-team', async () => {
      invocationStarted();
      await new Promise<void>((resolve) => {
        releaseInvocation = resolve;
      });
    });
    await started;

    let stopSettled = false;
    const stop = service.stopTeam('lock-team').then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(stopFlow).not.toHaveBeenCalled();
    expect(
      (
        service as unknown as { getStopTeamGeneration(teamName: string): number }
      ).getStopTeamGeneration('lock-team')
    ).toBe(1);
    expect(activeRun.cancelRequested).toBe(true);

    releaseInvocation();
    await Promise.all([invocation, stop]);

    expect(stopFlow).toHaveBeenCalledOnce();
  });

  it('publishes the per-team stop fence only after locked authorization', async () => {
    const service = new TeamProvisioningService();
    const stopFlow = vi.fn(async (_teamName: string, onAuthorized?: () => void) => {
      onAuthorized?.();
    });
    Object.assign(service as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        preflightMetadataMutation: vi.fn(async () => undefined),
        authorizeStopTeam: async (_teamName: string, onAuthorized: () => void) => onAuthorized(),
        stopTeam: vi.fn(async () => undefined),
        stopAuthorizedTeam: stopFlow,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });
    const serviceInternals = service as unknown as {
      withTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
      getStopTeamGeneration(teamName: string): number;
    };
    let releaseOperation!: () => void;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const operation = serviceInternals.withTeamLock('lock-team', async () => {
      operationStarted();
      await new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
    });
    await started;

    const stop = service.stopTeam('lock-team');
    await Promise.resolve();
    expect(serviceInternals.getStopTeamGeneration('lock-team')).toBe(1);
    expect(stopFlow).not.toHaveBeenCalled();

    releaseOperation();
    await Promise.all([operation, stop]);
    expect(stopFlow).toHaveBeenCalledOnce();
    expect(serviceInternals.getStopTeamGeneration('lock-team')).toBe(1);
  });

  it('releases roster ownership after rollback failure so stop and restart can recover', async () => {
    const service = new TeamProvisioningService();
    const stopFlow = vi.fn(async (_teamName: string, onAuthorized?: () => void) => {
      onAuthorized?.();
    });
    const serviceInternals = service as unknown as {
      memberLifecycleController: {
        restartMember(teamName: string, memberName: string): Promise<void>;
      };
      stopFlowBoundaryValue: unknown;
    };
    serviceInternals.stopFlowBoundaryValue = {
      preflightMetadataMutation: vi.fn(async () => undefined),
      authorizeStopTeam: async (_teamName: string, onAuthorized: () => void) => onAuthorized(),
      stopTeam: vi.fn(async () => undefined),
      stopAuthorizedTeam: stopFlow,
      stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
      stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
    };
    const restart = vi
      .spyOn(serviceInternals.memberLifecycleController, 'restartMember')
      .mockResolvedValue(undefined);

    await expect(
      service.runLiveRosterMutation('lock-team', async () => {
        throw new Error('rollback failed');
      })
    ).rejects.toThrow('rollback failed');

    await expect(service.stopTeam('lock-team')).resolves.toBeUndefined();
    await expect(service.restartMember('lock-team', 'worker')).resolves.toBeUndefined();

    expect(stopFlow).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith('lock-team', 'worker');
  });

  it('revalidates stop authority under the lock before publishing any cancellation fence', async () => {
    const service = new TeamProvisioningService();
    const rejected = new Error('Unsupported launch-state version: 999');
    const preflight = vi.fn<() => Promise<void>>().mockRejectedValueOnce(rejected);
    const firstEffect = vi.fn();
    Object.assign(service as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        preflightMetadataMutation: preflight,
        authorizeStopTeam: async (_teamName: string, onAuthorized: () => void) => {
          await preflight();
          onAuthorized();
          firstEffect();
        },
        stopTeam: vi.fn(async () => undefined),
        stopAuthorizedTeam: vi.fn(async () => undefined),
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });
    const internals = service as unknown as { getStopTeamGeneration(teamName: string): number };

    await expect(service.stopTeam('future-team')).rejects.toBe(rejected);

    expect(preflight).toHaveBeenCalledOnce();
    expect(internals.getStopTeamGeneration('future-team')).toBe(0);
    expect(firstEffect).not.toHaveBeenCalled();
  });
});
