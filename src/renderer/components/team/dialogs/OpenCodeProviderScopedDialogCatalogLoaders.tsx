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
  refreshRevision: number;
  listener: OpenCodeProviderScopedStatusListener;
}>;

const ScopedCatalogLoader = ({
  projectPath,
  sourceProviderId,
  passiveProviderStatus,
  refreshRevision,
  listener,
}: ScopedCatalogLoaderProps): null => {
  const catalog = useOpenCodeProviderModelCatalog({
    enabled: true,
    sourceProviderId,
    projectPath,
    passiveProviderStatus,
    refreshRevision,
  });
  const fresh = catalog.status === 'ready' && catalog.catalogState === 'fresh';
  usePublishOpenCodeProviderScopedStatus(
    listener,
    sourceProviderId,
    fresh || catalog.status === 'error' ? (catalog.providerStatus ?? null) : null,
    catalog.status === 'loading',
    refreshRevision
  );
  return null;
};

export type OpenCodeProviderScopedDialogCatalogLoaderConfiguration = Readonly<{
  enabled: boolean;
  projectPath: string | null | undefined;
  selectedModels: readonly string[];
  localProviderIds: ReadonlySet<string>;
  passiveProviderStatus: CliProviderStatus | null | undefined;
  refreshRevision: number;
  listener: OpenCodeProviderScopedStatusListener;
}>;

type OpenCodeProviderScopedDialogCatalogLoadersProps = Readonly<{
  configuration: OpenCodeProviderScopedDialogCatalogLoaderConfiguration;
}>;

export const OpenCodeProviderScopedDialogCatalogLoaders = ({
  configuration,
}: OpenCodeProviderScopedDialogCatalogLoadersProps): React.JSX.Element | null => {
  const {
    enabled,
    projectPath,
    selectedModels,
    localProviderIds,
    passiveProviderStatus,
    refreshRevision,
    listener,
  } = configuration;
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
          refreshRevision={refreshRevision}
          listener={listener}
        />
      ))}
    </>
  );
};
