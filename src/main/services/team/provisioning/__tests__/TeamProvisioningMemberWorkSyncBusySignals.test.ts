import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningMemberWorkSyncBusySignals } from '../TeamProvisioningMemberWorkSyncBusySignals';

describe('createTeamProvisioningMemberWorkSyncBusySignals', () => {
  it('puts pending approvals before side-effectful delivery checks', async () => {
    const getMemberToolApprovalBusyStatus = vi.fn(async () => ({
      busy: true,
      reason: 'pending_tool_approval',
      retryAfterIso: '2026-07-22T10:01:00.000Z',
    }));
    const getOpenCodeMemberDeliveryBusyStatus = vi.fn(async () => ({ busy: false }));
    const signals = createTeamProvisioningMemberWorkSyncBusySignals({
      getMemberToolApprovalBusyStatus,
      getOpenCodeMemberDeliveryBusyStatus,
    });
    const input = {
      teamName: 'sandbox-team',
      memberName: 'jack',
      nowIso: '2026-07-22T10:00:00.000Z',
    };

    await expect(signals.priorityBusySignals[0].isBusy(input)).resolves.toMatchObject({
      busy: true,
      reason: 'pending_tool_approval',
    });
    expect(getOpenCodeMemberDeliveryBusyStatus).not.toHaveBeenCalled();
  });
});
