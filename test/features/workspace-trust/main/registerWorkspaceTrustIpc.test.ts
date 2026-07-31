import { WORKSPACE_TRUST_GET_PROJECT_STATUS } from '@features/workspace-trust/contracts';
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
  };
  registerWorkspaceTrustIpc(ipcMain as never, feature);
  return { feature, handlers, ipcMain };
}

describe('registerWorkspaceTrustIpc', () => {
  it('delegates a validated absolute project path', async () => {
    const { feature, handlers } = createHarness();

    await expect(
      handlers.get(WORKSPACE_TRUST_GET_PROJECT_STATUS)?.({}, { projectPath: ' /work/repo ' })
    ).resolves.toEqual({ status: 'untrusted' });
    expect(feature.getProjectStatus).toHaveBeenCalledWith({ projectPath: '/work/repo' });
  });

  it('fails safely for malformed input without reading provider state', async () => {
    const { feature, handlers } = createHarness();
    const handler = handlers.get(WORKSPACE_TRUST_GET_PROJECT_STATUS);

    await expect(handler?.({}, { projectPath: '' })).resolves.toEqual({ status: 'unknown' });
    await expect(handler?.({}, { projectPath: 'relative/repo' })).resolves.toEqual({
      status: 'unknown',
    });
    await expect(handler?.({}, null)).resolves.toEqual({ status: 'unknown' });
    expect(feature.getProjectStatus).not.toHaveBeenCalled();
  });

  it('removes the feature handler during app cleanup', () => {
    const { ipcMain } = createHarness();

    removeWorkspaceTrustIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(WORKSPACE_TRUST_GET_PROJECT_STATUS);
  });
});
