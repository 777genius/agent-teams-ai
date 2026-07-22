import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningMemberLifecycleCompatibilityFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';

import type {
  TeamProvisioningCompatibilityDelegation,
  TeamProvisioningCompatibilityDelegationRun,
} from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

class TestMemberLifecycleCompatibilityFacade extends TeamProvisioningMemberLifecycleCompatibilityFacade {
  protected readonly compatibilityDelegation =
    {} as TeamProvisioningCompatibilityDelegation<TeamProvisioningCompatibilityDelegationRun>;
  protected readonly memberLifecycleFacade: TeamProvisioningMemberLifecyclePublicFacade;

  constructor(memberLifecycleFacade: TeamProvisioningMemberLifecyclePublicFacade) {
    super();
    this.memberLifecycleFacade = memberLifecycleFacade;
  }

  isOperationActive(teamName: string, memberName: string): boolean {
    return this.isMemberLifecycleOperationActive(teamName, memberName);
  }
}

describe('TeamProvisioningMemberLifecycleCompatibilityFacade', () => {
  it('delegates member lifecycle wrappers to the narrow lifecycle facade', async () => {
    const retryResult: RetryFailedOpenCodeSecondaryLanesResult = {
      attempted: ['Worker'],
      confirmed: [],
      pending: [],
      failed: [],
      skipped: [],
    };
    const memberLifecycleFacade = {
      isMemberLifecycleOperationActive: vi.fn(() => true),
      attachLiveRosterMember: vi.fn(async () => undefined),
      detachLiveRosterMember: vi.fn(async () => undefined),
      restartMember: vi.fn(async () => undefined),
      retryFailedOpenCodeSecondaryLanes: vi.fn(async () => retryResult),
      skipMemberForLaunch: vi.fn(async () => undefined),
      reattachOpenCodeOwnedMemberLane: vi.fn(async () => undefined),
      detachOpenCodeOwnedMemberLane: vi.fn(async () => undefined),
    } satisfies TeamProvisioningMemberLifecyclePublicFacade;
    const facade = new TestMemberLifecycleCompatibilityFacade(memberLifecycleFacade);

    expect(facade.isOperationActive('team-a', 'Worker')).toBe(true);
    await facade.attachLiveRosterMember('team-a', 'Worker', { reason: 'member_updated' });
    await facade.detachLiveRosterMember('team-a', 'Stale');
    await facade.restartMember('team-a', 'Worker');
    await expect(facade.retryFailedOpenCodeSecondaryLanes('team-a')).resolves.toBe(retryResult);
    await facade.skipMemberForLaunch('team-a', 'Blocked');
    await facade.reattachOpenCodeOwnedMemberLane('team-a', 'OpenCode Worker', {
      reason: 'manual_restart',
    });
    await facade.detachOpenCodeOwnedMemberLane('team-a', 'OpenCode Worker');

    expect(memberLifecycleFacade.isMemberLifecycleOperationActive).toHaveBeenCalledWith(
      'team-a',
      'Worker'
    );
    expect(memberLifecycleFacade.attachLiveRosterMember).toHaveBeenCalledWith('team-a', 'Worker', {
      reason: 'member_updated',
    });
    expect(memberLifecycleFacade.detachLiveRosterMember).toHaveBeenCalledWith('team-a', 'Stale');
    expect(memberLifecycleFacade.restartMember).toHaveBeenCalledWith('team-a', 'Worker');
    expect(memberLifecycleFacade.retryFailedOpenCodeSecondaryLanes).toHaveBeenCalledWith('team-a');
    expect(memberLifecycleFacade.skipMemberForLaunch).toHaveBeenCalledWith('team-a', 'Blocked');
    expect(memberLifecycleFacade.reattachOpenCodeOwnedMemberLane).toHaveBeenCalledWith(
      'team-a',
      'OpenCode Worker',
      { reason: 'manual_restart' }
    );
    expect(memberLifecycleFacade.detachOpenCodeOwnedMemberLane).toHaveBeenCalledWith(
      'team-a',
      'OpenCode Worker'
    );
  });
});
