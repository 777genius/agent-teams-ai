import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';

describe('team provisioning roster mutation lock', () => {
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

  it('serializes stop behind a complete live roster mutation transaction', async () => {
    const service = new TeamProvisioningService();
    const stopFlow = vi.fn(async () => undefined);
    Object.assign(service as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        stopTeam: stopFlow,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });

    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const mutation = service.runLiveRosterMutation('lock-team', async () => {
      mutationStarted();
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
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

    releaseMutation();
    await Promise.all([mutation, stop]);

    expect(stopFlow).toHaveBeenCalledOnce();
  });

  it('does not queue stop behind a non-roster team operation', async () => {
    const service = new TeamProvisioningService();
    const stopFlow = vi.fn(async () => undefined);
    Object.assign(service as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        stopTeam: stopFlow,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });
    const serviceInternals = service as unknown as {
      withTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
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
    expect(stopFlow).toHaveBeenCalledOnce();

    releaseOperation();
    await Promise.all([operation, stop]);
  });

  it('releases roster ownership after rollback failure so stop and restart can recover', async () => {
    const service = new TeamProvisioningService();
    const stopFlow = vi.fn(async () => undefined);
    const serviceInternals = service as unknown as {
      memberLifecycleController: {
        restartMember(teamName: string, memberName: string): Promise<void>;
      };
      stopFlowBoundaryValue: unknown;
    };
    serviceInternals.stopFlowBoundaryValue = {
      stopTeam: stopFlow,
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
});
