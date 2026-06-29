import {
  createMemberLifecycleOperationInProgressError,
  getMemberLifecycleOperationKey,
  isMemberLifecycleOperationInProgressError,
} from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleKeys';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningMemberLifecycle', () => {
  it('normalizes lifecycle operation keys by team and member identity', () => {
    expect(getMemberLifecycleOperationKey('  Alpha-Team ', ' Builder ')).toBe(
      getMemberLifecycleOperationKey('alpha-team', 'builder')
    );
    expect(getMemberLifecycleOperationKey('alpha-team', 'builder')).not.toBe(
      getMemberLifecycleOperationKey('alpha-team', 'reviewer')
    );
  });

  it('classifies lifecycle in-progress errors without matching unrelated failures', () => {
    const error = createMemberLifecycleOperationInProgressError('Builder');

    expect(error.message).toBe(
      'Lifecycle operation for teammate "Builder" is already in progress'
    );
    expect(isMemberLifecycleOperationInProgressError(error)).toBe(true);
    expect(
      isMemberLifecycleOperationInProgressError(new Error('Restart is already in progress'))
    ).toBe(false);
    expect(
      isMemberLifecycleOperationInProgressError('Lifecycle operation for teammate "Builder"')
    ).toBe(false);
  });
});
