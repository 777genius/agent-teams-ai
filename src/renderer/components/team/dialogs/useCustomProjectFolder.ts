import { useCallback } from 'react';

import {
  type ProjectFolderController,
  useProjectFolderState,
} from '@features/project-folder/renderer';
import { useStore } from '@renderer/store';

import type { TeamProviderId } from '@shared/types';

export interface CustomProjectFolderModel extends ProjectFolderController {
  /** Create Team makes a missing folder on submit; Launch requires it to exist already. */
  createsMissingOnSubmit: boolean;
  /** OpenCode reads project config during preflight, so it needs the folder before submit. */
  requiredBeforeSubmit: boolean;
  blocksSubmit: boolean;
}

export function useCustomProjectFolder(input: {
  enabled: boolean;
  path: string;
  createsMissingOnSubmit: boolean;
  providerIds: readonly TeamProviderId[];
  invalidatePrepareProvider: (providerId: TeamProviderId) => void;
}): CustomProjectFolderModel {
  const { createsMissingOnSubmit, providerIds, invalidatePrepareProvider } = input;
  const folder = useProjectFolderState({ enabled: input.enabled, path: input.path });
  const invalidateCliProviderModelCatalog = useStore(
    (state) => state.invalidateCliProviderModelCatalog
  );
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const createFolder = folder.create;

  const create = useCallback(async (): Promise<boolean> => {
    const created = await createFolder();
    if (created) {
      // Scoped runtime status, catalogs and local-model lookups all re-read on this revision.
      invalidateCliProviderModelCatalog?.();
      if (providerIds.includes('opencode') && folder.path) {
        void fetchCliProviderStatus?.('opencode', {
          silent: true,
          checkReason: 'launch_preflight',
          projectPath: folder.path,
        });
      }
      for (const providerId of providerIds) invalidatePrepareProvider(providerId);
    }
    return created;
  }, [
    createFolder,
    fetchCliProviderStatus,
    folder.path,
    invalidateCliProviderModelCatalog,
    invalidatePrepareProvider,
    providerIds,
  ]);

  return {
    ...folder,
    create,
    createsMissingOnSubmit,
    requiredBeforeSubmit: providerIds.includes('opencode'),
    blocksSubmit:
      folder.status === 'not_directory' || (folder.status === 'missing' && !createsMissingOnSubmit),
  };
}
