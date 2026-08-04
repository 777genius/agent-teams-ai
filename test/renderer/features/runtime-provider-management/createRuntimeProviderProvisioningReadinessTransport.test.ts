import { createRuntimeProviderProvisioningReadinessTransport } from '@renderer/composition/team/createRuntimeProviderProvisioningReadinessTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningPrepareResult } from '@shared/types';

const mocks = vi.hoisted(() => ({
  prepareProvisioning: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      prepareProvisioning: mocks.prepareProvisioning,
    },
  },
}));

describe('createRuntimeProviderProvisioningReadinessTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the local model readiness check with the existing preparation arguments', async () => {
    const result: TeamProvisioningPrepareResult = {
      ready: true,
      message: 'ready',
      warnings: ['warm-up recommended'],
    };
    mocks.prepareProvisioning.mockResolvedValueOnce(result);
    const transport = createRuntimeProviderProvisioningReadinessTransport();

    await expect(transport.checkReadiness('/sandbox/project', 'ollama/qwen3:8b')).resolves.toBe(
      result
    );
    expect(mocks.prepareProvisioning).toHaveBeenCalledWith(
      '/sandbox/project',
      'opencode',
      ['opencode'],
      ['ollama/qwen3:8b'],
      false,
      'deep'
    );
  });

  it('preserves readiness failures for the setup dialog to classify', async () => {
    const failure = new Error('readiness failed');
    mocks.prepareProvisioning.mockRejectedValueOnce(failure);
    const transport = createRuntimeProviderProvisioningReadinessTransport();

    await expect(transport.checkReadiness('/sandbox/project', 'ollama/qwen3:8b')).rejects.toBe(
      failure
    );
  });
});
