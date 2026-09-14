import {
  WORKSPACE_TRUST_GET_LAUNCH_STATUS,
  WORKSPACE_TRUST_GET_PROJECT_STATUS,
} from '@features/workspace-trust/contracts';
import {
  registerWorkspaceTrustIpc,
  removeWorkspaceTrustIpc,
} from '@features/workspace-trust/main/adapters/input/registerWorkspaceTrustIpc';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustStatusFeatureFacade } from '@features/workspace-trust/main';

function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  };
  const feature: WorkspaceTrustStatusFeatureFacade = {
    getProjectStatus: vi.fn().mockResolvedValue({ status: 'untrusted' }),
    getLaunchStatus: vi
      .fn()
      .mockResolvedValue({ providers: [{ providerId: 'codex', status: 'launch_scoped' }] }),
  };
  registerWorkspaceTrustIpc(ipcMain as never, feature);
  return { feature, handlers, ipcMain };
}

describe('registerWorkspaceTrustIpc', () => {
  it('delegates legacy input unchanged to the common facade validator', async () => {
    const { feature, handlers } = createHarness();

    await expect(
      handlers.get(WORKSPACE_TRUST_GET_PROJECT_STATUS)?.({}, { projectPath: ' /work/repo ' })
    ).resolves.toEqual({ status: 'untrusted' });
    expect(feature.getProjectStatus).toHaveBeenCalledWith({ projectPath: ' /work/repo ' });
  });

  it('delegates launch input and provider-specific status without transforming it', async () => {
    const { feature, handlers } = createHarness();
    const request = { projectPath: '/work/repo', providerIds: ['codex'] };
    await expect(handlers.get(WORKSPACE_TRUST_GET_LAUNCH_STATUS)?.({}, request)).resolves.toEqual({
      providers: [{ providerId: 'codex', status: 'launch_scoped' }],
    });
    expect(feature.getLaunchStatus).toHaveBeenCalledWith(request);
  });

  it('lets the same facade validate malformed input on both channels', async () => {
    const { feature, handlers } = createHarness();
    await handlers.get(WORKSPACE_TRUST_GET_PROJECT_STATUS)?.({}, null);
    await handlers.get(WORKSPACE_TRUST_GET_LAUNCH_STATUS)?.({}, null);
    expect(feature.getProjectStatus).toHaveBeenCalledWith(null);
    expect(feature.getLaunchStatus).toHaveBeenCalledWith(null);
  });

  it('does not leak internal failures through either channel', async () => {
    const { feature, handlers } = createHarness();
    vi.mocked(feature.getProjectStatus).mockRejectedValue(new Error('/secret/config'));
    vi.mocked(feature.getLaunchStatus).mockRejectedValue(new Error('/secret/config'));
    await expect(handlers.get(WORKSPACE_TRUST_GET_PROJECT_STATUS)?.({}, null)).resolves.toEqual({
      status: 'unknown',
    });
    await expect(handlers.get(WORKSPACE_TRUST_GET_LAUNCH_STATUS)?.({}, null)).rejects.toThrow(
      'Workspace trust status unavailable'
    );
  });

  it('removes the feature handler during app cleanup', () => {
    const { ipcMain } = createHarness();

    removeWorkspaceTrustIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(WORKSPACE_TRUST_GET_PROJECT_STATUS);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(WORKSPACE_TRUST_GET_LAUNCH_STATUS);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2);
  });
});
