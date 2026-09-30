import { createTeamBranchTrackingTransport } from '@renderer/composition/team/createTeamBranchTrackingTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setProjectBranchTracking: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      setProjectBranchTracking: mocks.setProjectBranchTracking,
    },
  },
}));

describe('createTeamBranchTrackingTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the narrow tracking capability to the legacy team API', async () => {
    mocks.setProjectBranchTracking.mockResolvedValueOnce(undefined);
    const transport = createTeamBranchTrackingTransport();

    await expect(transport.setTracking('/sandbox/project', true)).resolves.toBeUndefined();
    expect(mocks.setProjectBranchTracking).toHaveBeenCalledWith('/sandbox/project', true);
    expect(Object.keys(transport)).toEqual(['setTracking']);
  });

  it('preserves transport failures for the feature coordinator to contain', async () => {
    const failure = new Error('tracking unavailable');
    mocks.setProjectBranchTracking.mockRejectedValueOnce(failure);
    const transport = createTeamBranchTrackingTransport();

    await expect(transport.setTracking('/sandbox/project', false)).rejects.toBe(failure);
  });
});
