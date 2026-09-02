import React, { useMemo } from 'react';

import { useOpenCodeProviderModelCatalog } from '@features/runtime-provider-management/renderer';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';

import {
  type OpenCodeProviderScopedStatusListener,
  usePublishOpenCodeProviderScopedStatus,
} from './useOpenCodeProviderScopedModelAuthority';

import type { CliProviderStatus } from '@shared/types';

type ScopedCatalogLoaderProps = Readonly<{
  projectPath: string | null;
  sourceProviderId: string;
  passiveProviderStatus: CliProviderStatus | null | undefined;
  listener: OpenCodeProviderScopedStatusListener;
}>;

const ScopedCatalogLoader = ({
  projectPath,
  sourceProviderId,
  passiveProviderStatus,
  listener,
}: ScopedCatalogLoaderProps): null => {
  const catalog = useOpenCodeProviderModelCatalog({
    enabled: true,
    sourceProviderId,
    projectPath,
    passiveProviderStatus,
  });
  const fresh = catalog.status === 'ready' && catalog.catalogState === 'fresh';
  usePublishOpenCodeProviderScopedStatus(
    listener,
    sourceProviderId,
    fresh ? (catalog.providerStatus ?? null) : null,
    catalog.status === 'loading'
  );
  return null;
};

type OpenCodeProviderScopedDialogCatalogLoadersProps = Readonly<{
  enabled: boolean;
  projectPath: string | null | undefined;
  selectedModels: readonly string[];
  localProviderIds: ReadonlySet<string>;
  passiveProviderStatus: CliProviderStatus | null | undefined;
  listener: OpenCodeProviderScopedStatusListener;
}>;

export const OpenCodeProviderScopedDialogCatalogLoaders = ({
  enabled,
  projectPath,
  selectedModels,
  localProviderIds,
  passiveProviderStatus,
  listener,
}: OpenCodeProviderScopedDialogCatalogLoadersProps): React.JSX.Element | null => {
  const sourceProviderIds = useMemo(() => {
    if (!enabled) return [];
    const sourceIds = new Set<string>();
    for (const model of selectedModels) {
      const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId;
      if (sourceId && !isOpenCodeLocalProviderId(sourceId) && !localProviderIds.has(sourceId)) {
        sourceIds.add(sourceId);
      }
    }
    return [...sourceIds].sort();
  }, [enabled, localProviderIds, selectedModels]);

  if (sourceProviderIds.length === 0) return null;
  return (
    <>
      {sourceProviderIds.map((sourceProviderId) => (
        <ScopedCatalogLoader
          key={sourceProviderId}
          projectPath={projectPath?.trim() || null}
          sourceProviderId={sourceProviderId}
          passiveProviderStatus={passiveProviderStatus}
          listener={listener}
        />
      ))}
    </>
  );
};
