import { CLI_INSTALLER_GET_PROVIDER_STATUS } from '@preload/constants/ipcChannels';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';

const mocks = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

vi.mock('electron', () => mocks);

function getElectronApi(): ElectronAPI {
  const exposure = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'electronAPI'
  );
  if (!exposure) throw new Error('Expected electronAPI to be exposed');
  return exposure[1] as ElectronAPI;
}

describe('preload CLI provider status purpose boundary', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockReset();
    await import('../../src/preload/index');
  });

  it('forwards a required purpose and nonce and accepts matching observation metadata', async () => {
    const request = {
      purpose: 'launch-proof' as const,
      requestNonce: 'renderer-request-1',
      projectPath: '/tmp/static-project',
    };
    const response = {
      providerStatus: null,
      purpose: request.purpose,
      requestNonce: request.requestNonce,
      observationGeneration: 7,
      observationNonce: 'main-observation-1',
    };
    mocks.ipcRenderer.invoke.mockResolvedValue({ success: true, data: response });

    await expect(
      getElectronApi().cliInstaller.getProviderStatus('opencode', request)
    ).resolves.toEqual(response);
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      request
    );
  });

  it.each([
    ['omitted request', undefined],
    ['missing purpose', { requestNonce: 'legacy' }],
    ['invalid purpose', { purpose: 'catalog', requestNonce: 'legacy' }],
    ['missing nonce', { purpose: 'launch-proof' }],
  ])('rejects %s before invoking main', async (_label, request) => {
    await expect(
      getElectronApi().cliInstaller.getProviderStatus('opencode', request as never)
    ).rejects.toThrow(/request|purpose|nonce/i);
    expect(mocks.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed main observation metadata', async () => {
    mocks.ipcRenderer.invoke.mockResolvedValue({
      success: true,
      data: {
        providerStatus: null,
        purpose: 'launch-proof',
        requestNonce: 'renderer-request-2',
        observationGeneration: -1,
        observationNonce: '',
      },
    });

    await expect(
      getElectronApi().cliInstaller.getProviderStatus('opencode', {
        purpose: 'launch-proof',
        requestNonce: 'renderer-request-2',
      })
    ).rejects.toThrow(/response metadata/i);
  });
});
