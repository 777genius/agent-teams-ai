import { describe, expect, it, vi } from 'vitest';

import { createProjectDefinitionEditRouting } from '../../../../ipc/teams/teamProjectDefinitionEdit';
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

  it('admits a try-run inside its own roster lock, and stays busy for any other holder', async () => {
    const service = new TeamProvisioningService();
    const nested = vi.fn(async () => undefined);
    let insideOwnLock: boolean | undefined;
    await service.runLiveRosterMutation('Definition-Team', async () => {
      insideOwnLock = await service.tryRunLiveRosterMutation(' definition-team ', nested);
    });
    expect(insideOwnLock).toBe(true);
    expect(nested).toHaveBeenCalledOnce();

    // Another caller (not inside the held lock) is still refused while the lock is held.
    let release!: () => void;
    const held = service.runLiveRosterMutation('definition-team', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Promise.resolve();
    const outsider = vi.fn(async () => undefined);
    await expect(service.tryRunLiveRosterMutation('definition-team', outsider)).resolves.toBe(
      false
    );
    expect(outsider).not.toHaveBeenCalled();
    release();
    await held;
  });

  it('preserves reentrant ownership of both teams during nested logical and project writes', async () => {
    const service = new TeamProvisioningService();
    await service.runLiveRosterMutation('definition', async () => {
      await service.runLiveRosterMutation('project', async () => {
        const logical = vi.fn(async () => undefined);
        const physical = vi.fn(async () => undefined);
        await expect(service.tryRunLiveRosterMutation('definition', logical)).resolves.toBe(true);
        await expect(service.tryRunLiveRosterMutation('project', physical)).resolves.toBe(true);
        expect(logical).toHaveBeenCalledOnce();
        expect(physical).toHaveBeenCalledOnce();
      });
      await expect(
        service.tryRunLiveRosterMutation('definition', async () => undefined)
      ).resolves.toBe(true);
    });
  });

  it('does not reuse either nested ownership after both gates have been released', async () => {
    const service = new TeamProvisioningService();
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached!: Promise<boolean>;
    await service.runLiveRosterMutation('definition', () =>
      service.runLiveRosterMutation('project', async () => {
        detached = detachedGate.then(() =>
          service.tryRunLiveRosterMutation('definition', async () => undefined)
        );
      })
    );
    let releaseCurrent!: () => void;
    let currentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    const current = service.runLiveRosterMutation('definition', async () => {
      currentStarted();
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
    });
    await started;
    releaseDetached();
    await expect(detached).resolves.toBe(false);
    releaseCurrent();
    await current;
  });

  it('routes a live definition edit through both real reentrant gates', async () => {
    const service = new TeamProvisioningService();
    const written: string[] = [];
    const runConfigurationOperation = async <T>(
      name: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      let result!: T;
      await service.runLiveRosterMutation(name, async () => {
        result = await operation();
      });
      return result;
    };
    const editor = {
      classify: async () => 'logical',
      findRunningContextForEdit: async () => ({ executionTeamName: 'project', runId: 'run' }),
      projectToAliases: async () => ({ failed: [] }),
    };
    const journal = {
      hasPending: async () => false,
      begin: async () => undefined,
      clear: async () => undefined,
    };
    const handler = async (_event: unknown, name: unknown) => {
      await service.runLiveRosterMutation(String(name), async () => {
        written.push(String(name));
      });
      return { success: true as const, data: undefined };
    };
    const edit = createProjectDefinitionEditRouting(
      { data: () => ({ runConfigurationOperation }) } as never,
      () => editor as never,
      () => journal
    )(handler as never)({} as never, 'definition');
    const outcome = await Promise.race([
      edit,
      new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 1000)),
    ]);
    expect(outcome).toMatchObject({ success: true });
    expect(written).toEqual(['definition', 'project']);
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

  it('exposes an in-flight stop via the existing team operation admission lock', async () => {
    const service = new TeamProvisioningService();
    let releaseStop!: () => void;
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    const stopFlow = vi.fn(async () => {
      stopStarted();
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    });
    Object.assign(service as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        stopTeam: stopFlow,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });

    const stop = service.stopTeam(' Busy-Team ');
    await started;
    expect(service.hasTeamOperationInProgress('busy-team')).toBe(true);
    expect(service.hasTeamOperationInProgress('other-team')).toBe(false);

    releaseStop();
    await stop;
    expect(service.hasTeamOperationInProgress('busy-team')).toBe(false);
    expect(stopFlow).toHaveBeenCalledOnce();
  });

  it('publishes the per-team stop fence before queuing behind a team operation', async () => {
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
    expect(serviceInternals.getStopTeamGeneration('lock-team')).toBe(1);
    expect(stopFlow).not.toHaveBeenCalled();

    releaseOperation();
    await Promise.all([operation, stop]);
    expect(stopFlow).toHaveBeenCalledOnce();
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
    expect(restart).toHaveBeenCalledWith('lock-team', 'worker', undefined);
  });
});
