import { createHash } from 'node:crypto';

import { createHostedPromotionStorageBackend } from '@features/internal-storage/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
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
  workspaceId: `workspace_${'c'.repeat(32)}`,
  declaredRootHash: createHash('sha256').update(workspaceRoot).digest('hex'),
} as never;

beforeEach(() => vi.resetAllMocks());

describe('standalone promotion storage startup', () => {
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
          mountBinding,
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
