import {
  WORKSPACE_TRUST_GET_LAUNCH_STATUS,
  WORKSPACE_TRUST_GET_PROJECT_STATUS,
} from '@features/workspace-trust/contracts';
import { createWorkspaceTrustBridge } from '@features/workspace-trust/preload';
import { describe, expect, it, vi } from 'vitest';

describe('workspace trust preload bridge', () => {
  it('maps both methods to their channels with unmodified payload and result', async () => {
    const result = { providers: [{ providerId: 'codex', status: 'launch_scoped' }] };
    const invoke = vi.fn().mockResolvedValue(result);
    const { workspaceTrust } = createWorkspaceTrustBridge({ invoke } as never);
    const request = { projectPath: '/sandbox/repo', providerIds: ['codex'] as const };
    await expect(
      workspaceTrust.getLaunchStatus?.({ ...request, providerIds: [...request.providerIds] })
    ).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith(WORKSPACE_TRUST_GET_LAUNCH_STATUS, request);
    invoke.mockResolvedValue({ status: 'trusted' });
    await expect(
      workspaceTrust.getProjectStatus({ projectPath: request.projectPath })
    ).resolves.toEqual({ status: 'trusted' });
    expect(invoke).toHaveBeenLastCalledWith(WORKSPACE_TRUST_GET_PROJECT_STATUS, {
      projectPath: request.projectPath,
    });
  });

  it('propagates an old-main missing-channel rejection for the hook fallback', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('No handler registered'));
    const { workspaceTrust } = createWorkspaceTrustBridge({ invoke } as never);
    await expect(
      workspaceTrust.getLaunchStatus?.({ projectPath: '/sandbox', providerIds: ['codex'] })
    ).rejects.toThrow('No handler registered');
  });
});
