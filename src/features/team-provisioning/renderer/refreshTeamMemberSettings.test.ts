import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  refreshTeamData: vi.fn(),
}));

vi.mock('@renderer/store', () => ({
  useStore: { getState: store.getState, setState: store.setState },
}));

import { refreshTeamMemberSettings } from './refreshTeamMemberSettings';

describe('refreshTeamMemberSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.refreshTeamData.mockResolvedValue(undefined);
    store.getState.mockReturnValue({
      launchParamsByTeam: {},
      refreshTeamData: store.refreshTeamData,
    });
  });

  it('forces a fresh authoritative read without synthesizing a renderer override', async () => {
    await refreshTeamMemberSettings('alpha', {
      model: 'gpt-5.6-sol',
      effort: 'medium',
    });

    expect(store.setState).not.toHaveBeenCalled();
    expect(store.refreshTeamData).toHaveBeenCalledWith('alpha', { withDedup: false });
  });

  it('updates an existing lead launch cache before forcing the fresh read', async () => {
    store.getState.mockReturnValue({
      launchParamsByTeam: {
        alpha: { providerId: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      },
      refreshTeamData: store.refreshTeamData,
    });

    await refreshTeamMemberSettings('alpha', {
      model: 'gpt-5.6-sol',
      effort: 'medium',
    });

    expect(store.setState).toHaveBeenCalledOnce();
    expect(store.refreshTeamData).toHaveBeenCalledWith('alpha', { withDedup: false });
  });
});
