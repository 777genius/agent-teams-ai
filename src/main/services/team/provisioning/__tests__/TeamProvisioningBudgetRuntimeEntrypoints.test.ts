import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';

import type { TeamProvisioningMemberLifecycleOperationRunner } from '../TeamProvisioningMemberLifecycleOperationRunner';

function createBudgetedService(
  admit: (teamName: string) => Promise<void>
): TeamProvisioningService {
  return new TeamProvisioningService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    admit
  );
}

function restartController(service: TeamProvisioningService): {
  restartMember(teamName: string, memberName: string, secondary?: boolean): Promise<void>;
} {
  return Reflect.get(service, 'memberLifecycleController') as {
    restartMember(teamName: string, memberName: string, secondary?: boolean): Promise<void>;
  };
}

afterEach(() => vi.restoreAllMocks());

describe('budget checks at execution time of queued runtime operations', () => {
  it('rejects all runtime creation paths before touching native member controllers', async () => {
    const guard = vi.fn(async () => {
      throw new Error('TEAM_BUDGET_BLOCKED');
    });
    const service = createBudgetedService(guard);
    const restart = vi
      .spyOn(restartController(service), 'restartMember')
      .mockResolvedValue(undefined);
    const attempts = [
      () => service.restartMember('alpha', 'bob'),
      () => service.retryFailedOpenCodeSecondaryLanes('alpha'),
      () => service.attachLiveRosterMember('alpha', 'bob'),
      () => service.reattachOpenCodeOwnedMemberLane('alpha', 'bob'),
      () => service.rebootstrapOpenCodeAggregatePrimaryLane('alpha', 'recovery', null),
      () =>
        service.restartLeadRuntime({
          teamName: 'alpha',
          expectedRunId: 'run-1',
          before: { providerId: 'codex', model: null, effort: null },
          after: { providerId: 'codex', model: null, effort: null },
        }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    }
    expect(guard).toHaveBeenCalledTimes(attempts.length);
    expect(restart).not.toHaveBeenCalled();
  });

  it('rechecks after a queued team operation, preventing stale launch permission', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let exceeded = false;
    const admit = vi.fn(async () => {
      if (exceeded) throw new Error('TEAM_BUDGET_BLOCKED');
    });
    const service = createBudgetedService(admit);
    const restart = vi
      .spyOn(restartController(service), 'restartMember')
      .mockResolvedValue(undefined);
    const locks = Reflect.get(service, 'teamOpLocks') as Map<string, Promise<void>>;
    locks.set('alpha', pending);
    const operation = service.restartMember('alpha', 'bob');
    await Promise.resolve();
    expect(admit).not.toHaveBeenCalled();
    exceeded = true;
    release();
    await expect(operation).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    expect(admit).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(restart).not.toHaveBeenCalled();
  });

  it('does not start a member operation after Stop during budget admission', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admit = vi.fn(() => gate);
    const service = createBudgetedService(admit);
    const restart = vi
      .spyOn(restartController(service), 'restartMember')
      .mockResolvedValue(undefined);
    const generation = Reflect.get(service, 'stopTeamGenerationByTeam') as Map<string, number>;
    const operation = service.restartMember('alpha', 'bob');
    await vi.waitFor(() => expect(admit).toHaveBeenCalledWith('alpha'));
    generation.set('alpha', 1);
    release();
    await expect(operation).rejects.toThrow('superseded by Stop');
    expect(restart).not.toHaveBeenCalled();
  });

  it('rechecks budget after a preceding aggregate lifecycle operation', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let exceeded = false;
    const admit = vi.fn(async () => {
      if (exceeded) throw new Error('TEAM_BUDGET_BLOCKED');
    });
    const service = createBudgetedService(admit);
    const restart = vi
      .spyOn(restartController(service), 'restartMember')
      .mockResolvedValue(undefined);
    const internals = service as unknown as {
      runtimeAdapterRunByTeam: Map<string, { runId: string; providerId: string }>;
      memberLifecycleCompletionByKey: Map<
        string,
        { teamKey: string; token: symbol; completion: Promise<void> }
      >;
      openCodeAggregatePrimaryRestartByTeam: Map<string, unknown>;
      openCodePromptDeliveryWatchdogCoordinator: {
        wakeAfterRuntimeRegistration: () => Promise<void>;
      };
    };
    internals.runtimeAdapterRunByTeam.set('alpha', { runId: 'run-1', providerId: 'opencode' });
    internals.memberLifecycleCompletionByKey.set('preceding', {
      teamKey: 'alpha',
      token: Symbol('preceding'),
      completion: pending,
    });
    vi.spyOn(
      internals.openCodePromptDeliveryWatchdogCoordinator,
      'wakeAfterRuntimeRegistration'
    ).mockResolvedValue(undefined);
    const operation = service.restartMember('alpha', 'bob');
    await vi.waitFor(() =>
      expect(internals.openCodeAggregatePrimaryRestartByTeam.has('alpha')).toBe(true)
    );
    exceeded = true;
    release();
    await expect(operation).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(restart).not.toHaveBeenCalled();
    expect(internals.openCodeAggregatePrimaryRestartByTeam.has('alpha')).toBe(false);
  });

  it.each(['primary_member_added', 'opencode_member_updated'] as const)(
    'rechecks budget after the aggregate restart wait for %s',
    async (kind) => {
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      let exceeded = false;
      const admit = vi.fn(async (_teamName: string) => {
        if (exceeded) throw new Error('TEAM_BUDGET_BLOCKED');
      });
      const service = createBudgetedService(admit);
      const restarts = Reflect.get(service, 'openCodeAggregatePrimaryRestartByTeam') as Map<
        string,
        unknown
      >;
      restarts.set('alpha', { memberName: 'alice', runId: 'run-1', completion });
      const runner = Reflect.get(
        service,
        'memberLifecycleOperationRunner'
      ) as TeamProvisioningMemberLifecycleOperationRunner;
      const spawn = vi.fn(async () => undefined);

      // Simulate successful outer admission before entering the lifecycle wait.
      await admit('alpha');
      const operation = runner.runMemberLifecycleOperation('alpha', 'bob', kind, spawn);
      expect(spawn).not.toHaveBeenCalled();
      exceeded = true;
      release();
      await expect(operation).rejects.toThrow('TEAM_BUDGET_BLOCKED');
      expect(admit).toHaveBeenCalledTimes(2);
      expect(admit).toHaveBeenLastCalledWith('alpha');
      expect(spawn).not.toHaveBeenCalled();
      expect(runner.isMemberLifecycleOperationActive('alpha', 'bob')).toBe(false);
    }
  );

  it('rechecks budget before every retry lane even with no aggregate restart wait', async () => {
    let exceeded = false;
    const admit = vi.fn(async () => {
      if (exceeded) throw new Error('TEAM_BUDGET_BLOCKED');
    });
    const service = createBudgetedService(admit);
    const runner = Reflect.get(
      service,
      'memberLifecycleOperationRunner'
    ) as TeamProvisioningMemberLifecycleOperationRunner;
    const firstSpawn = vi.fn(async () => {
      // A later candidate must not inherit the first lane's admission.
      exceeded = true;
    });
    const secondSpawn = vi.fn(async () => undefined);
    await runner.runMemberLifecycleOperation('alpha', 'alice', 'opencode_retry', firstSpawn);
    await expect(
      runner.runMemberLifecycleOperation('alpha', 'bob', 'opencode_retry', secondSpawn)
    ).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    expect(firstSpawn).toHaveBeenCalledOnce();
    expect(secondSpawn).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it('does not start a member operation after Stop during aggregate admission', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admit = vi.fn(() => gate);
    const service = createBudgetedService(admit);
    const restarts = Reflect.get(service, 'openCodeAggregatePrimaryRestartByTeam') as Map<
      string,
      unknown
    >;
    restarts.set('alpha', {
      memberName: 'alice',
      runId: 'run-1',
      completion: Promise.resolve(),
    });
    const runner = Reflect.get(
      service,
      'memberLifecycleOperationRunner'
    ) as TeamProvisioningMemberLifecycleOperationRunner;
    const generation = Reflect.get(service, 'stopTeamGenerationByTeam') as Map<string, number>;
    const spawn = vi.fn(async () => undefined);
    const operation = runner.runMemberLifecycleOperation('alpha', 'bob', 'opencode_retry', spawn);
    await vi.waitFor(() => expect(admit).toHaveBeenCalledWith('alpha'));
    generation.set('alpha', 1);
    release();
    await expect(operation).rejects.toThrow('superseded by Stop');
    expect(spawn).not.toHaveBeenCalled();
    expect(runner.isMemberLifecycleOperationActive('alpha', 'bob')).toBe(false);
  });

  it('does not block member removal after an aggregate restart wait', async () => {
    const admit = vi.fn(async () => {
      throw new Error('TEAM_BUDGET_BLOCKED');
    });
    const service = createBudgetedService(admit);
    const restarts = Reflect.get(service, 'openCodeAggregatePrimaryRestartByTeam') as Map<
      string,
      unknown
    >;
    restarts.set('alpha', {
      memberName: 'alice',
      runId: 'run-1',
      completion: Promise.resolve(),
    });
    const runner = Reflect.get(
      service,
      'memberLifecycleOperationRunner'
    ) as TeamProvisioningMemberLifecycleOperationRunner;
    const remove = vi.fn(async () => undefined);
    await runner.runMemberLifecycleOperation('alpha', 'bob', 'primary_member_removed', remove);
    expect(remove).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
  });

  it('allows the original member controller to run after successful admission', async () => {
    const admit = vi.fn(async () => undefined);
    const service = createBudgetedService(admit);
    const restart = vi
      .spyOn(restartController(service), 'restartMember')
      .mockResolvedValue(undefined);
    await service.restartMember('alpha', 'bob', false);
    expect(admit).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(restart).toHaveBeenCalledExactlyOnceWith('alpha', 'bob', false);
  });
});
