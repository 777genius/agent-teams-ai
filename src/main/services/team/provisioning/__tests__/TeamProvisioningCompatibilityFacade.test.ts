import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningCompatibilityFacade } from '../TeamProvisioningCompatibilityFacade';

import type {
  TeamProvisioningCompatibilityDelegation,
  TeamProvisioningCompatibilityDelegationRun,
} from '../TeamProvisioningCompatibilityFacade';

class TestCompatibilityFacade extends TeamProvisioningCompatibilityFacade {
  protected readonly compatibilityDelegation: TeamProvisioningCompatibilityDelegation<TeamProvisioningCompatibilityDelegationRun>;

  constructor(
    compatibilityDelegation = {} as TeamProvisioningCompatibilityDelegation<TeamProvisioningCompatibilityDelegationRun>
  ) {
    super();
    this.compatibilityDelegation = compatibilityDelegation;
  }
}

describe('TeamProvisioningCompatibilityFacade', () => {
  it('delegates provisioning status through the composed feature', async () => {
    const runs = new Map();
    const progress = {
      runId: 'run-retained-progress',
      teamName: 'retained-progress-team',
      state: 'failed',
      message: 'CLI exited quickly',
      startedAt: '2026-04-19T10:00:00.000Z',
      updatedAt: '2026-04-19T10:00:01.000Z',
      error: 'bootstrap failed',
      warnings: ['retry is safe'],
    };
    const getProvisioningStatus = vi.fn(() => Promise.resolve(progress));
    const facade = new TestCompatibilityFacade({
      provisioningStatus: {
        getProvisioningStatus,
      },
      retainedProvisioningProgressState: {
        retainProvisioningProgress: vi.fn(),
      },
      runs,
    } as unknown as TeamProvisioningCompatibilityDelegation<TeamProvisioningCompatibilityDelegationRun>);

    await expect(facade.getProvisioningStatus('run-retained-progress')).resolves.toBe(progress);
    expect(getProvisioningStatus).toHaveBeenCalledWith('run-retained-progress');
  });
});
