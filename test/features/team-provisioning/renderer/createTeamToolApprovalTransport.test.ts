import { createTeamToolApprovalTransport } from '@renderer/composition/team/createTeamToolApprovalTransport';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  respondToToolApproval: vi.fn(),
  updateToolApprovalSettings: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      respondToToolApproval: mocks.respondToToolApproval,
      updateToolApprovalSettings: mocks.updateToolApprovalSettings,
    },
  },
}));

describe('createTeamToolApprovalTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.respondToToolApproval.mockResolvedValue(undefined);
    mocks.updateToolApprovalSettings.mockResolvedValue(undefined);
  });

  it('forwards approval decisions and settings without changing their payloads', async () => {
    const transport = createTeamToolApprovalTransport();

    await transport.respond('sandbox-team', 'run-1', 'request-1', true, 'approved');
    await transport.updateSettings('sandbox-team', DEFAULT_TOOL_APPROVAL_SETTINGS);

    expect(mocks.respondToToolApproval).toHaveBeenCalledWith(
      'sandbox-team',
      'run-1',
      'request-1',
      true,
      'approved'
    );
    expect(mocks.updateToolApprovalSettings).toHaveBeenCalledWith(
      'sandbox-team',
      DEFAULT_TOOL_APPROVAL_SETTINGS
    );
  });

  it('preserves the original approval rejection for renderer feedback and retry policy', async () => {
    const transport = createTeamToolApprovalTransport();
    const decisionFailure = new Error('decision rejected');
    const settingsFailure = new Error('settings unavailable');
    mocks.respondToToolApproval.mockRejectedValueOnce(decisionFailure);
    mocks.updateToolApprovalSettings.mockRejectedValueOnce(settingsFailure);

    await expect(transport.respond('sandbox-team', 'run-1', 'request-1', false)).rejects.toBe(
      decisionFailure
    );
    await expect(
      transport.updateSettings('sandbox-team', DEFAULT_TOOL_APPROVAL_SETTINGS)
    ).rejects.toBe(settingsFailure);
  });
});
