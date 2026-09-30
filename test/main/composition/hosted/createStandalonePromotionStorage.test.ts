import { createHash } from 'node:crypto';

import { createHostedPromotionStorageBackend } from '@features/internal-storage/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { matchSignedWorkspaceRoot } from '@main/composition/hosted/admittedWorkspaceRootResolver';
import { createStandalonePromotionStorage } from '@main/composition/hosted/createStandalonePromotionStorage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/internal-storage/main/hosted', () => ({
  createHostedPromotionStorageBackend: vi.fn(),
}));

const workspaceRoot = '/tmp/standalone-promotion-storage-test';
const runtimeInstance = createRuntimeInstanceContext({
  deploymentId: `deployment_${'a'.repeat(32)}`,
  bootId: `boot_${'b'.repeat(32)}`,
  claudeRoot: { kind: 'claude', reference: '/tmp/standalone-promotion-claude' },
  appDataRoot: { kind: 'app-data', reference: '/tmp/standalone-promotion-app-data' },
  workspaceRoots: [{ kind: 'workspace', reference: workspaceRoot }],
  tempRoot: { kind: 'temp', reference: '/tmp/standalone-promotion-temp' },
  logsRoot: { kind: 'logs', reference: '/tmp/standalone-promotion-logs' },
});
const mountBinding = {
  health: 'healthy',
  bootId: runtimeInstance.bootId,
  workspaceId: `workspace_${'c'.repeat(32)}`,
  declaredRootHash: createHash('sha256').update(workspaceRoot).digest('hex'),
};

beforeEach(() => vi.resetAllMocks());

describe('standalone promotion storage startup', () => {
  it('keeps the single A root and selects A after signed A/B reorder', async () => {
    const otherRoot = '/tmp/standalone-promotion-storage-other';
    const roots = [workspaceRoot, otherRoot];
    for (const order of [[workspaceRoot], roots, [...roots].reverse()]) {
      const instance = createRuntimeInstanceContext({
        ...runtimeInstance,
        workspaceRoots: order.map((reference) => ({ kind: 'workspace', reference })),
      });
      const dispose = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createHostedPromotionStorageBackend).mockReturnValue({
        promotions: {} as never,
        hostedRuns: {} as never,
        currentAuthority: {} as never,
        initialize: vi.fn().mockResolvedValue(undefined),
        dispose,
      });
      const result = await createStandalonePromotionStorage({
        authDataDirectory: '/tmp/standalone-promotion-auth',
        runtimeInstance: instance,
        mountBinding: mountBinding as never,
        draftPublicationAvailable: true,
        restoreGeneration: 1,
      });
      expect(result.promotionRoot).toBe(workspaceRoot);
      expect(createHostedPromotionStorageBackend).toHaveBeenLastCalledWith(
        '/tmp/standalone-promotion-auth/storage/app.db',
        expect.objectContaining({
          runtimeWorkspaceId: mountBinding.workspaceId,
          admittedWorkspaceRoot: workspaceRoot,
        })
      );
      await result.promotionStorage?.dispose();
    }
  });

  it('fails closed for missing, duplicate, mismatched, and foreign signed mounts', async () => {
    const mismatched = { ...mountBinding, declaredRootHash: 'f'.repeat(64) };
    const foreignBoot = { ...mountBinding, bootId: `boot_${'f'.repeat(32)}` };
    const instances = [
      createRuntimeInstanceContext({ ...runtimeInstance, workspaceRoots: [] }),
      createRuntimeInstanceContext({
        ...runtimeInstance,
        workspaceRoots: [runtimeInstance.workspaceRoots[0], runtimeInstance.workspaceRoots[0]],
      }),
    ];
    for (const [instance, binding] of [
      [instances[0], mountBinding],
      [instances[1], mountBinding],
      [runtimeInstance, mismatched],
      [runtimeInstance, foreignBoot],
    ] as const) {
      const result = await createStandalonePromotionStorage({
        authDataDirectory: '/tmp/standalone-promotion-auth',
        runtimeInstance: instance,
        mountBinding: binding as never,
        draftPublicationAvailable: true,
        restoreGeneration: 1,
      });
      expect(result).toEqual({ promotionRoot: null, promotionStorage: null });
    }
    expect(createHostedPromotionStorageBackend).not.toHaveBeenCalled();
    expect(matchSignedWorkspaceRoot(runtimeInstance, 'not-a-hash')).toBeNull();
  });

  it.each([false, true])(
    'closes the worker after failed initialization and preserves the failure when dispose rejects=%s',
    async (disposeRejects) => {
      const initializationFailure = new Error('promotion-storage-initialization-failed');
      const dispose = vi.fn(() =>
        disposeRejects
          ? Promise.reject(new Error('promotion-storage-disposal-failed'))
          : Promise.resolve()
      );
      vi.mocked(createHostedPromotionStorageBackend).mockReturnValue({
        promotions: {} as never,
        hostedRuns: {} as never,
        currentAuthority: {} as never,
        initialize: vi.fn().mockRejectedValue(initializationFailure),
        dispose,
      });

      await expect(
        createStandalonePromotionStorage({
          authDataDirectory: '/tmp/standalone-promotion-auth',
          runtimeInstance,
          mountBinding: mountBinding as never,
          draftPublicationAvailable: true,
          restoreGeneration: 1,
        })
      ).rejects.toBe(initializationFailure);
      expect(createHostedPromotionStorageBackend).toHaveBeenCalledOnce();
      expect(createHostedPromotionStorageBackend).toHaveBeenCalledWith(
        '/tmp/standalone-promotion-auth/storage/app.db',
        expect.objectContaining({ runtimeIsolation: 'trusted_process' })
      );
      expect(dispose).toHaveBeenCalledOnce();
    }
  );
});
