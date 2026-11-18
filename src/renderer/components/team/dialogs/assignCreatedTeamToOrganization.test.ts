import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assign: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: { organizations: { assignTeamToUnit: mocks.assign } },
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({
  confirm: mocks.confirm,
}));

import { assignCreatedTeamToOrganization } from './assignCreatedTeamToOrganization';

const input = {
  placement: { organizationId: 'test-org', parentUnitId: 'root-unit' },
  teamName: 'created-test-team',
  label: 'Test team',
  failureTitle: 'Team created, not placed',
  failureMessage: 'Assign it from the Organization Map',
  acknowledgeLabel: 'Got it',
};

describe('organization placement after accepted team creation', () => {
  beforeEach(() => {
    mocks.assign.mockReset().mockResolvedValue(undefined);
    mocks.confirm.mockReset().mockResolvedValue(true);
  });

  it('assigns only the already created team and does not warn on success', async () => {
    await assignCreatedTeamToOrganization(input);

    expect(mocks.assign).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'test-org',
      parentUnitId: 'root-unit',
      teamName: 'created-test-team',
      label: 'Test team',
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('reports placement failure without presenting it as a failed creation', async () => {
    mocks.assign.mockRejectedValueOnce(new Error('organization unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(assignCreatedTeamToOrganization(input)).resolves.toBeUndefined();
      expect(mocks.assign).toHaveBeenCalledTimes(1);
      expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({
        mode: 'info',
        title: input.failureTitle,
        message: input.failureMessage,
        confirmLabel: input.acknowledgeLabel,
      });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not try to assign a team without an organization selection', async () => {
    await assignCreatedTeamToOrganization({ ...input, placement: null });
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
