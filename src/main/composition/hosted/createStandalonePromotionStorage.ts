import { createHash } from 'node:crypto';

import { getInternalStorageDatabasePath } from '@features/internal-storage/main';
// eslint-disable-next-line no-restricted-imports -- Hosted storage composition is main-process-only.
import { createHostedPromotionStorageBackend } from '@features/internal-storage/main/hosted';

import { admitHostedReadRoot } from '../../standaloneHostedReadRoot';

import { createHostedTeamMessageRouteFactory } from './hostedTeamMessageComposition';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

type MountBinding = Parameters<typeof createHostedTeamMessageRouteFactory>[0]['mountBinding'];

export async function createStandalonePromotionStorage(options: {
  readonly authDataDirectory: string;
  readonly runtimeInstance: RuntimeInstanceContext | null;
  readonly mountBinding: MountBinding | null | undefined;
  readonly draftPublicationAvailable: boolean;
  readonly restoreGeneration: number;
}) {
  const { runtimeInstance, mountBinding } = options;
  const promotionRoot =
    runtimeInstance?.workspaceRoots.length === 1
      ? admitHostedReadRoot(runtimeInstance.workspaceRoots[0].reference)
      : null;
  // The signed mount is a boot identity. A remount requires stopping this process and its worker.
  if (
    !options.draftPublicationAvailable ||
    mountBinding?.health !== 'healthy' ||
    promotionRoot === null ||
    createHash('sha256').update(promotionRoot).digest('hex') !== mountBinding.declaredRootHash ||
    runtimeInstance === null
  ) {
    return { promotionRoot, promotionStorage: null };
  }
  const promotionStorage = createHostedPromotionStorageBackend(
    getInternalStorageDatabasePath(options.authDataDirectory),
    {
      deploymentId: runtimeInstance.deploymentId,
      runtimeWorkspaceId: mountBinding.workspaceId,
      admittedWorkspaceRoot: promotionRoot,
      restoreGeneration: options.restoreGeneration,
    }
  );
  try {
    await promotionStorage.initialize();
  } catch (error) {
    try {
      await promotionStorage.dispose();
    } catch {
      // Preserve the initialization failure that stopped startup.
    }
    throw error;
  }
  return { promotionRoot, promotionStorage };
}
