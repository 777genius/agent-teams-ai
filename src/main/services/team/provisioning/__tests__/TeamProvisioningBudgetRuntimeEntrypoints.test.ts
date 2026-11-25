import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';
import { TeamProvisioningOpenCodeAggregatePrimaryFacade } from '../TeamProvisioningOpenCodeAggregatePrimaryFacade';

afterEach(() => vi.restoreAllMocks());

describe('budget admission on secondary runtime-spawning entrypoints', () => {
  it('refuses restart and recovery before touching the runtime when the budget is exhausted', async () => {
    const admission = vi.spyOn(
      TeamProvisioningService.prototype,
      'assertTeamBudgetAdmission'
    ).mockRejectedValue(new Error('TEAM_BUDGET_BLOCKED'));
    const runtimeRestart = vi.spyOn(
      TeamProvisioningOpenCodeAggregatePrimaryFacade.prototype,
      'restartMember'
    ).mockResolvedValue(undefined);
    const runtimeRetry = vi.spyOn(
      TeamProvisioningOpenCodeAggregatePrimaryFacade.prototype,
      'retryFailedOpenCodeSecondaryLanes'
    ).mockResolvedValue({ attempted: [], confirmed: [], pending: [], failed: [], skipped: [] });
    const runtimeAttach = vi.spyOn(
      TeamProvisioningOpenCodeAggregatePrimaryFacade.prototype,
      'attachLiveRosterMember'
    ).mockResolvedValue(undefined);
    const runtimeReattach = vi.spyOn(
      TeamProvisioningOpenCodeAggregatePrimaryFacade.prototype,
      'reattachOpenCodeOwnedMemberLane'
    ).mockResolvedValue(undefined);
    const runtimeBootstrap = vi.spyOn(
      TeamProvisioningOpenCodeAggregatePrimaryFacade.prototype,
      'rebootstrapOpenCodeAggregatePrimaryLane'
    ).mockResolvedValue(true);

    const service = new TeamProvisioningService();
    const attempts = [
      () => service.restartMember('alpha', 'bob'),
      () => service.retryFailedOpenCodeSecondaryLanes('alpha'),
      () => service.attachLiveRosterMember('alpha', 'bob'),
      () => service.reattachOpenCodeOwnedMemberLane('alpha', 'bob'),
      () => service.rebootstrapOpenCodeAggregatePrimaryLane('alpha', 'recovery', null),
      () => service.restartLeadRuntime({
        teamName: 'alpha',
        expectedRunId: 'run-1',
        before: { providerId: 'codex', model: null, effort: null },
        after: { providerId: 'codex', model: null, effort: null },
      }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    }
    expect(admission).toHaveBeenCalledTimes(attempts.length);
    expect(admission.mock.calls.map(([name]) => name)).toEqual(
      Array(attempts.length).fill('alpha')
    );
    for (const runtime of [
      runtimeRestart, runtimeRetry, runtimeAttach, runtimeReattach, runtimeBootstrap,
    ]) expect(runtime).not.toHaveBeenCalled();
  });

  it('still dispatches a permitted teammate restart to its existing runtime implementation', async () => {
    const admit = vi.spyOn(TeamProvisioningService.prototype, 'assertTeamBudgetAdmission')
      .mockResolvedValue(undefined);
    const restart = vi.spyOn(
      TeamProvisioningOpenCodeAggregatePrimaryFacade.prototype,
      'restartMember'
    ).mockResolvedValue(undefined);
    const service = new TeamProvisioningService();
    await service.restartMember('alpha', 'bob', false);
    expect(admit).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(restart).toHaveBeenCalledExactlyOnceWith('alpha', 'bob', false);
  });
});
